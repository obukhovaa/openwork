import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(moduleDir, "..");
dotenv.config({ path: path.join(packageDir, ".env") });
dotenv.config();

export type ChannelName = "telegram" | "slack" | "mattermost";

export type TelegramIdentity = {
  id: string;
  token: string;
  enabled?: boolean;
  // Optional default workspace directory to route peers into.
  // When set, opencodeRouter will auto-bind new peerIds to this directory.
  directory?: string;
  // Optional access mode. Private mode requires `/pair <code>` before first use.
  access?: "public" | "private";
  // sha256 hash (hex) of normalized pairing code for private mode.
  pairingCodeHash?: string;
  // Per-identity override of the global groupsEnabled flag. Omitted = follow global.
  groupsEnabled?: boolean;
};

export type SlackIdentity = {
  id: string;
  botToken: string;
  appToken: string;
  enabled?: boolean;
  directory?: string;
};

export type MattermostIdentity = {
  id: string;
  serverUrl: string;
  accessToken: string;
  enabled?: boolean;
  directory?: string;
  // Per-identity override of the global groupsEnabled flag. Omitted = follow global.
  groupsEnabled?: boolean;
};

export type OpenCodeRouterConfigFile = {
  version: number;
  opencodeUrl?: string;
  opencodeDirectory?: string;
  groupsEnabled?: boolean;
  toolUpdatesEnabled?: boolean;
  permissionMode?: "allow" | "deny";
  questionMode?: "interactive" | "auto-reject" | "disabled";
  channels?: {
    telegram?: {
      enabled?: boolean;
      // New format (multi-bot)
      bots?: TelegramIdentity[];
      // Legacy (single)
      token?: string;
    };
    slack?: {
      enabled?: boolean;
      // New format (multi-app)
      apps?: SlackIdentity[];
      // Legacy (single)
      botToken?: string;
      appToken?: string;
    };
    mattermost?: {
      enabled?: boolean;
      instances?: MattermostIdentity[];
    };
  };
};

export type ModelRef = {
  providerID: string;
  modelID: string;
};

export type Config = {
  configPath: string;
  configFile: OpenCodeRouterConfigFile;
  opencodeUrl: string;
  opencodeDirectory: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  model?: ModelRef;
  telegramBots: TelegramIdentity[];
  slackApps: SlackIdentity[];
  mattermostInstances: MattermostIdentity[];
  dataDir: string;
  dbPath: string;
  logFile: string;
  toolUpdatesEnabled: boolean;
  groupsEnabled: boolean;
  permissionMode: "allow" | "deny";
  questionMode: "interactive" | "auto-reject" | "disabled";
  questionTimeoutMs: number;
  toolOutputLimit: number;
  healthPort?: number;
  logLevel: string;
};

type EnvLike = NodeJS.ProcessEnv;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseModel(value: string | undefined): ModelRef | undefined {
  if (!value?.trim()) return undefined;
  const parts = value.trim().split("/");
  if (parts.length < 2) return undefined;
  const providerID = parts[0];
  const modelID = parts.slice(1).join("/");
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

function expandHome(value: string): string {
  if (!value.startsWith("~/")) return value;
  return path.join(os.homedir(), value.slice(2));
}

function resolveConfigPath(dataDir: string, env: EnvLike): string {
  const override = env.OPENCODE_ROUTER_CONFIG_PATH?.trim();
  if (override) return expandHome(override);
  return path.join(dataDir, "opencode-router.json");
}

export function readConfigFile(configPath: string): { exists: boolean; config: OpenCodeRouterConfigFile } {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as OpenCodeRouterConfigFile;
    return { exists: true, config: parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, config: { version: 1 } };
    }
    throw error;
  }
}

export function writeConfigFile(configPath: string, config: OpenCodeRouterConfigFile) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function normalizeId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const safe = trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return safe.replace(/^-+|-+$/g, "").slice(0, 48) || "default";
}

const PAIRING_CODE_HASH_PATTERN = /^[a-f0-9]{64}$/;

function normalizeTelegramAccess(value: unknown): "public" | "private" {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "private" ? "private" : "public";
}

function normalizePairingCodeHash(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!PAIRING_CODE_HASH_PATTERN.test(raw)) return "";
  return raw;
}

