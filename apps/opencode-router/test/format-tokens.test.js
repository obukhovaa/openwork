import assert from "node:assert/strict";
import test from "node:test";

import { formatTokens } from "../dist/bridge.js";

test("formatTokens: small numbers passed through", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(123), "123");
  assert.equal(formatTokens(999), "999");
});

test("formatTokens: thousands with k suffix", () => {
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(8192), "8.2k"); // common context size
  assert.equal(formatTokens(64000), "64k");
});

test("formatTokens: large k values lose decimal", () => {
  // 200k context (claude 4.5 era) should render as "200k", not "200.0k"
  assert.equal(formatTokens(200000), "200k");
  assert.equal(formatTokens(500000), "500k");
});

test("formatTokens: millions with M suffix", () => {
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(2_000_000), "2M"); // gemini 2M context
});

test("formatTokens: negative/NaN/Infinity clamp to 0", () => {
  // Defends against opencode returning a nonsense Limit field.
  assert.equal(formatTokens(-1), "0");
  assert.equal(formatTokens(NaN), "0");
  assert.equal(formatTokens(Infinity), "0");
});
