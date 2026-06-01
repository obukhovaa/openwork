# Mattermost Channel Support for opencode-router

**Date**: 2026-05-27
**Status**: Implemented
**Author**: AI-assisted

## Overview

Add Mattermost as a third messaging channel in `opencode-router`, alongside Telegram and Slack. This lets teams running self-hosted Mattermost instances bridge their chat directly to a running opencode server — receiving prompts, dispatching replies, and delivering media — with no external service dependency.

## Motivation

### Current State

The router supports two channels. The discriminator type lives in `config.ts:13`:

```typescript
export type ChannelName = "telegram" | "slack";
```

Each channel has its own identity type, adapter factory, CLI subcommands, health endpoints, and UI settings section. The architecture is clean — the bridge (`bridge.ts`) consumes a generic `Adapter` interface and routes by `(channel, identityId, peerId)` — but adding a new channel still requires threading changes through ~12 files.

### Problems

1. **No self-hosted option**: Both Telegram and Slack are third-party SaaS platforms. Teams behind restrictive firewalls, in air-gapped environments, or with data-residency requirements cannot use either.
2. **Mattermost is the most-requested missing channel**: Mattermost is the dominant open-source Slack alternative, widely deployed in enterprises, government, and defence. Its bot API is simpler than Slack's (single token, standard WebSocket, no proprietary SDK).
3. **The adapter pattern exists but is implicit**: There is no formal `ChannelAdapter` interface — each adapter happens to expose the same shape. Adding a third channel is a good forcing function to confirm the contract holds.

### Desired State

```typescript
export type ChannelName = "telegram" | "slack" | "mattermost";
```

A user runs:

```bash
opencode-router mattermost add https://mm.example.com <personal-access-token> --id default
opencode-router start
```

Messages in Mattermost DMs and @mentions in channels flow through to opencode. Replies, media, and tool updates flow back. The desktop app's Messaging settings page shows a Mattermost section alongside Telegram and Slack.

## Research Findings

### Mattermost Bot API Surface

Mattermost exposes three integration layers relevant to a bot adapter:

| Layer | Mechanism | Use Case |
|-------|-----------|----------|
| REST API v4 | `https://<server>/api/v4/*` | Send posts, upload files, manage channels, get user info |
| WebSocket | `wss://<server>/api/v4/websocket` | Real-time event stream (new messages, reactions, typing) |
| Webhooks | Incoming/outgoing HTTP hooks | Simpler integrations; not suitable here (no bidirectional real-time) |

**Key finding**: The WebSocket + REST combination is the correct approach. It mirrors the Slack Socket Mode pattern already in use, but is simpler — Mattermost's WebSocket is a standard RFC 6455 connection authenticated by sending `{"seq": 1, "action": "authentication_challenge", "data": {"token": "<token>"}}` on connect. Bun has built-in WebSocket support, so no npm dependency is needed.

### Mattermost vs Slack API Mapping

| Concept | Slack (current impl) | Mattermost |
|---------|---------------------|------------|
| Auth tokens | 2 tokens: `xoxb-` (bot) + `xapp-` (app/socket) | 1 token: personal access token |
| Real-time connection | `@slack/socket-mode` npm package | Native WebSocket (`wss://server/api/v4/websocket`) |
| Send message | `web.chat.postMessage({channel, text, thread_ts})` | `POST /api/v4/posts` with `{channel_id, message, root_id}` |
| Thread reply | `thread_ts` field | `root_id` field on Post object |
| File upload | `web.files.uploadV2({channel_id, file, filename})` | `POST /api/v4/files` (multipart), then attach `file_ids` to post |
| @mention detection | `<@BOT_USER_ID>` token in text | `@botusername` plain text |
| DM detection | Channel ID starts with `D` | Channel type field = `"D"` (requires GET channel or cache) |
| Max post length | ~40,000 chars | 16,383 chars (server default, configurable) |
| Typing indicator | N/A in current impl | `POST /api/v4/users/{user_id}/typing` |
| Reactions | Not implemented | `POST /api/v4/reactions` with `{user_id, post_id, emoji_name}` |

**Key finding**: Mattermost is strictly simpler than Slack for bot integration. One token instead of two. Standard WebSocket instead of a proprietary socket-mode protocol. No npm dependency needed.

**Implication**: The adapter will be shorter and have fewer failure modes than the Slack adapter. The main complexity is WebSocket lifecycle management (reconnection, heartbeat).

