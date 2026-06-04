import assert from "node:assert/strict";
import test from "node:test";

import { formatRelativeAge } from "../dist/bridge.js";

const NOW = 1_780_000_000_000; // arbitrary fixed reference

test("formatRelativeAge: seconds", () => {
  assert.equal(formatRelativeAge(NOW - 5_000, NOW), "5s ago");
  assert.equal(formatRelativeAge(NOW - 59_000, NOW), "59s ago");
});

test("formatRelativeAge: minutes", () => {
  assert.equal(formatRelativeAge(NOW - 60_000, NOW), "1m ago");
  assert.equal(formatRelativeAge(NOW - 30 * 60_000, NOW), "30m ago");
});

test("formatRelativeAge: hours", () => {
  assert.equal(formatRelativeAge(NOW - 60 * 60_000, NOW), "1h ago");
  assert.equal(formatRelativeAge(NOW - 23 * 60 * 60_000, NOW), "23h ago");
});

test("formatRelativeAge: days", () => {
  assert.equal(formatRelativeAge(NOW - 24 * 60 * 60_000, NOW), "1d ago");
  assert.equal(formatRelativeAge(NOW - 29 * 24 * 60 * 60_000, NOW), "29d ago");
});

test("formatRelativeAge: months", () => {
  assert.equal(formatRelativeAge(NOW - 30 * 24 * 60 * 60_000, NOW), "1mo ago");
  assert.equal(formatRelativeAge(NOW - 11 * 30 * 24 * 60 * 60_000, NOW), "11mo ago");
});

test("formatRelativeAge: years", () => {
  assert.equal(formatRelativeAge(NOW - 12 * 30 * 24 * 60 * 60_000, NOW), "1y ago");
  assert.equal(formatRelativeAge(NOW - 3 * 12 * 30 * 24 * 60 * 60_000, NOW), "3y ago");
});

test("formatRelativeAge: zero/negative timestamps marked unknown", () => {
  // Defends against opencode returning a session with no `time.updated` field.
  assert.equal(formatRelativeAge(0, NOW), "unknown");
  assert.equal(formatRelativeAge(-1, NOW), "unknown");
});

test("formatRelativeAge: future timestamp clamps to 0s ago (clock skew)", () => {
  // If a session's updated_at is slightly in the future (clock drift between
  // opencode and router), we don't want to print "-3s ago".
  assert.equal(formatRelativeAge(NOW + 5_000, NOW), "0s ago");
});
