import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MediaStore } from "../dist/media-store.js";
import {
  createMattermostAdapter,
  formatMattermostPeerId,
  parseMattermostPeerId,
  stripMattermostMention,
} from "../dist/mattermost.js";

function createLoggerStub() {
  const base = {
    child() {
      return base;
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return base;
}

// --- Peer ID tests ---

test("mattermost peerId encoding: DM (channelId only)", () => {
  assert.deepEqual(parseMattermostPeerId("abcdef123456"), {
    channelId: "abcdef123456",
  });
  assert.equal(
    formatMattermostPeerId({ channelId: "abcdef123456" }),
    "abcdef123456",
  );
});

test("mattermost peerId encoding: thread (channelId|rootPostId)", () => {
  assert.deepEqual(parseMattermostPeerId("ch123|post456"), {
    channelId: "ch123",
    rootPostId: "post456",
  });
  assert.equal(
    formatMattermostPeerId({ channelId: "ch123", rootPostId: "post456" }),
    "ch123|post456",
  );
});

test("mattermost peerId encoding: empty string", () => {
  assert.deepEqual(parseMattermostPeerId(""), { channelId: "" });
  assert.deepEqual(parseMattermostPeerId("  "), { channelId: "" });
});

// --- Mention stripping ---

test("stripMattermostMention removes bot mention and leading punctuation", () => {
  assert.equal(stripMattermostMention("@mybot hello", "mybot"), "hello");
  assert.equal(stripMattermostMention("@mybot: hello", "mybot"), "hello");
  assert.equal(stripMattermostMention("@mybot - hello", "mybot"), "hello");
  assert.equal(stripMattermostMention("hello @mybot world", "mybot"), "hello   world");
  assert.equal(stripMattermostMention("hello", "mybot"), "hello");
  assert.equal(stripMattermostMention("@mybot", "mybot"), "");
});

test("stripMattermostMention with null botUsername", () => {
  assert.equal(stripMattermostMention("@mybot hello", null), "@mybot hello");
});

// --- Adapter creation ---

test("createMattermostAdapter throws on missing serverUrl", () => {
  const logger = createLoggerStub();
  assert.throws(
    () =>
      createMattermostAdapter(
        { id: "test", serverUrl: "", accessToken: "tok123" },
        { groupsEnabled: false },
        logger,
        async () => {},
      ),
    /server URL is required/i,
  );
});

test("createMattermostAdapter throws on missing accessToken", () => {
  const logger = createLoggerStub();
  assert.throws(
    () =>
      createMattermostAdapter(
        { id: "test", serverUrl: "https://mm.example.com", accessToken: "" },
        { groupsEnabled: false },
        logger,
        async () => {},
      ),
    /access token is required/i,
  );
});

test("createMattermostAdapter returns adapter with correct shape", () => {
  const logger = createLoggerStub();
  const adapter = createMattermostAdapter(
    { id: "test", serverUrl: "https://mm.example.com", accessToken: "tok123" },
    { groupsEnabled: false },
    logger,
    async () => {},
  );

  assert.equal(adapter.name, "mattermost");
  assert.equal(adapter.identityId, "test");
  assert.equal(adapter.maxTextLength, 16_383);
  assert.equal(typeof adapter.start, "function");
  assert.equal(typeof adapter.stop, "function");
  assert.equal(typeof adapter.sendMessage, "function");
  assert.equal(typeof adapter.sendText, "function");
  assert.equal(typeof adapter.sendTyping, "function");
});

// --- Inbound message handling (WebSocket event simulation) ---

test("createMattermostAdapter handles DM posted events", async () => {
  const logger = createLoggerStub();
  const inbound = [];

  // Mock fetch for getMe() and WebSocket for the adapter
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  let wsInstance;

  // Mock WebSocket
  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      wsInstance = this;
      // Schedule open + hello after microtask
      queueMicrotask(() => {
        this._emit("open", {});
      });
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      // After auth challenge, send hello event
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => {
          this._emit("message", {
            data: JSON.stringify({ event: "hello" }),
          });
        });
      }
    }
    close() {
      this._emit("close", { code: 1000, reason: "normal" });
    }
    _emit(event, data) {
      for (const handler of this.listeners[event] || []) {
        handler(data);
      }
    }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.includes("/api/v4/users/bot123/typing")) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: false },
      logger,
      async (msg) => inbound.push(msg),
    );

    await adapter.start();

    // Simulate a DM posted event
    wsInstance._emit("message", {
      data: JSON.stringify({
        event: "posted",
        data: {
          channel_type: "D",
          post: JSON.stringify({
            id: "post1",
            channel_id: "dm_channel_1",
            user_id: "user1",
            root_id: "",
            message: "hello bot",
            props: {},
          }),
        },
      }),
    });

    // Wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].channel, "mattermost");
    assert.equal(inbound[0].identityId, "default");
    assert.equal(inbound[0].text, "hello bot");
    // Top-level post: rootPostId = post.id since root_id is empty
    assert.equal(inbound[0].peerId, "dm_channel_1|post1");

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("createMattermostAdapter filters own messages", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  let wsInstance;

  class MockWebSocket {
    constructor() {
      this.listeners = {};
      wsInstance = this;
      queueMicrotask(() => this._emit("open", {}));
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => this._emit("message", { data: JSON.stringify({ event: "hello" }) }));
      }
    }
    close() { this._emit("close", { code: 1000, reason: "" }); }
    _emit(event, data) { for (const h of this.listeners[event] || []) h(data); }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: false },
      logger,
      async (msg) => inbound.push(msg),
    );

    await adapter.start();

    // Own message should be filtered
    wsInstance._emit("message", {
      data: JSON.stringify({
        event: "posted",
        data: {
          channel_type: "D",
          post: JSON.stringify({
            id: "post2",
            channel_id: "dm1",
            user_id: "bot123", // Same as bot user ID
            root_id: "",
            message: "my own response",
            props: {},
          }),
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inbound.length, 0, "own messages should be filtered");

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("createMattermostAdapter filters webhook posts", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  let wsInstance;

  class MockWebSocket {
    constructor() {
      this.listeners = {};
      wsInstance = this;
      queueMicrotask(() => this._emit("open", {}));
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => this._emit("message", { data: JSON.stringify({ event: "hello" }) }));
      }
    }
    close() { this._emit("close", { code: 1000, reason: "" }); }
    _emit(event, data) { for (const h of this.listeners[event] || []) h(data); }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: false },
      logger,
      async (msg) => inbound.push(msg),
    );

    await adapter.start();

    // Webhook post
    wsInstance._emit("message", {
      data: JSON.stringify({
        event: "posted",
        data: {
          channel_type: "D",
          post: JSON.stringify({
            id: "post3",
            channel_id: "dm1",
            user_id: "webhook_user",
            root_id: "",
            message: "ci build passed",
            props: { from_webhook: "true" },
          }),
        },
      }),
    });

    // Bot post
    wsInstance._emit("message", {
      data: JSON.stringify({
        event: "posted",
        data: {
          channel_type: "D",
          post: JSON.stringify({
            id: "post4",
            channel_id: "dm1",
            user_id: "another_bot",
            root_id: "",
            message: "automated message",
            props: { from_bot: "true" },
          }),
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inbound.length, 0, "webhook and bot posts should be filtered");

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("createMattermostAdapter channel messages require groupsEnabled and @mention", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  let wsInstance;

  class MockWebSocket {
    constructor() {
      this.listeners = {};
      wsInstance = this;
      queueMicrotask(() => this._emit("open", {}));
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => this._emit("message", { data: JSON.stringify({ event: "hello" }) }));
      }
    }
    close() { this._emit("close", { code: 1000, reason: "" }); }
    _emit(event, data) { for (const h of this.listeners[event] || []) h(data); }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    // With groupsEnabled=false, channel messages should be ignored
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: false },
      logger,
      async (msg) => inbound.push(msg),
    );

    await adapter.start();

    // Open channel message with @mention but groups disabled
    wsInstance._emit("message", {
      data: JSON.stringify({
        event: "posted",
        data: {
          channel_type: "O",
          post: JSON.stringify({
            id: "post5",
            channel_id: "ch1",
            user_id: "user1",
            root_id: "",
            message: "@testbot run tests",
            props: {},
          }),
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inbound.length, 0, "channel message with groups disabled should be ignored");

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("createMattermostAdapter channel messages with groupsEnabled and @mention work", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  let wsInstance;

  class MockWebSocket {
    constructor() {
      this.listeners = {};
      wsInstance = this;
      queueMicrotask(() => this._emit("open", {}));
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => this._emit("message", { data: JSON.stringify({ event: "hello" }) }));
      }
    }
    close() { this._emit("close", { code: 1000, reason: "" }); }
    _emit(event, data) { for (const h of this.listeners[event] || []) h(data); }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: true },
      logger,
      async (msg) => inbound.push(msg),
    );

    await adapter.start();

    // Open channel with @mention and groups enabled
    wsInstance._emit("message", {
      data: JSON.stringify({
        event: "posted",
        data: {
          channel_type: "O",
          post: JSON.stringify({
            id: "post6",
            channel_id: "ch1",
            user_id: "user1",
            root_id: "",
            message: "@testbot run tests",
            props: {},
          }),
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].text, "run tests"); // Mention stripped
    assert.equal(inbound[0].peerId, "ch1|post6");

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("createMattermostAdapter group DMs always respond", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  let wsInstance;

  class MockWebSocket {
    constructor() {
      this.listeners = {};
      wsInstance = this;
      queueMicrotask(() => this._emit("open", {}));
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => this._emit("message", { data: JSON.stringify({ event: "hello" }) }));
      }
    }
    close() { this._emit("close", { code: 1000, reason: "" }); }
    _emit(event, data) { for (const h of this.listeners[event] || []) h(data); }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: false }, // Even with groups disabled, G should work
      logger,
      async (msg) => inbound.push(msg),
    );

    await adapter.start();

    // Group DM (channel_type "G") should always respond
    wsInstance._emit("message", {
      data: JSON.stringify({
        event: "posted",
        data: {
          channel_type: "G",
          post: JSON.stringify({
            id: "post7",
            channel_id: "group_dm_1",
            user_id: "user1",
            root_id: "",
            message: "hello everyone",
            props: {},
          }),
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].text, "hello everyone");

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("createMattermostAdapter outbound sendText works", async () => {
  const logger = createLoggerStub();
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const posts = [];

  let wsInstance;

  class MockWebSocket {
    constructor() {
      this.listeners = {};
      wsInstance = this;
      queueMicrotask(() => this._emit("open", {}));
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => this._emit("message", { data: JSON.stringify({ event: "hello" }) }));
      }
    }
    close() { this._emit("close", { code: 1000, reason: "" }); }
    _emit(event, data) { for (const h of this.listeners[event] || []) h(data); }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.endsWith("/api/v4/posts") && opts?.method === "POST") {
      const body = JSON.parse(opts.body);
      posts.push(body);
      return new Response(
        JSON.stringify({ id: "new_post", channel_id: body.channel_id, message: body.message }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: false },
      logger,
      async () => {},
    );

    await adapter.start();

    // Send to DM
    await adapter.sendText("dm_ch1", "hello there");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].channel_id, "dm_ch1");
    assert.equal(posts[0].message, "hello there");
    assert.equal(posts[0].root_id, undefined);

    // Send to thread
    await adapter.sendText("ch1|root_post_123", "thread reply");
    assert.equal(posts.length, 2);
    assert.equal(posts[1].channel_id, "ch1");
    assert.equal(posts[1].message, "thread reply");
    assert.equal(posts[1].root_id, "root_post_123");

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("createMattermostAdapter sendMessage with file upload", async () => {
  const logger = createLoggerStub();
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const posts = [];

  let wsInstance;

  class MockWebSocket {
    constructor() {
      this.listeners = {};
      wsInstance = this;
      queueMicrotask(() => this._emit("open", {}));
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => this._emit("message", { data: JSON.stringify({ event: "hello" }) }));
      }
    }
    close() { this._emit("close", { code: 1000, reason: "" }); }
    _emit(event, data) { for (const h of this.listeners[event] || []) h(data); }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.endsWith("/api/v4/files") && opts?.method === "POST") {
      return new Response(
        JSON.stringify({ file_infos: [{ id: "file1", name: "test.txt", size: 5, mime_type: "text/plain" }] }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.endsWith("/api/v4/posts") && opts?.method === "POST") {
      const body = JSON.parse(opts.body);
      posts.push(body);
      return new Response(
        JSON.stringify({ id: "new_post", channel_id: body.channel_id }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  // Create a temp file
  const tmpFile = path.join(os.tmpdir(), `opencode-router-mm-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, "hello");

  try {
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: false },
      logger,
      async () => {},
    );

    await adapter.start();

    const result = await adapter.sendMessage("dm_ch1", {
      parts: [{ type: "file", filePath: tmpFile }],
    });

    assert.equal(result.sentParts, 1);
    assert.equal(result.attemptedParts, 1);
    assert.equal(result.partResults[0].sent, true);
    // Post should have been created with file_ids
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].file_ids, ["file1"]);

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    fs.unlinkSync(tmpFile);
  }
});

test("createMattermostAdapter threaded messages use root_id", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  let wsInstance;

  class MockWebSocket {
    constructor() {
      this.listeners = {};
      wsInstance = this;
      queueMicrotask(() => this._emit("open", {}));
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => this._emit("message", { data: JSON.stringify({ event: "hello" }) }));
      }
    }
    close() { this._emit("close", { code: 1000, reason: "" }); }
    _emit(event, data) { for (const h of this.listeners[event] || []) h(data); }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: false },
      logger,
      async (msg) => inbound.push(msg),
    );

    await adapter.start();

    // Threaded message (has root_id)
    wsInstance._emit("message", {
      data: JSON.stringify({
        event: "posted",
        data: {
          channel_type: "D",
          post: JSON.stringify({
            id: "reply_post_1",
            channel_id: "dm1",
            user_id: "user1",
            root_id: "root_post_1",
            message: "reply in thread",
            props: {},
          }),
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].peerId, "dm1|root_post_1"); // Uses root_id, not post id

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("createMattermostAdapter downloads inbound files into media store", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  let wsInstance;

  class MockWebSocket {
    constructor() {
      this.listeners = {};
      wsInstance = this;
      queueMicrotask(() => this._emit("open", {}));
    }
    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }
    send(data) {
      const parsed = JSON.parse(data);
      if (parsed.action === "authentication_challenge") {
        queueMicrotask(() => this._emit("message", { data: JSON.stringify({ event: "hello" }) }));
      }
    }
    close() { this._emit("close", { code: 1000, reason: "" }); }
    _emit(event, data) { for (const h of this.listeners[event] || []) h(data); }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-router-mm-media-"));
  const mediaStore = new MediaStore(path.join(tempDir, "media"));
  await mediaStore.ensureReady();

  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: "bot123", username: "testbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.includes("/api/v4/files/")) {
      return new Response("downloaded-mm-file", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const adapter = createMattermostAdapter(
      { id: "default", serverUrl: "https://mm.example.com", accessToken: "tok-test" },
      { groupsEnabled: false },
      logger,
      async (msg) => inbound.push(msg),
      mediaStore,
    );

    await adapter.start();

    wsInstance._emit("message", {
      data: JSON.stringify({
        event: "posted",
        data: {
          channel_type: "D",
          post: JSON.stringify({
            id: "post_with_file",
            channel_id: "dm1",
            user_id: "user1",
            root_id: "",
            message: "",
            file_ids: ["file_abc"],
            props: {},
          }),
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(inbound.length, 1);
    const mediaPart = inbound[0].parts.find((p) => p.type === "media");
    assert.ok(mediaPart);
    assert.equal(mediaPart.media.status, "ready");
    assert.ok(mediaPart.media.filePath);
    assert.equal(fs.existsSync(mediaPart.media.filePath), true);
    assert.equal(fs.readFileSync(mediaPart.media.filePath, "utf8"), "downloaded-mm-file");

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});
