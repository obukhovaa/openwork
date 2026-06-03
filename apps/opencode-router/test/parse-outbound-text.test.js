import assert from "node:assert/strict";
import test from "node:test";

import { parseOutboundText } from "../dist/bridge.js";

test("parseOutboundText: pure text passes through as one text part", () => {
  assert.deepEqual(parseOutboundText("hello world"), [
    { type: "text", text: "hello world" },
  ]);
});

test("parseOutboundText: lone FILE: line becomes a single file part", () => {
  assert.deepEqual(parseOutboundText("FILE:/abs/path/img.png"), [
    { type: "file", filePath: "/abs/path/img.png" },
  ]);
});

test("parseOutboundText: prose then FILE: line yields text + file", () => {
  // The bug we shipped: agent wrote a caption then the FILE: line, and the
  // whole thing was delivered as text. The new parser must split it.
  const result = parseOutboundText("Here you go:\nFILE:/abs/a.png");
  assert.deepEqual(result, [
    { type: "text", text: "Here you go:" },
    { type: "file", filePath: "/abs/a.png" },
  ]);
});

test("parseOutboundText: multiple FILE: lines yield multiple file parts", () => {
  const result = parseOutboundText(
    "Two assets:\nFILE:/abs/a.png\nFILE:/abs/b.png",
  );
  assert.deepEqual(result, [
    { type: "text", text: "Two assets:" },
    { type: "file", filePath: "/abs/a.png" },
    { type: "file", filePath: "/abs/b.png" },
  ]);
});

test("parseOutboundText: FILE: line in the middle splits surrounding text", () => {
  const result = parseOutboundText(
    "Before:\nFILE:/abs/a.png\nAfter caption.",
  );
  assert.deepEqual(result, [
    { type: "text", text: "Before:" },
    { type: "file", filePath: "/abs/a.png" },
    { type: "text", text: "After caption." },
  ]);
});

test("parseOutboundText: FILE: with paths containing spaces (iCloud, etc.)", () => {
  const path =
    "/Users/x/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal/__assets/llm_problem_2030.png";
  const result = parseOutboundText(`Держи:\nFILE:${path}`);
  assert.deepEqual(result, [
    { type: "text", text: "Держи:" },
    { type: "file", filePath: path },
  ]);
});

test("parseOutboundText: empty FILE: line is preserved as text (avoid sending empty file)", () => {
  // A bare `FILE:` with no path shouldn't trigger an attachment.
  const result = parseOutboundText("Something went wrong:\nFILE:");
  // The FILE: with empty path stays in the buffer as literal text.
  assert.deepEqual(result, [{ type: "text", text: "Something went wrong:\nFILE:" }]);
});

test("parseOutboundText: 'FILE:' embedded mid-line in prose stays text (no false positive)", () => {
  // The marker is anchored to start-of-line. Mid-line mentions stay as text.
  const result = parseOutboundText("As discussed FILE:/wrong/path is not detected.");
  assert.deepEqual(result, [
    { type: "text", text: "As discussed FILE:/wrong/path is not detected." },
  ]);
});

test("parseOutboundText: no FILE: marker at all takes the fast path", () => {
  // The function has an early-return for the no-FILE: case; verify it still
  // returns the canonical single-text-part shape.
  const result = parseOutboundText("just\nmultiline\ntext");
  assert.deepEqual(result, [{ type: "text", text: "just\nmultiline\ntext" }]);
});