### Mattermost WebSocket Event Model

The `posted` event is the primary inbound trigger. Its `data` payload contains:

```json
{
  "event": "posted",
  "data": {
    "channel_display_name": "Town Square",
    "channel_name": "town-square",
    "channel_type": "O",
    "post": "{\"id\":\"...\",\"channel_id\":\"...\",\"message\":\"hello\",\"root_id\":\"...\",\"user_id\":\"...\",\"file_ids\":[...]}",
    "sender_name": "@username",
    "team_id": "..."
  }
}
```

Note: the `post` field is a JSON string inside the JSON event — it requires double-parsing.

Channel types: `"O"` = open/public, `"P"` = private, `"D"` = direct message (1:1), `"G"` = group message (multi-party DM).

Important: `"G"` (group message) behaves more like a DM than a channel — there are no @mentions, and the bot receives all messages. The adapter should treat `"D"` and `"G"` identically (always respond), and only gate `"O"`/`"P"` behind `groupsEnabled` + @mention checks.

Additionally, posts from webhooks and other integrations may carry `props.from_webhook === "true"` or `props.from_bot === "true"`. The adapter must check these fields to avoid feedback loops with other integrations posting to the same channel.

### Dependency Analysis

| Approach | Pros | Cons |
|----------|------|------|
| **No dependency (raw fetch + Bun WebSocket)** | Zero added deps, full control, smaller bundle | Must implement reconnection, auth, multipart upload manually |
| **`@mattermost/client` npm package** | Official, typed `Client4` class | Designed for browsers, may need polyfills; WebSocket client is separate; adds a dependency |

**Key finding**: The official `@mattermost/client` npm package provides a `Client4` HTTP client that wraps the REST API. However, its WebSocket handling is designed for the Mattermost web app, not standalone bots. The Go driver is more bot-friendly, but this project is TypeScript.

**Recommendation**: Use raw `fetch` + Bun's native `WebSocket`. The REST endpoints are simple enough that a thin wrapper (similar to how the Telegram adapter uses `grammy`'s `bot.api.*`) is overkill. This avoids adding a dependency and keeps the adapter self-contained.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| HTTP client | Raw `fetch` (no npm dep) | Mattermost REST API is simple CRUD; `fetch` is built into Bun; avoids dependency for ~5 endpoints |
| WebSocket client | Bun native `WebSocket` | Built-in, no polyfill needed; we only need `posted` events + auth handshake |
| Reconnection strategy | Exponential backoff with jitter (reuse `delivery.ts` pattern) | Matches existing retry infrastructure; Mattermost WebSocket can drop on server restart |
| PeerId encoding | `channelId` for DMs, `channelId\|rootPostId` for threads | Mirrors the Slack `channelId\|threadTs` convention in `slack.ts:49-52` |
| DM detection | Cache channel type from `posted` event's `channel_type` field | Avoids an extra REST call per message; `channel_type` is present in every WebSocket event |
| Group/channel message handling | `"D"`/`"G"` types: always respond (DM-like). `"O"`/`"P"` types: respond only to @mentions, strip mention from text | `"G"` is multi-party DM, not a channel; `config.groupsEnabled` gate applies only to `"O"`/`"P"` |
| Webhook/bot filtering | Skip posts with `props.from_webhook === "true"` or `props.from_bot === "true"` | Prevents feedback loops with other integrations; complements the `user_id === self.id` check |
| Max text length | 16,383 chars (Mattermost default `MaxPostSize`) | Conservative default; could read from server config but not worth the complexity |
| Identity config shape | `{ id, serverUrl, accessToken, enabled?, directory? }` | Minimal — serverUrl + token is all Mattermost needs; no second token like Slack |
| File upload | Two-step: `POST /files` then reference `file_ids` in post | This is how Mattermost works; cannot inline files in post body |
| Typing indicator | Implement `sendTyping` on the adapter | Mattermost supports it; improves UX; low effort |

## Architecture

### Adapter Structure

