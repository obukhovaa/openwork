import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { Logger } from "pino";

import type { Config, MattermostIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type { InboundMessagePart, MediaKind, MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import type { MediaStore } from "./media-store.js";

export type InboundMessage = {
  channel: "mattermost";
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type MattermostAdapter = {
  name: "mattermost";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }): Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
  sendTyping(peerId: string): Promise<void>;
};

export type MattermostPeer = {
  channelId: string;
  rootPostId?: string;
};

// `peerId` encoding:
// - DMs:      channelId
// - Threads:  channelId|rootPostId
// Using `|` avoids clashing with ALLOW_FROM's channel:peer parsing.
export function formatMattermostPeerId(peer: MattermostPeer): string {
  if (!peer.rootPostId) return peer.channelId;
  return `${peer.channelId}|${peer.rootPostId}`;
}

export function parseMattermostPeerId(peerId: string): MattermostPeer {
  const trimmed = peerId.trim();
  if (!trimmed) return { channelId: "" };
  const [channelId, rootPostId] = trimmed.split("|");
  if (channelId && rootPostId) return { channelId, rootPostId };
  return { channelId: channelId || trimmed };
}

export function stripMattermostMention(text: string, botUsername: string | null): string {
  let next = text ?? "";
  if (botUsername) {
    const token = `@${botUsername}`;
    next = next.split(token).join(" ");
  }
  next = next.replace(/^\s*[:,-]+\s*/, "");
  return next.trim();
}

const MAX_TEXT_LENGTH = 16_383;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 20;

// --- REST Client ---

type MattermostUser = {
  id: string;
  username: string;
};

type MattermostPost = {
  id: string;
  channel_id: string;
  user_id: string;
  root_id: string;
  message: string;
  file_ids?: string[];
  props?: Record<string, unknown>;
};

type MattermostFileInfo = {
  id: string;
  name: string;
  size: number;
  mime_type: string;
};

type MattermostFileCandidate = {
  id: string;
  url: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind: MediaKind;
};

class MattermostClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(serverUrl: string, accessToken: string) {
    // Strip trailing slashes to normalize
    this.baseUrl = serverUrl.replace(/\/+$/, "");
    this.token = accessToken;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v4${path}`;
    const response = await fetch(url, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`Mattermost API ${method} ${path}: ${response.status} ${text}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json() as Promise<T>;
  }

  async getMe(): Promise<MattermostUser> {
    return this.request<MattermostUser>("GET", "/users/me");
  }

  async createPost(channelId: string, message: string, rootId?: string, fileIds?: string[]): Promise<MattermostPost> {
    return this.request<MattermostPost>("POST", "/posts", {
      channel_id: channelId,
      message,
      ...(rootId ? { root_id: rootId } : {}),
      ...(fileIds?.length ? { file_ids: fileIds } : {}),
    });
  }

  async uploadFiles(channelId: string, files: { data: Buffer; filename: string }[]): Promise<MattermostFileInfo[]> {
    const url = `${this.baseUrl}/api/v4/files`;
    const formData = new FormData();
    formData.append("channel_id", channelId);
    for (const file of files) {
      formData.append("files", new Blob([new Uint8Array(file.data)]), file.filename);
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: formData,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`Mattermost file upload: ${response.status} ${text}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const result = (await response.json()) as { file_infos?: MattermostFileInfo[] };
    return result.file_infos ?? [];
  }

  async userTyping(channelId: string, userId: string): Promise<void> {
    await this.request<unknown>("POST", `/users/${userId}/typing`, {
      channel_id: channelId,
    });
  }

  getFileUrl(fileId: string): string {
    return `${this.baseUrl}/api/v4/files/${fileId}`;
  }

  getWebSocketUrl(): string {
    const wsUrl = this.baseUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");
    return `${wsUrl}/api/v4/websocket`;
  }

  getAuthToken(): string {
    return this.token;
  }
}

// --- WebSocket Event Types ---

type MattermostWebSocketEvent = {
  event?: string;
  data?: {
    channel_display_name?: string;
    channel_name?: string;
    channel_type?: string;
    post?: string;
    sender_name?: string;
    team_id?: string;
  };
  seq?: number;
  status?: string;
};

// --- Adapter Factory ---

export function createMattermostAdapter(
  identity: MattermostIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  mediaStore?: MediaStore,
): MattermostAdapter {
  const serverUrl = identity.serverUrl?.trim() ?? "";
  const accessToken = identity.accessToken?.trim() ?? "";
  if (!serverUrl) {
    throw new Error("Mattermost server URL is required for Mattermost adapter");
  }
  if (!accessToken) {
    throw new Error("Mattermost access token is required for Mattermost adapter");
  }

  const log = logger.child({ channel: "mattermost", identityId: identity.id });
  const client = new MattermostClient(serverUrl, accessToken);

  let botUser: MattermostUser | null = null;
  let ws: WebSocket | null = null;
  let started = false;
  let stopping = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // --- File download ---

  const downloadMattermostFile = async (peerId: string, candidate: MattermostFileCandidate): Promise<InboundMessagePart> => {
    if (!mediaStore) {
      return {
        type: "media",
        media: {
          id: candidate.id,
          kind: candidate.kind,
          source: "mattermost",
          status: "failed",
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(typeof candidate.sizeBytes === "number" ? { sizeBytes: candidate.sizeBytes } : {}),
          providerFileId: candidate.id,
          providerUrl: candidate.url,
          error: "media store unavailable",
        },
      };
    }

    try {
      const stored = await withDeliveryRetry(
        "mattermost.download",
        () =>
          mediaStore.downloadInbound({
            channel: "mattermost",
            identityId: identity.id,
            peerId,
            kind: candidate.kind,
            url: candidate.url,
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            ...(candidate.filename ? { filename: candidate.filename } : {}),
            ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          }),
        { logger: log },
      );

      return {
        type: "media",
        media: {
          id: candidate.id,
          kind: candidate.kind,
          source: "mattermost",
          status: "ready",
          filePath: stored.filePath,
          filename: stored.filename,
          ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
          sizeBytes: stored.sizeBytes,
          providerFileId: candidate.id,
          providerUrl: candidate.url,
        },
      };
    } catch (error) {
      const classified = classifyDeliveryError(error);
      return {
        type: "media",
        media: {
          id: candidate.id,
          kind: candidate.kind,
          source: "mattermost",
          status: "failed",
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(typeof candidate.sizeBytes === "number" ? { sizeBytes: candidate.sizeBytes } : {}),
          providerFileId: candidate.id,
          providerUrl: candidate.url,
          error: `${classified.code}: ${classified.message}`,
        },
      };
    }
  };

  // --- WebSocket connection ---

  const connectWebSocket = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (stopping) {
        reject(new Error("Adapter is stopping"));
        return;
      }

      const wsUrl = client.getWebSocketUrl();
      log.debug({ wsUrl }, "connecting mattermost websocket");

      let resolved = false;
      const socket = new WebSocket(wsUrl);

      socket.addEventListener("open", () => {
        // Send authentication challenge
        socket.send(
          JSON.stringify({
            seq: 1,
            action: "authentication_challenge",
            data: { token: client.getAuthToken() },
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(String(event.data)) as MattermostWebSocketEvent;

          // Handle auth response
          if (!resolved && (data.status === "OK" || data.event === "hello")) {
            resolved = true;
            reconnectAttempts = 0;
            ws = socket;
            resolve();
            return;
          }

          // Handle authentication failure
          if (!resolved && data.status === "FAIL") {
            resolved = true;
            const error = new Error("Mattermost WebSocket authentication failed") as Error & { status?: number };
            error.status = 401;
            reject(error);
            socket.close();
            return;
          }

          // Handle posted events
          if (data.event === "posted") {
            void handlePostedEvent(data);
          }
        } catch (error) {
          log.warn({ error }, "failed to parse mattermost websocket message");
        }
      });

      socket.addEventListener("close", (event) => {
        log.warn({ code: event.code, reason: event.reason }, "mattermost websocket closed");
        ws = null;
        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
          return;
        }
        if (!stopping && started) {
          scheduleReconnect();
        }
      });

      socket.addEventListener("error", (event) => {
        log.warn({ error: event }, "mattermost websocket error");
        if (!resolved) {
          resolved = true;
          reject(new Error("WebSocket connection error"));
        }
      });
    });
  };

  const scheduleReconnect = () => {
    if (stopping || reconnectTimer) return;
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      log.error({ attempts: reconnectAttempts }, "mattermost max reconnect attempts reached");
      return;
    }
    const jitter = Math.floor(Math.random() * 500);
    const delayMs = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** (reconnectAttempts - 1)) + jitter;
    log.info({ attempt: reconnectAttempts, delayMs }, "mattermost scheduling reconnect");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopping) return;
      connectWebSocket().catch((error) => {
        log.error({ error }, "mattermost reconnect failed");
        if (!stopping && started) {
          scheduleReconnect();
        }
      });
    }, delayMs);
  };

  // --- Inbound message handling ---

  const handlePostedEvent = async (event: MattermostWebSocketEvent) => {
    if (!event.data?.post) return;

    let post: MattermostPost;
    try {
      post = JSON.parse(event.data.post) as MattermostPost;
    } catch {
      log.warn("failed to parse mattermost post payload");
      return;
    }

    // Skip own messages
    if (botUser && post.user_id === botUser.id) return;

    // Skip webhook and bot posts to prevent feedback loops
    if (post.props?.from_webhook === "true" || post.props?.from_bot === "true") return;

    const channelType = event.data.channel_type ?? "";
    const isDmLike = channelType === "D" || channelType === "G";
    const isChannel = channelType === "O" || channelType === "P";

    if (isDmLike) {
      // DMs and group DMs: always respond
    } else if (isChannel) {
      // Channels: require groupsEnabled + @mention.
      // Per-identity override wins over the global flag (undefined = follow global).
      const groupsEnabled = identity.groupsEnabled ?? config.groupsEnabled;
      if (!groupsEnabled) {
        log.debug({ channelType, channelId: post.channel_id }, "mattermost channel message ignored (groupsEnabled=false)");
        return;
      }
      if (!botUser?.username) return;
      if (!post.message.includes(`@${botUser.username}`)) {
        log.debug({ channelType, channelId: post.channel_id }, "mattermost channel message ignored (no @mention)");
        return;
      }
    } else {
      // Unknown channel type: ignore
      log.debug({ channelType }, "mattermost message ignored (unknown channel type)");
      return;
    }

    // Build text — strip mention for channel messages
    let text = post.message;
    if (isChannel && botUser?.username) {
      text = stripMattermostMention(text, botUser.username);
    }

    // Build peer ID: for threaded messages, use root_id; for top-level, use post id
    const rootPostId = post.root_id || post.id;
    const peerId = formatMattermostPeerId({
      channelId: post.channel_id,
      rootPostId,
    });

    // Build parts
    const parts: InboundMessagePart[] = [];
    if (text.trim()) {
      parts.push({ type: "text", text: text.trim() });
    }

    // Handle file attachments
    if (Array.isArray(post.file_ids) && post.file_ids.length > 0) {
      for (const fileId of post.file_ids) {
        const url = client.getFileUrl(fileId);
        const candidate: MattermostFileCandidate = {
          id: fileId,
          url,
          kind: "file", // Will be refined by download response
        };
        parts.push(await downloadMattermostFile(peerId, candidate));
      }
    }

    if (parts.length === 0) return;

    const textContent = parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    try {
      await onMessage({
        channel: "mattermost",
        identityId: identity.id,
        peerId,
        text: textContent,
        parts,
        raw: { event, post },
      });
    } catch (error) {
      log.error({ error, peerId }, "mattermost inbound handler failed");
    }
  };

  // --- Outbound ---

  const sendMessageInternal = async (
    peerId: string,
    message: { parts: OutboundMessagePart[] },
  ): Promise<MessageDeliveryResult> => {
    const peer = parseMattermostPeerId(peerId);
    if (!peer.channelId) {
      const error = new Error("Invalid Mattermost peerId") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const partResults: MessageDeliveryResult["partResults"] = [];
    let sentParts = 0;

    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          await withDeliveryRetry(
            "mattermost.createPost",
            () =>
              client.createPost(
                peer.channelId,
                part.text,
                peer.rootPostId,
              ),
            { logger: log },
          );
        } else {
          const fileData = await readFile(part.filePath);
          const filename = part.filename || basename(part.filePath);
          const fileInfos = await withDeliveryRetry(
            "mattermost.uploadFile",
            () =>
              client.uploadFiles(peer.channelId, [
                { data: Buffer.from(fileData), filename },
              ]),
            { logger: log },
          );
          const fileIds = fileInfos.map((fi) => fi.id);
          if (fileIds.length > 0) {
            await withDeliveryRetry(
              "mattermost.createPost",
              () =>
                client.createPost(
                  peer.channelId,
                  part.caption?.trim() || "",
                  peer.rootPostId,
                  fileIds,
                ),
              { logger: log },
            );
          }
        }

        sentParts += 1;
        partResults.push({ index, type: part.type, sent: true });
      } catch (error) {
        const classified = classifyDeliveryError(error);
        partResults.push({
          index,
          type: part.type,
          sent: false,
          error: classified.message,
          code: classified.code,
          retryable: classified.retryable,
        });
      }
    }

    return {
      attemptedParts: message.parts.length,
      sentParts,
      partResults,
    };
  };

  // --- Lifecycle ---

  return {
    name: "mattermost",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      if (started) return;
      log.debug("mattermost adapter starting");
      botUser = await client.getMe();
      log.debug({ botUserId: botUser.id, botUsername: botUser.username }, "mattermost bot user resolved");
      await connectWebSocket();
      started = true;
      log.info({ botUserId: botUser.id, botUsername: botUser.username }, "mattermost adapter started");
    },
    async stop() {
      if (!started) return;
      stopping = true;
      started = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch (error) {
          log.warn({ error }, "mattermost adapter stop failed");
        }
        ws = null;
      }
      log.info("mattermost adapter stopped");
      stopping = false;
    },
    async sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }) {
      return sendMessageInternal(peerId, message);
    },
    async sendText(peerId: string, text: string) {
      const result = await sendMessageInternal(peerId, {
        parts: [{ type: "text", text }],
      });
      if (result.sentParts === 0) {
        const firstError = result.partResults.find((part) => !part.sent)?.error;
        throw new Error(firstError || "Failed to deliver Mattermost text message");
      }
    },
    async sendTyping(peerId: string) {
      if (!botUser) return;
      const peer = parseMattermostPeerId(peerId);
      if (!peer.channelId) return;
      try {
        await client.userTyping(peer.channelId, botUser.id);
      } catch (error) {
        log.debug({ error }, "mattermost typing indicator failed");
      }
    },
  };
}
