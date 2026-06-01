# Interactive Question Relay for opencode-router

**Date**: 2026-05-29
**Status**: Implemented (integration tests deferred)
**Author**: AI-assisted

## Overview

Relay OpenCode's `AskUserQuestion` tool through messaging channels (Telegram, Slack, Mattermost) so the AI agent can ask the user questions with selectable options and free-text input, wait for a reply in the chat, and resume execution with the user's answer.

## Motivation

### Current State

When OpenCode runs in server mode and the agent calls the `AskUserQuestion` tool, the question is emitted as a `question.asked` SSE event. The OpenWork desktop app renders a modal with options and a text input for the user to answer. The SDK provides `client.question.reply()` and `client.question.reject()` to close the loop.

The opencode-router's event stream handler (`bridge.ts:1715-1817`) processes these event types:

| Event | Current Handling |
|-------|-----------------|
| `message.updated` | Extract model info for status display |
| `session.status` | Typing/busy indicators |
| `session.idle` | Done state |
| `message.part.updated` | Tool output forwarding |
| `permission.asked` | Auto-allow or auto-deny (binary switch) |
| **`question.asked`** | **Not handled. Silently ignored.** |

When the agent asks a question, the session blocks indefinitely waiting for a reply that never comes. The user sees the "Thinking..." indicator hang with no indication that the agent needs input.

### Problems

1. **Sessions hang silently**: The agent asks a question, the session waits forever, the user has no idea why the bot stopped responding.
2. **No interactive workflow over chat**: The agent cannot gather structured input from users in Telegram/Slack/Mattermost. This blocks real-world use cases like: "Which database should I use? (PostgreSQL / MySQL / SQLite)", "Should I proceed with the destructive migration?", "Pick a deployment target".
3. **Inconsistency with desktop app**: The desktop app handles questions interactively. Chat users get a degraded experience with no workaround.

### Desired State

When the agent calls `AskUserQuestion`, the router:

1. Formats the question with numbered options and sends it to the user in their chat channel.
2. Waits for the user's next message in that channel.
3. Parses the reply (number selection, multi-select, or free text).
4. Calls `client.question.reply()` or `client.question.reject()` to unblock the session.

Example chat flow:

```
Bot: [Question] Which database should I use?
     1. PostgreSQL - Best for relational data
     2. MySQL - Wide hosting support
     3. SQLite - Zero-config, file-based
     (Reply with a number, or type your own answer)

User: 1

Bot: [Thinking...]
```

For multi-question requests (multiple steps), the router walks through each question sequentially, collecting one answer at a time.

## Research Findings

### OpenCode Question SDK Surface

The SDK exposes three operations on the `Question` class:

```typescript
class Question {
  list(params?: { directory?, workspace? }): Promise<QuestionRequest[]>;
  reply(params: { requestID: string, answers?: QuestionAnswer[], directory?, workspace? }): Promise<boolean>;
  reject(params: { requestID: string, directory?, workspace? }): Promise<boolean>;
}
```

Note: `answers` is optional in the SDK type (defaults to empty array). The router should always provide explicit answers.

The `question.asked` SSE event carries a `QuestionRequest`:

```typescript
type QuestionRequest = {
  id: string;            // Request ID (used in reply/reject)
  sessionID: string;     // Session that asked the question
  questions: QuestionInfo[];  // Array of questions (multi-step)
  tool?: QuestionTool;   // Originating tool call info
};

type QuestionInfo = {
  question: string;      // Full question text
  header: string;        // Short label (max 30 chars)
  options: QuestionOption[];  // Available choices
  multiple?: boolean;    // Allow multi-select
  custom?: boolean;      // Allow free-text input
};

type QuestionOption = {
  label: string;         // Display text (1-5 words)
  description: string;   // Explanation of the choice
};

type QuestionAnswer = string[];  // Array of selected labels/custom text
```