```
┌─────────────────────────────────────────────────────────┐
│  mattermost.ts  (new file, ~350-400 LOC)                │
│                                                         │
│  createMattermostAdapter(identity, config, logger,       │
│                          onMessage, mediaStore)          │
│    │                                                    │
│    ├── MattermostClient (thin REST wrapper)              │
│    │     ├── createPost(channelId, message, rootId?)     │
│    │     ├── uploadFiles(channelId, files[])             │
│    │     ├── getMe() -> {id, username}                   │
│    │     └── userTyping(channelId)                       │
│    │                                                    │
│    └── WebSocket listener                               │
│          ├── connect + auth handshake                    │
│          ├── listen for "posted" events                  │
│          ├── filter: ignore own posts, webhook posts,     │
│          │   bot-originated posts (props.from_*)         │
│          ├── filter: DMs ("D"/"G") always, channels      │
│          │   ("O"/"P") only if @mentioned + groupsEnabled│
│          ├── download file attachments via mediaStore    │
│          └── call onMessage(InboundMessage)              │
│                                                         │
│  Returns: MattermostAdapter                              │
│    { name, identityId, maxTextLength,                    │
│      start, stop, sendMessage, sendText, sendTyping }    │
└─────────────────────────────────────────────────────────┘
         │
         │ same Adapter interface as telegram.ts / slack.ts
         ▼
┌─────────────────────────────────────────────────────────┐
│  bridge.ts                                              │
│    adapters.set("mattermost:<id>", adapter)             │
│    handleInbound → route to opencode session            │
│    deliverParts → adapter.sendMessage(peerId, parts)    │
└─────────────────────────────────────────────────────────┘
```

### WebSocket Lifecycle

```
STEP 1: Connect
────────────────────
Open WebSocket to wss://<serverUrl>/api/v4/websocket
Send auth challenge: {"seq":1, "action":"authentication_challenge", "data":{"token":"<accessToken>"}}
Wait for {"status":"OK"} response or {"event":"hello"}

STEP 2: Listen
────────────────────
Receive events on the socket.
For "posted" events:
  - Double-parse: event.data.post is a JSON string
  - Extract channel_type, user_id, message, root_id, file_ids, props
  - Skip if user_id === self.id (own messages)
  - Skip if props.from_webhook === "true" or props.from_bot === "true"
  - If channel_type is "D" or "G": always process (DM / group DM)
  - If channel_type is "O" or "P": skip if groupsEnabled is false
  - If channel_type is "O" or "P": skip if @botusername not in message
  - Strip @mention (for "O"/"P" only), build InboundMessage, call onMessage()

STEP 3: Reconnect on failure
────────────────────
On WebSocket close/error:
  - Log warning
  - Wait with exponential backoff (1s → 2s → 4s → ... capped at 30s) + jitter
  - Re-establish connection (back to Step 1)
  - Cap reconnect attempts; after N failures, mark adapter as unhealthy
```

### Config File Shape

The `opencode-router.json` config gains a `mattermost` section:

```json
{
  "version": 1,
  "channels": {
    "telegram": { "enabled": true, "bots": [...] },
    "slack": { "enabled": true, "apps": [...] },
    "mattermost": {
      "enabled": true,
      "instances": [
        {
          "id": "default",
          "serverUrl": "https://mm.example.com",
          "accessToken": "...",
          "enabled": true,
          "directory": "/path/to/workspace"
        }
      ]
    }
  }
}
```

### Files Changed

```
apps/opencode-router/
├── src/
│   ├── mattermost.ts          NEW   ~350-400 LOC  (adapter)
│   ├── config.ts              EDIT  add MattermostIdentity type, ChannelName union, coerceMattermostInstances()
│   ├── bridge.ts              EDIT  register mattermost adapters, add CHANNEL_LABELS entry,
│   │                                 resolveIdentityDirectory, listIdentityConfigs,
│   │                                 health handler wiring (list/upsert/delete),
│   │                                 getStatus() snapshot builder (add mattermost to channels)
│   ├── health.ts              EDIT  add MattermostIdentityItem, health endpoint routes,
│   │                                 HealthSnapshot.channels.mattermost,
│   │                                 HealthHandlers for mattermost CRUD
│   ├── media.ts               EDIT  add "mattermost" to InboundMediaAttachment.source union
│   ├── cli.ts                 EDIT  add `mattermost` command group (add/list/remove),
│   │                                 update `send` command channel validation,
│   │                                 update console reporter formatChannel
│   └── delivery.ts            EDIT  (optional) add mattermost-specific error patterns
├── test/
│   └── mattermost.test.js     NEW   ~200 LOC  (unit tests)
├── package.json               EDIT  add keywords entry; no new dependencies
└── README.md                  EDIT  add Mattermost section

apps/app/src/
├── app/lib/openwork-server.ts            EDIT  add mattermost API client methods
│                                               (getOpenCodeRouterMattermostIdentities,
│                                                upsertOpenCodeRouterMattermostIdentity,
│                                                deleteOpenCodeRouterMattermostIdentity)
├── react-app/domains/settings/
│   ├── pages/messaging-view.tsx          EDIT  add MessagingChannel "mattermost", UI section
│   └── state/messaging-view-state.ts     EDIT  add mattermost state/handlers
├── i18n/locales/en.ts                    EDIT  add mattermost i18n keys
└── (other locale files)                  EDIT  add mattermost i18n keys
```

