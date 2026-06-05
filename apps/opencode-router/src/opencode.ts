import { Buffer } from "node:buffer";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { Config } from "./config.js";

type Client = ReturnType<typeof createOpencodeClient>;

export function createClient(config: Config, directory?: string): Client {
  const headers: Record<string, string> = {};
  if (config.opencodeUsername && config.opencodePassword) {
    const token = Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  return createOpencodeClient({
    baseUrl: config.opencodeUrl,
    directory: directory ?? config.opencodeDirectory,
    headers: Object.keys(headers).length ? headers : undefined,
    responseStyle: "data",
    throwOnError: true,
  });
}

// opencodeFetch is the raw-HTTP escape hatch for endpoints the SDK does not
// expose yet (e.g. our fork's /agent/select and /agent/model/select).
// Reuses the same baseUrl + Basic-auth headers as createClient.
//
// Throws on non-2xx with a message that includes the status code and the
// response body — callers usually want to surface that to the chat user
// directly.
export async function opencodeFetch(
  config: Config,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.opencodeUsername && config.opencodePassword) {
    const token = Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  const url = new URL(path, config.opencodeUrl).toString();
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`opencode ${method} ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export function buildPermissionRules(mode: Config["permissionMode"]) {
  if (mode === "deny") {
    return [
      {
        permission: "*",
        pattern: "*",
        action: "deny" as const,
      },
    ];
  }

  return [
    {
      permission: "*",
      pattern: "*",
      action: "allow" as const,
    },
  ];
}