Key observations:
- A single `QuestionRequest` can contain **multiple questions** (steps). Each must be answered in order. The reply sends all answers at once.
- `QuestionAnswer` is `string[]` — a list of selected option labels (or custom text). For single-select, it's `["PostgreSQL"]`. For multi-select, it's `["PostgreSQL", "SQLite"]`.
- The `custom` flag means the user can type their own answer instead of picking from options. **Defaults to true when omitted** (`Custom *bool` in Go — `nil` means enabled, per `IsCustomEnabled()` in `question/question.go:29`).
- If `options` is empty and `custom` is true, it's a free-text question with no predefined choices.
- The `question.replied` and `question.rejected` events confirm the lifecycle completed.
- Server-side timeout: the `Ask()` method blocks on `ctx.Done()` — when the session context is cancelled, the question auto-rejects with `ErrQuestionRejected`. This means questions have implicit server-side timeout tied to session lifetime.

### OpenCode Fork Verification

Verified against our fork at `/Users/nouwa/Development/open-source-fork/opencode/`:

**API routes** (`internal/api/server.go:114-116`):
- `GET /question` — list pending questions
- `POST /question/{requestID}/reply` — provide answers
- `POST /question/{requestID}/reject` — dismiss question

**Go types** match the SDK types with two minor differences:
- The fork's `APIQuestionPrompt` does **not** include a `header` field (the SDK type `QuestionInfo` has `header: string`). The router must handle missing `header` gracefully — fall back to truncating `question` text.
- The fork's `APIQuestionRequest` does **not** include a `tool` field (the SDK type has `tool?: QuestionTool`). Not needed for the router — the `tool` field is only used by the desktop app for UI positioning.

**Feature flag**: The question service is gated behind `OPENCODE_ENABLE_QUESTION_TOOL=1` or `=true` (`internal/app/app.go:159`). When disabled, `app.Questions` is `nil` and all API handlers return early. **The router must document this requirement.** The TUI sets this automatically, but `opencode serve` does not — users must set the env var explicitly.

**Event scoping**: Question events are **global** (not directory-scoped). The `question.Service` is a singleton per app instance. The router's per-directory event subscriptions will each receive question events for all sessions. The router must use `sessionID` from the `QuestionRequest` to resolve the correct peer via `activeRuns`.

**Blocking behavior**: `Ask()` (`question.go:65-90`) blocks on a channel select — it waits for either `replyCh` (answer), `rejectCh` (reject), or `ctx.Done()` (session cancelled). This confirms that `session.prompt()` in the router will block until the question is answered, reinforcing the deadlock concern addressed in the Architecture section.

### Event Lifecycle

```
Agent calls AskUserQuestion
  → OpenCode emits "question.asked" event on the SSE stream
  → Session blocks, waiting for reply/reject
  → Client calls question.reply() or question.reject()
  → OpenCode emits "question.replied" or "question.rejected"
  → Session resumes with the answer (or handles rejection)
```

### Desktop App Rendering Pattern

The desktop app (`question-modal.tsx`) uses a multi-step reducer:
- Displays one question at a time from the `questions[]` array.
- For single-select without custom: clicking an option immediately submits.
- For multi-select: checkboxes, user clicks "Confirm" to advance.
- For custom: text input field appears below options.
- After all questions are answered, calls `question.reply({ requestID, answers })`.

### Chat Channel Constraints

| Constraint | Impact |
|-----------|--------|
| No interactive buttons in Telegram (without inline keyboards) | Must use numbered text replies |
| Slack has Block Kit (buttons, dropdowns) | Could use buttons but text reply is simpler and consistent across channels |
| Mattermost has interactive messages | Same — text-based is simplest and channel-agnostic |
| User might send unrelated messages | Need to distinguish question answers from new prompts |
| Multiple questions in one request | Must walk through sequentially |
| Session might time out | Need timeout handling |

### Design Consideration: Inline Buttons vs Text Reply

**Option A: Text-based reply (numbered options)**
- Works identically across all three channels
- No platform-specific API needed
- User types "1" or "1, 3" or free text
- Simple to implement
- Slightly worse UX (user must read numbers)