## Implementation Plan

### Phase 1: Core Adapter (`mattermost.ts`)

- [x] **1.1** Create `src/mattermost.ts` with `MattermostAdapter` type matching the shape in `bridge.ts:23-34`
- [x] **1.2** Implement thin REST client class wrapping `fetch`:
  - `getMe()` — `GET /api/v4/users/me` — to resolve bot user ID and username on start
  - `createPost(channelId, message, rootId?, fileIds?)` — `POST /api/v4/posts`
  - `uploadFiles(channelId, files: {data: Buffer, filename: string}[])` — `POST /api/v4/files` (multipart/form-data)
  - `userTyping(channelId)` — `POST /api/v4/users/{userId}/typing`
- [x] **1.3** Implement WebSocket connection with auth handshake
- [x] **1.4** Implement reconnection with exponential backoff + jitter (reuse `withDeliveryRetry` pattern or a dedicated reconnect loop)
- [x] **1.5** Implement inbound message handler:
  - Parse `posted` events (double-parse the `post` JSON string)
  - Filter own messages using bot user ID from `getMe()`
  - Filter webhook/integration posts: skip if `post.props.from_webhook === "true"` or `post.props.from_bot === "true"` to prevent feedback loops
  - Classify channel type: `"D"`/`"G"` are DM-like (always respond), `"O"`/`"P"` are channels (require `groupsEnabled` + @mention)
  - For `"O"`/`"P"` channels: check `groupsEnabled`, check @mention presence, strip @mention from text
  - Download file attachments via `mediaStore` (files referenced by `file_ids` in post; download URL is `GET /api/v4/files/{file_id}`)
  - Build `InboundMessage` and call `onMessage`
- [x] **1.6** Implement outbound:
  - `sendMessage(peerId, {parts})` — iterate parts, send text via `createPost`, upload files via `uploadFiles` then attach to post
  - `sendText(peerId, text)` — convenience wrapper
  - `sendTyping(peerId)` — call `userTyping`
  - Use `chunkText` from `text.ts` with `MAX_TEXT_LENGTH = 16_383`
- [x] **1.7** Implement `start()` and `stop()` lifecycle:
  - `start()`: call `getMe()`, connect WebSocket, begin listening
  - `stop()`: close WebSocket, clear reconnection timers
- [x] **1.8** Export `createMattermostAdapter` factory function, `MattermostAdapter` type, and peer ID helpers (`formatMattermostPeerId`, `parseMattermostPeerId`)

### Phase 2: Config & Bridge Wiring

- [x] **2.1** Update `config.ts`:
  - Add `"mattermost"` to `ChannelName` union
  - Add `MattermostIdentity` type: `{ id, serverUrl, accessToken, enabled?, directory? }`
  - Add `mattermost` section to `OpenCodeRouterConfigFile.channels`
  - Add `coerceMattermostInstances()` function (follow `coerceSlackApps` pattern)
  - Add `mattermostInstances` array to `Config` type
  - Wire env var fallback: `MATTERMOST_SERVER_URL`, `MATTERMOST_ACCESS_TOKEN`, `MATTERMOST_ENABLED`