function coerceTelegramBots(file: OpenCodeRouterConfigFile): TelegramIdentity[] {
  const telegram = file.channels?.telegram;
  const bots = Array.isArray((telegram as any)?.bots) ? ((telegram as any).bots as unknown[]) : [];
  const normalized: TelegramIdentity[] = [];
  for (const entry of bots) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const token = typeof record.token === "string" ? record.token.trim() : "";
    if (!token) continue;
    const id = normalizeId(typeof record.id === "string" ? record.id : "default");
    const directory = typeof record.directory === "string" ? record.directory.trim() : "";
    const access = normalizeTelegramAccess(record.access);
    const pairingCodeHash = normalizePairingCodeHash(record.pairingCodeHash);
    const groupsOverride = typeof record.groupsEnabled === "boolean" ? record.groupsEnabled : undefined;
    normalized.push({
      id,
      token,
      enabled: record.enabled === undefined ? true : record.enabled === true,
      ...(directory ? { directory } : {}),
      ...(access === "private" ? { access, ...(pairingCodeHash ? { pairingCodeHash } : {}) } : { access: "public" }),
      ...(groupsOverride !== undefined ? { groupsEnabled: groupsOverride } : {}),
    });
  }
  if (normalized.length) return normalized;

  // Legacy single-bot migration (in-memory).
  const legacyToken = typeof (telegram as any)?.token === "string" ? String((telegram as any).token).trim() : "";
  if (legacyToken) {
    return [{ id: "default", token: legacyToken, enabled: true }];
  }
  return [];
}

function coerceSlackApps(file: OpenCodeRouterConfigFile): SlackIdentity[] {
  const slack = file.channels?.slack;
  const apps = Array.isArray((slack as any)?.apps) ? ((slack as any).apps as unknown[]) : [];
  const normalized: SlackIdentity[] = [];
  for (const entry of apps) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const botToken = typeof record.botToken === "string" ? record.botToken.trim() : "";
    const appToken = typeof record.appToken === "string" ? record.appToken.trim() : "";
    if (!botToken || !appToken) continue;
    const id = normalizeId(typeof record.id === "string" ? record.id : "default");
    const directory = typeof record.directory === "string" ? record.directory.trim() : "";
    normalized.push({
      id,
      botToken,
      appToken,
      enabled: record.enabled === undefined ? true : record.enabled === true,
      ...(directory ? { directory } : {}),
    });
  }
  if (normalized.length) return normalized;

  // Legacy single-app migration (in-memory).
  const legacyBot = typeof (slack as any)?.botToken === "string" ? String((slack as any).botToken).trim() : "";
  const legacyApp = typeof (slack as any)?.appToken === "string" ? String((slack as any).appToken).trim() : "";
  if (legacyBot && legacyApp) {
    return [{ id: "default", botToken: legacyBot, appToken: legacyApp, enabled: true }];
  }
  return [];
}

function coerceMattermostInstances(file: OpenCodeRouterConfigFile): MattermostIdentity[] {
  const mattermost = file.channels?.mattermost;
  const instances = Array.isArray((mattermost as any)?.instances) ? ((mattermost as any).instances as unknown[]) : [];
  const normalized: MattermostIdentity[] = [];
  for (const entry of instances) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const serverUrl = typeof record.serverUrl === "string" ? record.serverUrl.trim() : "";
    const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
    if (!serverUrl || !accessToken) continue;
    const id = normalizeId(typeof record.id === "string" ? record.id : "default");
    const directory = typeof record.directory === "string" ? record.directory.trim() : "";
    const groupsOverride = typeof record.groupsEnabled === "boolean" ? record.groupsEnabled : undefined;
    normalized.push({
      id,
      serverUrl,
      accessToken,
      enabled: record.enabled === undefined ? true : record.enabled === true,
      ...(directory ? { directory } : {}),
      ...(groupsOverride !== undefined ? { groupsEnabled: groupsOverride } : {}),
    });
  }
  return normalized;
}