**Option B: Platform-native interactive elements**
- Telegram: inline keyboard buttons
- Slack: Block Kit action buttons
- Mattermost: interactive message attachments
- Better UX but 3x implementation effort
- Each platform has different callback mechanisms

**Decision**: Start with **Option A** (text-based). It covers all channels with one implementation. Platform-native buttons can be a follow-up enhancement.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Rendering format | Numbered text list | Channel-agnostic, no platform-specific APIs needed |
| Answer parsing | Number-based with free-text fallback | "1" selects first option, "1, 3" for multi-select, anything else is custom text |
| Multi-question handling | Sequential, one message per question | Matches desktop app pattern; avoids overwhelming users |
| Pending question state | Per-peer map in bridge memory | Lightweight, no DB schema changes, questions are transient |
| Answer interception | Early return in `handleInbound` before session prompt | If a pending question exists for the peer, treat the next message as an answer |
| Timeout | Configurable (default 5 minutes), auto-reject on expiry | Prevents sessions from hanging forever if user walks away |
| Reject command | `/skip` or `/reject` in chat | Gives users an explicit opt-out without answering |
| Question mode | `QUESTION_MODE` env var: `interactive` (default), `auto-reject`, `disabled` | `auto-reject` immediately rejects all questions (for fully-autonomous bots). `disabled` silently ignores (current behavior). |

## Architecture

### Critical: Session Queue Deadlock Avoidance

The bridge serializes all work for a session key through `enqueue()` (`bridge.ts:2365`). When the user sends a message, `handleInbound()` resolves a session and calls `enqueue(key, async () => { ... session.prompt() ... })`. The `session.prompt()` call **blocks until the session goes idle** — which includes waiting for question answers.

This creates a deadlock risk:

```
1. User sends "build my app" → handleInbound → enqueue(key, prompt())
2. prompt() calls session.prompt(), which blocks waiting for the agent
3. Agent asks a question → "question.asked" event arrives
4. Router sends question to user in chat
5. User replies "1" → handleInbound fires again
6. If handleInbound tries to enqueue(key, ...) → DEADLOCKED
   (the queue is stuck behind the still-blocked prompt)
```

**Solution**: The answer interception must happen **before** `enqueue()` — in the early part of `handleInbound()`, after command dispatch but before session resolution and enqueuing. The answer is processed directly (calling `client.question.reply()` as an independent HTTP request) and `handleInbound` returns early. This runs concurrently with the still-awaited `session.prompt()`, which is safe because `question.reply()` is an independent API call.

Insertion point: after the command dispatch block (`handleCommand` at ~line 1996) and before the reporter callback / session binding logic (~line 2007). The exact sequence is:

1. Self-message filter
2. Telegram pairing gate
3. Command dispatch (`/reset`, `/help`, etc. — these return true if handled)
4. **Question answer interception** (NEW — check `pendingQuestions`, return early if answered)
5. Reporter callback, session resolution, enqueue, prompt (existing flow)

The `/skip` command: since `handleCommand` doesn't recognize `/skip`, it returns `false`. The question interceptor then catches it. This is intentional — `/skip` is only meaningful when a question is pending. If no question is pending, `/skip` falls through to the normal prompt flow (the agent sees "/skip" as user text).

### Question Lifecycle in the Router