- [x] **2.2** Update `bridge.ts`:
  - Import `createMattermostAdapter`
  - Add `"mattermost": "Mattermost"` to `CHANNEL_LABELS`
  - Add mattermost adapter creation loop alongside Telegram/Slack in `startBridge`
  - Update `resolveIdentityDirectory` to handle `"mattermost"` channel
  - Update `listIdentityConfigs` to handle `"mattermost"` channel
  - Update the `getStatus()` snapshot builder (~line 740) to add `mattermost: Array.from(adapters.keys()).some((key) => key.startsWith("mattermost:"))` to the `channels` object. Note: the existing `whatsapp: false` field is a backward-compatibility stub for a removed channel — leave it as-is, add `mattermost` alongside it
  - Wire health handlers: `listMattermostIdentities`, `upsertMattermostIdentity`, `deleteMattermostIdentity` (follow the exact pattern of `upsertSlackIdentity` at `bridge.ts:1064-1172`)
  - Update channel validation guards (search for `!== "telegram" && !== "slack"` patterns, e.g. lines 1227, 1247, 1272, 1294)
- [x] **2.3** Update `media.ts`:
  - Add `"mattermost"` to `InboundMediaAttachment.source` union type
- [x] **2.4** Update `health.ts`:
  - Add `mattermost: boolean` to `HealthSnapshot.channels` (note: the existing type already includes a `whatsapp: boolean` backward-compatibility stub hardcoded to `false` — leave it, add `mattermost` alongside it)
  - Add `MattermostIdentityItem` type (follow `SlackIdentityItem`)
  - Add `MattermostIdentitiesResult` type
  - Add `MattermostIdentityUpsertInput` type: `{ id?, serverUrl, accessToken, enabled?, directory? }`
  - Add health handler types to `HealthHandlers`: `listMattermostIdentities`, `upsertMattermostIdentity`, `deleteMattermostIdentity`
  - Add HTTP route handlers: `GET /identities/mattermost`, `POST /identities/mattermost`, `DELETE /identities/mattermost/:id`
  - No legacy alias needed (unlike `/config/telegram-token` and `/config/slack-tokens` which exist for backward compatibility with older clients — Mattermost has no legacy clients)

### Phase 3: CLI

- [x] **3.1** Update `cli.ts`:
  - Add `mattermost` command group with `list`, `add`, `remove` subcommands
  - `add` takes `<serverUrl> <accessToken>` positional args + `--id` option
  - `list` reads from config file and prints identity table
  - `remove` deletes by identity ID
  - Update `formatChannel` in `createConsoleReporter` to handle `"mattermost"`
  - Update `send` command to accept `--channel mattermost`
  - Update any hardcoded channel validation to include `"mattermost"`

### Phase 4: Tests

- [x] **4.1** Create `test/mattermost.test.js`:
  - Test adapter creation with valid/invalid config
  - Test inbound message parsing (mock WebSocket events)
  - Test outbound message delivery (mock fetch)
  - Test peer ID encoding/decoding
  - Test @mention stripping
  - Test DM ("D") vs group DM ("G") vs channel ("O"/"P") filtering
  - Test webhook/bot post filtering (`props.from_webhook`, `props.from_bot`)
  - Test reconnection behavior
  - Test file attachment download flow

### Phase 5: Desktop App UI

- [x] **5.1** Update `apps/app/src/app/lib/openwork-server.ts`:
  - Add API client methods: `getOpenCodeRouterMattermostIdentities(workspaceId)`, `upsertOpenCodeRouterMattermostIdentity(workspaceId, input)`, `deleteOpenCodeRouterMattermostIdentity(workspaceId, identityId)` — follow the existing Telegram/Slack method patterns
  - The response types (`OpenworkOpenCodeRouterHealthSnapshot`, `OpenworkOpenCodeRouterIdentityItem`) already use `Record<string, unknown>` so no type changes are needed
- [x] **5.2** Update `messaging-view.tsx`:
  - Add `"mattermost"` to `MessagingChannel` type
  - Add Mattermost section in the channel list (Server URL + Access Token fields, enable/disable toggle)
- [x] **5.3** Update `messaging-view-state.ts`:
  - Add mattermost state variables (identities, serverUrl, accessToken, enabled, saving, status, error)
  - Add upsert/delete callbacks following the Slack pattern
  - Wire into `refreshAll` to fetch mattermost identities
- [x] **5.4** Add i18n strings to `en.ts` and propagate to other locales

### Phase 6: Documentation & Polish

- [x] **6.1** Update `README.md` with Mattermost setup section
- [x] **6.2** Update `package.json` keywords to include `"mattermost"`
- [x] **6.3** Add `MATTERMOST_SERVER_URL`, `MATTERMOST_ACCESS_TOKEN`, `MATTERMOST_ENABLED` to `.env.example`