export function loadConfig(
  env: EnvLike = process.env,
  options: { requireOpencode?: boolean } = {},
): Config {
  const requireOpencode = options.requireOpencode ?? false;

  const defaultDataDir = path.join(os.homedir(), ".openwork", "opencode-router");
  const dataDir = expandHome(env.OPENCODE_ROUTER_DATA_DIR ?? defaultDataDir);
  const dbPath = expandHome(env.OPENCODE_ROUTER_DB_PATH ?? path.join(dataDir, "opencode-router.db"));
  const logFile = expandHome(env.OPENCODE_ROUTER_LOG_FILE ?? path.join(dataDir, "logs", "opencode-router.log"));
  const configPath = resolveConfigPath(dataDir, env);
  let { config: configFile } = readConfigFile(configPath);
  const opencodeDirectory = env.OPENCODE_DIRECTORY?.trim() || configFile.opencodeDirectory || "";
  if (!opencodeDirectory && requireOpencode) {
    throw new Error("OPENCODE_DIRECTORY is required");
  }
  const resolvedDirectory = opencodeDirectory || process.cwd();

  const toolOutputLimit = parseInteger(env.TOOL_OUTPUT_LIMIT) ?? 1200;
  const permissionModeDefault = (configFile as any).permissionMode === "deny" ? "deny" : "allow";
  const permissionMode = env.PERMISSION_MODE?.toLowerCase() === "deny" ? "deny" : env.PERMISSION_MODE ? "allow" : permissionModeDefault;
  const questionModeRaw = (env.QUESTION_MODE?.trim().toLowerCase() || configFile.questionMode || "interactive") as string;
  const questionMode: Config["questionMode"] =
    questionModeRaw === "auto-reject" ? "auto-reject" :
    questionModeRaw === "disabled" ? "disabled" : "interactive";
  const questionTimeoutMs = parseInteger(env.QUESTION_TIMEOUT_MS) ?? 5 * 60 * 1000;

  // Identities are loaded from config. Env vars are still supported as a convenience
  // for single-identity setups.
  const telegramBots = coerceTelegramBots(configFile);
  const slackApps = coerceSlackApps(configFile);
  const mattermostInstances = coerceMattermostInstances(configFile);

  const envTelegram = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (envTelegram && !telegramBots.some((bot) => bot.token === envTelegram)) {
    telegramBots.unshift({ id: "env", token: envTelegram, enabled: true });
  }
  const envSlackBot = env.SLACK_BOT_TOKEN?.trim() ?? "";
  const envSlackApp = env.SLACK_APP_TOKEN?.trim() ?? "";
  if (envSlackBot && envSlackApp && !slackApps.some((app) => app.botToken === envSlackBot && app.appToken === envSlackApp)) {
    slackApps.unshift({ id: "env", botToken: envSlackBot, appToken: envSlackApp, enabled: true });
  }
  const envMmServer = env.MATTERMOST_SERVER_URL?.trim() ?? "";
  const envMmToken = env.MATTERMOST_ACCESS_TOKEN?.trim() ?? "";
  if (envMmServer && envMmToken && !mattermostInstances.some((inst) => inst.serverUrl === envMmServer && inst.accessToken === envMmToken)) {
    mattermostInstances.unshift({ id: "env", serverUrl: envMmServer, accessToken: envMmToken, enabled: true });
  }
  const healthPort =
    parseInteger(env.OPENCODE_ROUTER_HEALTH_PORT) ??
    // Convenience alias (common on PaaS / local experiments)
    parseInteger(env.PORT) ??
    3005;
  const model = parseModel(env.OPENCODE_ROUTER_MODEL);

  const telegramEnabledDefault = configFile.channels?.telegram?.enabled ?? true;
  const slackEnabledDefault = configFile.channels?.slack?.enabled ?? true;
  const mattermostEnabledDefault = configFile.channels?.mattermost?.enabled ?? true;

  return {
    configPath,
    configFile,
    opencodeUrl: env.OPENCODE_URL?.trim() || configFile.opencodeUrl || "http://127.0.0.1:4096",
    opencodeDirectory: resolvedDirectory,
    opencodeUsername: env.OPENCODE_SERVER_USERNAME?.trim() || undefined,
    opencodePassword: env.OPENCODE_SERVER_PASSWORD?.trim() || undefined,
    model,
    telegramBots: telegramBots.map((bot) => ({ ...bot, enabled: bot.enabled !== false && parseBoolean(env.TELEGRAM_ENABLED, telegramEnabledDefault) })),
    slackApps: slackApps.map((app) => ({
      ...app,
      enabled: app.enabled !== false && parseBoolean(env.SLACK_ENABLED, slackEnabledDefault),
    })),
    mattermostInstances: mattermostInstances.map((inst) => ({
      ...inst,
      enabled: inst.enabled !== false && parseBoolean(env.MATTERMOST_ENABLED, mattermostEnabledDefault),
    })),
    dataDir,
    dbPath,
    logFile,
    toolUpdatesEnabled: parseBoolean(env.TOOL_UPDATES_ENABLED, configFile.toolUpdatesEnabled ?? false),
    groupsEnabled: parseBoolean(env.GROUPS_ENABLED, configFile.groupsEnabled ?? false),
    permissionMode,
    questionMode,
    questionTimeoutMs,
    toolOutputLimit,
    healthPort,
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}