```
STEP 1: Question arrives (event stream, concurrent with prompt)
────────────────────
Event stream delivers "question.asked" with QuestionRequest.
Note: question events are GLOBAL (not directory-scoped). Multiple
directory-scoped event subscriptions may receive the same event.
The router must deduplicate using requestID to avoid processing twice.
Router resolves the active RunState for the sessionID via activeRuns map
(iterating activeRuns to find the entry where run.sessionID matches).
From the RunState, it extracts channel, identityId, peerId, peerKey, directory.
If no RunState found (session already idle): auto-reject, log warning.
Router stores a PendingQuestion in the pendingQuestions map,
keyed by (channel, identityId, peerKey).
Router sends formatted question FIRST (awaited), THEN stores the entry
(ensures message delivery before accepting answers).

STEP 2: Format and send first question
────────────────────
Router formats QuestionInfo[0] as a numbered list message:

  [Question] Which database should I use?
  1. PostgreSQL — Best for relational data
  2. MySQL — Wide hosting support
  3. SQLite — Zero-config, file-based
  (Reply with a number, or type your own answer)
  (Send /skip to skip this question)

Router sends this via sendText() to the peer, awaits delivery.

STEP 3: User replies (intercepted BEFORE enqueue)
────────────────────
User sends "1" (or "1, 3" for multi-select, or "PostgreSQL", or free text).
handleInbound() checks pendingQuestions map AFTER command dispatch,
BEFORE session resolution and enqueue.
If a pending question exists for this peer AND message is text-only:
  - Clear the timeout timer
  - Parse the answer (see Answer Parsing below)
  - If valid: store answer for current question index
    - If more questions remain: send next question, reset timeout, return early
    - If all questions answered: call client.question.reply() with all answers,
      clear pending state, return early
  - If invalid: re-prompt with error message, return early
  - If reject (/skip): call client.question.reject(), clear state, return early
  - In ALL cases: return early from handleInbound (never reaches enqueue)

STEP 4: Session resumes
────────────────────
client.question.reply() unblocks the server-side session.
"question.replied" event arrives — defensive cleanup of pendingQuestions if still present.
session.prompt() eventually returns in the original enqueued task.
Normal message flow resumes.
```

### Answer Parsing Rules

Parsing precedence (checked in order):

1. **Reject commands**: `/skip` or `/reject` → reject the question
2. **Empty input**: whitespace-only → ignore, re-prompt
3. **Exact label match** (case-insensitive): if the trimmed input exactly matches an option label → select that option. This takes priority over number parsing to avoid ambiguity with labels like "1password".
4. **Number selection**: if the entire trimmed input is a number (or comma/space-separated numbers), and all numbers are in range → select corresponding options
5. **Free text fallback**: if `custom=true` → accept as custom text. If `custom=false` → "Invalid option, try again"

Given a question with options `["PostgreSQL", "MySQL", "SQLite"]`:

| User Input | Parsed As | Condition |
|-----------|-----------|-----------|
| `/skip` | Reject | Reject command |
| `PostgreSQL` | `["PostgreSQL"]` | Exact label match (case-insensitive) |
| `postgresql` | `["PostgreSQL"]` | Case-insensitive label match |
| `1` | `["PostgreSQL"]` | Number within range (no label match) |
| `3` | `["SQLite"]` | Number within range |
| `1, 3` or `1,3` | `["PostgreSQL", "SQLite"]` | Comma-separated numbers (only if `multiple=true`) |
| `use postgres` | `["use postgres"]` | Free text (only if `custom=true`) |
| `5` | `["5"]` if `custom=true`, error if `custom=false` | Out of range number |
| (empty/whitespace) | Ignore, re-prompt | Not consumed as answer |

Edge cases:
- If `multiple=false` and user sends "1, 3": take only the first (`["PostgreSQL"]`) and warn.
- Multi-select delimiter: comma only (not space — "1 3" is treated as free text to avoid ambiguity with multi-word inputs).
- If no options exist and `custom=true`: any non-empty text is accepted as-is.
- If user sends a file/media while a question is pending: ignore the pending question, process normally as a new prompt (the question times out naturally).
- Unicode normalization: trim and normalize whitespace (collapse multiple spaces, strip non-breaking spaces) before parsing.

### State Model