## Edge Cases

### WebSocket Disconnection During Active Session

1. User sends a message in Mattermost while the bot is processing a previous request.
2. The WebSocket connection drops (server restart, network blip).
3. The adapter's reconnect loop kicks in, re-establishes the connection.
4. Messages sent during the disconnect window are lost (Mattermost WebSocket does not replay missed events).
5. The opencode session continues; the next user message re-engages normally.
6. **Mitigation**: On reconnect, the adapter could optionally call `GET /api/v4/channels/{id}/posts?since={last_event_timestamp}` to catch up. This is an enhancement, not required for v1.

### Self-hosted Server With Non-standard Base Path

1. Some Mattermost deployments sit behind a reverse proxy at a subpath (e.g., `https://example.com/mattermost/`).
2. The `serverUrl` config must include the full base path.
3. The adapter must use `serverUrl` as-is for both REST and WebSocket URLs, stripping only trailing slashes.
4. WebSocket URL derivation: replace `https://` with `wss://` (or `http://` with `ws://`), append `/api/v4/websocket`.

### Token Rotation

1. Admin rotates the bot's personal access token in Mattermost.
2. The WebSocket connection fails auth on next reconnect.
3. The adapter logs the auth failure and stops reconnecting after max retries.
4. User must update the token via `opencode-router mattermost add` or the UI.
5. The health endpoint shows `mattermost: false` so the UI can surface the issue.

### Large File Uploads

1. User asks the bot to send a file larger than the Mattermost server's `MaxFileSize` (default 50MB).
2. The `POST /api/v4/files` call returns 413 or a Mattermost-specific error.
3. `classifyDeliveryError` maps this to `"payload_too_large"`, marks it non-retryable.
4. The `partResults` array reports the failed part; text parts in the same message still deliver.

### Group Messages With Groups Disabled

1. Bot is added to a Mattermost public channel.
2. User @mentions the bot.
3. `config.groupsEnabled` is `false` (default).
4. The adapter silently ignores the message, same as Telegram/Slack behavior.
5. No error is surfaced to the user in Mattermost (consistent with existing channels).

### Webhook/Integration Feedback Loops