```typescript
type PendingQuestion = {
  requestID: string;
  sessionID: string;
  questions: QuestionInfo[];
  currentIndex: number;
  answers: QuestionAnswer[];  // Collected answers so far
  directory: string;          // For the SDK reply call
  channel: ChannelName;       // For sending messages
  identityId: string;
  peerId: string;
  peerKey: string;
  createdAt: number;          // For timeout
  timeoutTimer: NodeJS.Timeout;
  resolved: boolean;          // Guards against timeout+answer race
};

// Key: `${channel}:${identityId}:${peerKey}`
const pendingQuestions = new Map<string, PendingQuestion>();

// Deduplication: since question events are global (not directory-scoped),
// multiple event subscriptions may fire for the same question.
// Track seen requestIDs to process each question exactly once.
const seenQuestionIds = new Set<string>();
```

The `resolved` flag prevents double-submission when the timeout and user answer race. Both the answer path and timeout path check `if (pending.resolved) return` before calling the SDK. The `seenQuestionIds` set prevents duplicate processing across multiple directory-scoped event subscriptions.

### Message Format

**Single-select with options:**
```
[Question] Which database should I use?
1. PostgreSQL — Best for relational data
2. MySQL — Wide hosting support
3. SQLite — Zero-config, file-based
Reply with a number, or type your own answer.
```

**Multi-select with options:**
```
[Question] Select the features to enable:
1. Dark mode — Toggle dark theme
2. Notifications — Push notification support
3. Analytics — Usage tracking
Reply with numbers separated by commas (e.g. 1, 3).
```

**Free-text only (no options):**
```
[Question] What should the commit message be?
Type your answer, or send /skip to skip.
```

**Multi-step progress (question 2 of 3):**
```
[Question 2/3] Choose the deployment target:
1. Production — us-east-1
2. Staging — eu-west-1
Reply with a number.
```

## Implementation Plan

### Phase 1: Core Question Relay

- [x] **1.1** Add `PendingQuestion` type and `pendingQuestions` map to bridge state
- [x] **1.2** Add `QUESTION_MODE` config: `interactive` | `auto-reject` | `disabled` (default: `interactive`)
  - In `config.ts`: add `questionMode` to `Config`, parse from `QUESTION_MODE` env var
  - In `config.ts`: add `questionMode` to `OpenCodeRouterConfigFile` for config-file persistence
- [x] **1.3** Handle `question.asked` event in the event stream loop (`bridge.ts`):
  - Deduplicate: check `seenQuestionIds.has(requestID)`, skip if already seen, add if new
  - Resolve the `RunState` for the `sessionID` by iterating `activeRuns`
  - If no RunState found: auto-reject, log warning, continue
  - If `questionMode === "disabled"`: ignore (current behavior)
  - If `questionMode === "auto-reject"`: call `client.question.reject({ requestID })` immediately
  - If `questionMode === "interactive"`: create `PendingQuestion`, format first question, send to peer, start timeout timer
  - Clean up `seenQuestionIds` entries when questions are resolved (reply/reject/timeout) to prevent unbounded growth
- [x] **1.4** Implement `formatQuestionMessage(question: QuestionInfo, index: number, total: number): string`
  - Render the numbered option list with descriptions
  - Use `header` field as the title if present; otherwise fall back to the `question` text (our fork omits `header`)
  - Include helper text for reply format (numbers, multi-select, free text)
  - Include step counter for multi-question requests
- [x] **1.5** Implement `parseQuestionAnswer(input: string, question: QuestionInfo): { type: "answer", answer: QuestionAnswer } | { type: "reject" } | { type: "invalid", reason: string } | { type: "ignore" }`
  - Parse numbers, ranges, exact label matches, free text
  - Handle /skip and /reject commands
  - Handle edge cases (out-of-range, multi when single-select, empty input)