1. Another integration (e.g., a CI bot) posts to a channel the opencode-router bot is in.
2. The `posted` event arrives with a valid `user_id` (the webhook creator's), but `post.props.from_webhook === "true"`.
3. Without the `props.from_webhook` / `props.from_bot` check, the adapter would process this as a user message and respond.
4. If the response triggers the other integration to post again, an infinite loop results.
5. **Mitigation**: Always skip posts where `props.from_webhook === "true"` or `props.from_bot === "true"`, in addition to the `user_id === self.id` check.

### Group DMs (channel_type "G")

1. A user creates a group DM that includes the bot and other users.
2. Every message in the group DM is visible to the bot — there are no @mentions in group DMs.
3. The adapter treats `"G"` the same as `"D"` (always respond), meaning the bot processes every message.
4. This could be noisy if the group DM is used for human-to-human conversation alongside bot interaction.
5. **Mitigation**: Acceptable for v1 — this matches the DM contract. If users report unwanted responses in group DMs, a future option could require @mentions in `"G"` channels specifically.

### Mattermost Server Requires MFA or SSO

1. Some deployments enforce MFA for all accounts, including bots.
2. Personal access tokens bypass MFA by design in Mattermost (they are pre-authenticated).
3. If the admin has disabled personal access tokens in System Console, the integration cannot work.
4. **Mitigation**: Document this requirement. The adapter's `start()` will fail with an auth error if the token is invalid, which surfaces in the health endpoint.

## Open Questions

1. **Should we use `@mattermost/client` or raw `fetch`?**
   - Options: (a) raw `fetch` + Bun WebSocket, (b) `@mattermost/client` npm package
   - **Recommendation**: Raw `fetch`. The npm package adds a dependency for marginal benefit on ~5 REST calls. The WebSocket client in the package is designed for the web app, not standalone bots. Unlike Telegram (which requires `grammy` for its complex Bot API) and Slack (which requires `@slack/socket-mode` + `@slack/web-api`), Mattermost's API is simple enough that no SDK is warranted — making this the first adapter with zero external dependencies.
   - Counter-argument: the npm package provides TypeScript types for the full API surface. If we anticipate needing many more endpoints later, the upfront cost of adding it could pay off.

2. **Should missed messages during WebSocket disconnect be replayed?**
   - Options: (a) accept message loss (v1), (b) poll `GET /channels/{id}/posts?since=` on reconnect
   - **Recommendation**: Accept loss for v1. Slack Socket Mode has the same limitation, and the existing implementation does not attempt replay. Add this as a future enhancement if users report it as painful.

3. **How to handle Mattermost instances with self-signed TLS certificates?**
   - Options: (a) respect `NODE_TLS_REJECT_UNAUTHORIZED`, (b) add a per-identity `tlsInsecure` config flag, (c) ignore (require valid certs)
   - **Recommendation**: Start with (c) — require valid certs. If users report issues with self-hosted instances behind self-signed certs, add (b) as a follow-up. Avoid (a) as it's a global flag that affects all connections.

4. **Naming: `instances` vs `apps` vs `bots` for config array key?**
   - Telegram uses `bots`, Slack uses `apps`. Mattermost bot accounts are called "bots" in their docs, but `serverUrl` makes "instance" feel more natural since each entry represents a distinct Mattermost server.
   - **Recommendation**: Use `instances` since the identity represents a connection to a Mattermost server instance, not just a bot. But `bots` would also be fine for consistency with Telegram.

5. **Should the UI use the same expandable accordion pattern or a tabbed layout?**
   - The current UI has Telegram and Slack as expandable sections. Adding a third may feel crowded.
   - **Recommendation**: Keep the accordion. Three sections is fine. Reassess if a fourth channel is added.

## Success Criteria

- [x] `opencode-router mattermost add <url> <token> --id default` persists config and starts the adapter
- [x] `opencode-router mattermost list` shows configured identities
- [x] `opencode-router mattermost remove <id>` stops adapter and removes config
- [x] DM messages in Mattermost are received by the adapter and routed to an opencode session
- [x] @mentions in Mattermost channels (when `groupsEnabled=true`) trigger the adapter
- [x] Text replies from opencode are delivered back to the correct Mattermost channel/thread
- [x] File attachments (images, documents) in both directions work
- [x] `opencode-router send --channel mattermost --to <channelId> --message "test"` delivers
- [x] Health endpoint shows `"mattermost": true/false` in `channels`
- [x] `GET /identities/mattermost`, `POST /identities/mattermost`, `DELETE /identities/mattermost/:id` work
- [x] Desktop app Messaging settings page shows Mattermost section with connect/disconnect
- [x] WebSocket reconnects automatically after transient disconnection
- [x] Unit tests pass for adapter creation, message parsing, peer ID encoding, delivery
- [x] No new npm dependencies added
- [x] Existing Telegram and Slack functionality is unaffected (no regressions)

## References

- `apps/opencode-router/src/config.ts` — `ChannelName` type, identity types, config loading
- `apps/opencode-router/src/bridge.ts` — `Adapter` type (lines 23-34), adapter registration (lines 408-434), `getStatus()` snapshot builder (lines 735-744), health handler wiring (lines 1055-1200)
- `apps/opencode-router/src/slack.ts` — Primary pattern to follow for adapter structure
- `apps/opencode-router/src/telegram.ts` — Secondary reference, shows media download pattern
- `apps/opencode-router/src/health.ts` — `HealthSnapshot`, `HealthHandlers`, HTTP endpoint routing
- `apps/opencode-router/src/media.ts` — `InboundMediaAttachment.source` union, media types
- `apps/opencode-router/src/delivery.ts` — Error classification, retry logic
- `apps/opencode-router/src/cli.ts` — CLI command structure for `telegram`/`slack` subcommands
- `apps/opencode-router/src/db.ts` — SQLite store; channel-agnostic, no schema changes needed
- `apps/opencode-router/test/slack.test.js` — Test pattern to follow
- `apps/app/src/app/lib/openwork-server.ts` — Server client API methods and response types (uses `Record<string, unknown>` — forward-compatible)
- `apps/app/src/react-app/domains/settings/pages/messaging-view.tsx` — `MessagingChannel` type, UI structure
- `apps/app/src/react-app/domains/settings/state/messaging-view-state.ts` — State management pattern for channel identity CRUD
- Mattermost API docs: `https://api.mattermost.com/` (REST v4 reference)
- Mattermost WebSocket docs: `https://developers.mattermost.com/integrate/reference/websocket/` (event types)