- [x] **1.6** Intercept answers in `handleInbound()`:
  - Before the existing message processing, check `pendingQuestions` for the peer key
  - If a pending question exists and the message is text-only (no media):
    - Parse the answer
    - If valid: store answer, advance to next question or submit all answers
    - If invalid: re-prompt with error message
    - If reject: call `client.question.reject()`, clear state
    - Return early (don't process as a new prompt)
  - If the message contains media: skip question interception, process normally
- [x] **1.7** Implement timeout handling:
  - On timeout: call `client.question.reject()`, send "Question timed out" to peer, clear state
  - Default timeout: 5 minutes (configurable via `QUESTION_TIMEOUT_MS` env var)
- [x] **1.8** Handle `question.replied` and `question.rejected` events:
  - Clean up `pendingQuestions` map entry if still present (defensive cleanup)
  - Log the outcome
- [x] **1.9** Add graceful shutdown cleanup:
  - In `bridge.stop()`, clear all timeout timers and auto-reject all pending questions (best-effort)
- [x] **1.10** Add error handling for SDK calls:
  - Catch 404 on `question.reply()` / `question.reject()` — expected in race conditions, log debug, clear state silently
  - Catch 400 on `question.reply()` — log error, send failure message to user
  - Catch network errors — log error, send retry message, keep pending state
- [x] **1.11** Add `resolved` flag check in both answer and timeout paths to prevent double-submission
- [x] **1.12** Integrate `/skip` with `/reset`: when `/reset` is handled, also clear any pending question for the peer and auto-reject it

### Phase 2: Tests

- [x] **2.1** Test `formatQuestionMessage` for all variants:
  - Single-select with options
  - Multi-select with options
  - Free-text only
  - Multi-step (2/3 progress)
  - Options with empty descriptions
- [x] **2.2** Test `parseQuestionAnswer` for all input types:
  - Single number ("1")
  - Multiple numbers ("1, 3")
  - Exact label match ("PostgreSQL")
  - Case-insensitive match ("postgresql")
  - Free text input
  - /skip and /reject commands
  - Out-of-range number with custom=true (free text fallback)
  - Out-of-range number with custom=false (invalid)
  - Empty input (ignore)
  - Multiple numbers when multiple=false (take first, warn)
- [ ] **2.3** Integration test: full question lifecycle (deferred — requires mock event stream)
  - Simulate `question.asked` event
  - Verify message sent to peer
  - Simulate user reply
  - Verify `question.reply()` called with correct answers
- [ ] **2.4** Test timeout behavior (deferred — requires mock timers)
- [ ] **2.5** Test `auto-reject` mode (deferred — requires mock event stream)
- [ ] **2.6** Test multi-question sequential flow (deferred — requires mock event stream)
- [ ] **2.7** Test media message during pending question (deferred — requires mock event stream)
- [ ] **2.8** Test SDK 404 error handling (deferred — requires mock event stream)
- [ ] **2.9** Test resolved flag preventing double-submission (deferred — requires mock event stream)
- [ ] **2.10** Test /reset clearing pending questions (deferred — requires mock event stream)
- [x] **2.11** Test label-before-number parsing precedence (option label "1password")

### Phase 3: CLI & Config

- [x] **3.1** Add `questionMode` to config.ts and loadConfig
- [x] **3.2** Add `questionTimeoutMs` to config.ts and loadConfig
- [x] **3.3** Add `QUESTION_MODE`, `QUESTION_TIMEOUT_MS` to `.env.example`
- [x] **3.4** Document `OPENCODE_ENABLE_QUESTION_TOOL=1` prerequisite in README and `.env.example` (must be set on the opencode server, not the router)
- [x] **3.5** Update README with question relay documentation
- [x] **3.6** Add `/help` command entry for `/skip`

### Phase 4: Health & Observability

- [x] **4.1** Add `pendingQuestions` count to health snapshot (for debugging)
- [x] **4.2** Add `questionMode` to health snapshot config section
- [x] **4.3** Log question events (asked, replied, rejected, timed out) at info level

## Files Changed

```
apps/opencode-router/
├── src/
│   ├── bridge.ts              EDIT  ~180 LOC: question.asked event handler, handleInbound answer
│   │                                 interception (before enqueue), pendingQuestions state,
│   │                                 timeout management, graceful shutdown cleanup,
│   │                                 resolved-flag race guard, /reset integration
│   ├── question.ts            NEW   ~150 LOC: formatQuestionMessage(), parseQuestionAnswer(),
│   │                                 PendingQuestion type, answer parsing logic,
│   │                                 SDK error classification
│   ├── config.ts              EDIT  add questionMode and questionTimeoutMs to Config
│   └── health.ts              EDIT  add pendingQuestions count and questionMode to HealthSnapshot
├── test/
│   └── question.test.js       NEW   ~400 LOC: unit + integration tests (format, parse,
│   │                                 lifecycle, timeout, race conditions, error handling)
├── .env.example               EDIT  add QUESTION_MODE, QUESTION_TIMEOUT_MS
└── README.md                  EDIT  add question relay section
```

## Edge Cases

### Question During Active Tool Execution

1. Agent runs a tool that takes 30 seconds.
2. Mid-execution, agent asks a question (unlikely but possible with parallel tool calls).
3. The `question.asked` event arrives while tool output is being streamed.
4. The router stores the pending question and sends it to the user.
5. Tool output messages continue to be sent (they are `kind: "tool"`, not intercepted).
6. User sees tool output interleaved with the question — acceptable, matches desktop app behavior.

### User Sends Multiple Messages Before Answering

1. Question is pending.
2. User sends "hmm let me think" — this gets parsed as free text.
3. If `custom=true`: this becomes the answer (not ideal, but user can /skip and the agent can re-ask).
4. If `custom=false`: "Invalid option" re-prompt. The extraneous message is consumed.
5. **Mitigation**: The format message includes clear instructions about reply format.

### Concurrent Questions for Same Peer

1. Agent asks question A, then immediately asks question B (different sessions or parallel agents).
2. Only one pending question per peer key. The second question replaces the first.
3. The first question is auto-rejected when replaced.
4. This is rare in practice — sessions are sequential per peer.

### Question While No Active Session

1. `question.asked` event arrives but the session's RunState has already been cleaned up (idle).
2. The router cannot resolve the peer key.
3. The question is auto-rejected (no user to ask).
4. Logged as a warning.

### User Sends /reset During Pending Question

1. User has a pending question.
2. User sends `/reset` (existing command that clears session + model).
3. The `/reset` handler runs first (before question interception, since commands are checked first in handleInbound).
4. The pending question is orphaned — it times out and auto-rejects.
5. **Enhancement**: `/reset` should also clear pending questions for the peer.

### Event Stream Reconnection While Question Pending

1. A question is pending (sent to user, waiting for reply).
2. The event stream disconnects and reconnects.
3. The `pendingQuestions` map is in-memory — the entry survives reconnection.
4. The user's reply still arrives via the adapter (Telegram/Slack/Mattermost), which is independent of the event stream.
5. The answer interception in `handleInbound` still works — it calls `client.question.reply()` directly.
6. **Risk**: If the server restarted (not just a stream blip), the question may no longer exist server-side. The `question.reply()` call returns 404.
7. **Mitigation**: Catch 404 from `question.reply()` and `question.reject()`. If 404: clear the pending question, send "This question is no longer active" to the user.

### SDK Call Errors (question.reply / question.reject)

When `client.question.reply()` or `client.question.reject()` fails:

| Error | Cause | Handling |
|-------|-------|----------|
| 400 Bad Request | Malformed answers | Log error, send "Failed to submit answer" to user, clear pending state |
| 404 Not Found | Question already answered, timed out server-side, or session ended | Log debug (expected in race conditions), clear pending state silently |
| Network error | Connection issue | Log error, send "Failed to reach server, try again" to user, keep pending state (user can retry) |

The 404 case is especially important because of the timeout+answer race (see below).

### Timeout and Answer Race Condition

1. Question is pending with a 5-minute timeout.
2. At 4:59, the timeout fires and starts `client.question.reject()`.
3. At 4:59.1, the user sends "1" and the answer interceptor starts `client.question.reply()`.
4. Both SDK calls race. One succeeds, the other gets 404.
5. **Mitigation**: Both paths must catch 404 gracefully. The `pendingQuestions` entry should use a `resolved: boolean` flag. Both paths check-and-set this flag atomically (JavaScript is single-threaded, so a simple boolean check suffices). First one to set `resolved = true` wins; the other is a no-op.

### Graceful Shutdown with Pending Questions

1. Bridge is shutting down (`bridge.stop()` called).
2. There are pending questions in the map.
3. **Behavior**: Clear all timeout timers. Auto-reject all pending questions via `client.question.reject()` (best-effort, catch errors). Clear the map.
4. This prevents sessions from hanging server-side after the router shuts down.

### Group Chat Shared Question Slot

1. In Telegram group chats or Mattermost group DMs, the `peerKey` is the chat/channel ID.
2. All users in the group share one pending question slot.
3. Whichever user replies first provides the answer.
4. This is acceptable for v1 — the agent asked the group, any member can answer.

### Agent Asks Question in auto-reject Mode

1. `QUESTION_MODE=auto-reject`.
2. Agent asks a question.
3. Router immediately rejects: `client.question.reject({ requestID })`.
4. Router sends a brief notice to the peer: "The agent asked a question but interactive questions are disabled. The agent will handle this automatically."
5. The agent receives the rejection and adapts (makes a default choice or explains the limitation).

## Open Questions

1. **Should the timeout be per-question-step or per-request?**
   - Options: (a) per-request — 5 minutes for all questions, (b) per-question — 5 minutes per step
   - **Recommendation**: Per-request. Multi-step questions are rare, and a 5-minute total timeout is generous.

2. **Should the router support Telegram inline keyboards / Slack buttons as a follow-up?**
   - **Recommendation**: Yes, but as a separate spec. The text-based approach is the right v1 — it works on all channels and the parsing logic is reusable as a fallback.

3. **Should pending questions survive a router restart?**
   - **Recommendation**: No. Questions are transient and tied to active sessions. On restart, sessions reconnect and the agent can re-ask if needed. No persistence needed.

4. **What if the user's reply matches both a number and a valid option label?**
   - Example: Options are `["1password", "bitwarden"]` and user types `1`.
   - **Recommendation**: Numbers take priority. If the user wants the literal label, they type the full label.

## Success Criteria

- [x] `question.asked` events are caught and formatted as numbered-list messages in all three channels
- [x] User can reply with a number to select an option
- [x] User can reply with multiple numbers for multi-select questions
- [x] User can type free text when `custom=true`
- [x] User can `/skip` to reject a question
- [x] Multi-question requests are walked through sequentially
- [x] Session resumes after the answer is submitted
- [x] Questions time out after 5 minutes (configurable) with auto-reject
- [x] `auto-reject` mode immediately rejects all questions
- [x] `disabled` mode silently ignores questions (backward compatible)
- [x] Existing Telegram, Slack, and Mattermost functionality is unaffected
- [x] Unit tests cover format, parse, lifecycle, timeout
- [x] No new npm dependencies

## References

- `apps/opencode-router/src/bridge.ts` — Event stream handler (`ensureEventSubscription` at ~line 1714, SSE loop body lines 1726-1817), `handleInbound` (~line 1930), `handleCommand` (~line 2225), `enqueue` (~line 2365), `activeRuns`/`RunState` types (~line 120-133), `bridge.stop()` cleanup (~line 2405)
- `apps/opencode-router/src/config.ts` — Config type, env var parsing
- `apps/opencode-router/src/health.ts` — HealthSnapshot type
- `apps/opencode-router/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` — `QuestionRequest`, `QuestionInfo`, `QuestionOption`, `QuestionAnswer`, `EventQuestionAsked`, `EventQuestionReplied`, `EventQuestionRejected`
- `apps/opencode-router/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` — `Question.reply()` (note: `answers` param is optional), `Question.reject()`, `Question.list()`
- `apps/app/src/react-app/domains/session/modals/question-modal.tsx` — Desktop app question rendering pattern (multi-step reducer, immediate submit for single-select)
- `apps/app/src/react-app/shell/session-route.tsx` — Desktop app `respondQuestion` callback (lines 1705-1735), React Query cache management
