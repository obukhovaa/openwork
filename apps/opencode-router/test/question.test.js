import assert from "node:assert/strict";
import test from "node:test";

import {
  formatQuestionMessage,
  parseQuestionAnswer,
  questionPeerKey,
} from "../dist/question.js";

// ===========================================================================
// formatQuestionMessage
// ===========================================================================

test("formatQuestionMessage: single-select with options", () => {
  const msg = formatQuestionMessage(
    {
      question: "Which database should I use?",
      options: [
        { label: "PostgreSQL", description: "Best for relational data" },
        { label: "MySQL", description: "Wide hosting support" },
        { label: "SQLite", description: "Zero-config, file-based" },
      ],
    },
    0,
    1,
  );
  assert.ok(msg.includes("[Question]"));
  assert.ok(msg.includes("Which database should I use?"));
  assert.ok(msg.includes("1. PostgreSQL — Best for relational data"));
  assert.ok(msg.includes("2. MySQL — Wide hosting support"));
  assert.ok(msg.includes("3. SQLite — Zero-config, file-based"));
  assert.ok(msg.includes("Reply with a number, or type your own answer."));
  assert.ok(msg.includes("/skip"));
});

test("formatQuestionMessage: multi-select with options", () => {
  const msg = formatQuestionMessage(
    {
      question: "Select features",
      options: [
        { label: "Dark mode", description: "" },
        { label: "Notifications", description: "Push notifications" },
      ],
      multiple: true,
    },
    0,
    1,
  );
  assert.ok(msg.includes("Reply with numbers separated by commas"));
});

test("formatQuestionMessage: free-text only (no options)", () => {
  const msg = formatQuestionMessage(
    {
      question: "What should the commit message be?",
      options: [],
      custom: true,
    },
    0,
    1,
  );
  assert.ok(msg.includes("What should the commit message be?"));
  assert.ok(msg.includes("Type your answer."));
  assert.ok(!msg.includes("1."));
});

test("formatQuestionMessage: multi-step progress", () => {
  const msg = formatQuestionMessage(
    {
      question: "Choose deployment target",
      options: [{ label: "Production", description: "us-east-1" }],
    },
    1,
    3,
  );
  assert.ok(msg.includes("[Question 2/3]"));
});

test("formatQuestionMessage: uses header when present", () => {
  const msg = formatQuestionMessage(
    {
      question: "This is a very long question explaining everything in detail",
      header: "Database",
      options: [{ label: "PostgreSQL", description: "" }],
    },
    0,
    1,
  );
  assert.ok(msg.includes("[Question] Database"));
  assert.ok(msg.includes("This is a very long question"));
});

test("formatQuestionMessage: custom=false hides free-text hint", () => {
  const msg = formatQuestionMessage(
    {
      question: "Pick one",
      options: [{ label: "A", description: "" }, { label: "B", description: "" }],
      custom: false,
    },
    0,
    1,
  );
  assert.ok(msg.includes("Reply with a number."));
  assert.ok(!msg.includes("type your own"));
});

// ===========================================================================
// parseQuestionAnswer
// ===========================================================================

test("parseQuestionAnswer: single number", () => {
  const result = parseQuestionAnswer("1", {
    question: "Pick",
    options: [
      { label: "PostgreSQL", description: "" },
      { label: "MySQL", description: "" },
    ],
  });
  assert.deepEqual(result, { type: "answer", answer: ["PostgreSQL"] });
});

test("parseQuestionAnswer: number 2", () => {
  const result = parseQuestionAnswer("2", {
    question: "Pick",
    options: [
      { label: "PostgreSQL", description: "" },
      { label: "MySQL", description: "" },
    ],
  });
  assert.deepEqual(result, { type: "answer", answer: ["MySQL"] });
});

test("parseQuestionAnswer: comma-separated multi-select", () => {
  const result = parseQuestionAnswer("1,3", {
    question: "Pick",
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
      { label: "C", description: "" },
    ],
    multiple: true,
  });
  assert.deepEqual(result, { type: "answer", answer: ["A", "C"] });
});

test("parseQuestionAnswer: comma-separated with spaces", () => {
  const result = parseQuestionAnswer("1, 3", {
    question: "Pick",
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
      { label: "C", description: "" },
    ],
    multiple: true,
  });
  assert.deepEqual(result, { type: "answer", answer: ["A", "C"] });
});

test("parseQuestionAnswer: exact label match (case-insensitive)", () => {
  const result = parseQuestionAnswer("postgresql", {
    question: "Pick",
    options: [
      { label: "PostgreSQL", description: "" },
      { label: "MySQL", description: "" },
    ],
  });
  assert.deepEqual(result, { type: "answer", answer: ["PostgreSQL"] });
});

test("parseQuestionAnswer: label match takes priority over number", () => {
  // Option label "1password" should match as label, not as number 1
  const result = parseQuestionAnswer("1password", {
    question: "Pick",
    options: [
      { label: "bitwarden", description: "" },
      { label: "1password", description: "" },
    ],
  });
  assert.deepEqual(result, { type: "answer", answer: ["1password"] });
});

test("parseQuestionAnswer: /skip rejects", () => {
  const result = parseQuestionAnswer("/skip", {
    question: "Pick",
    options: [{ label: "A", description: "" }],
  });
  assert.deepEqual(result, { type: "reject" });
});

test("parseQuestionAnswer: /reject rejects", () => {
  const result = parseQuestionAnswer("/REJECT", {
    question: "Pick",
    options: [{ label: "A", description: "" }],
  });
  assert.deepEqual(result, { type: "reject" });
});

test("parseQuestionAnswer: empty input ignored", () => {
  const result = parseQuestionAnswer("", {
    question: "Pick",
    options: [{ label: "A", description: "" }],
  });
  assert.deepEqual(result, { type: "ignore" });
});

test("parseQuestionAnswer: whitespace-only ignored", () => {
  const result = parseQuestionAnswer("   ", {
    question: "Pick",
    options: [{ label: "A", description: "" }],
  });
  assert.deepEqual(result, { type: "ignore" });
});

test("parseQuestionAnswer: free text when custom=true", () => {
  const result = parseQuestionAnswer("use postgres please", {
    question: "Pick",
    options: [
      { label: "PostgreSQL", description: "" },
      { label: "MySQL", description: "" },
    ],
    custom: true,
  });
  assert.deepEqual(result, { type: "answer", answer: ["use postgres please"] });
});

test("parseQuestionAnswer: free text when custom=undefined (default true)", () => {
  const result = parseQuestionAnswer("something custom", {
    question: "Pick",
    options: [{ label: "A", description: "" }],
  });
  assert.deepEqual(result, { type: "answer", answer: ["something custom"] });
});

test("parseQuestionAnswer: invalid when custom=false", () => {
  const result = parseQuestionAnswer("some random text", {
    question: "Pick",
    options: [{ label: "A", description: "" }],
    custom: false,
  });
  assert.equal(result.type, "invalid");
});

test("parseQuestionAnswer: out-of-range number with custom=true -> free text", () => {
  const result = parseQuestionAnswer("5", {
    question: "Pick",
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
    ],
    custom: true,
  });
  assert.deepEqual(result, { type: "answer", answer: ["5"] });
});

test("parseQuestionAnswer: out-of-range number with custom=false -> invalid", () => {
  const result = parseQuestionAnswer("5", {
    question: "Pick",
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
    ],
    custom: false,
  });
  assert.equal(result.type, "invalid");
});

test("parseQuestionAnswer: multiple numbers when multiple=false -> take first", () => {
  const result = parseQuestionAnswer("1,3", {
    question: "Pick",
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
      { label: "C", description: "" },
    ],
    multiple: false,
  });
  assert.deepEqual(result, { type: "answer", answer: ["A"] });
});

test("parseQuestionAnswer: no options, custom=true -> accept any text", () => {
  const result = parseQuestionAnswer("my commit message", {
    question: "Enter commit message",
    options: [],
    custom: true,
  });
  assert.deepEqual(result, { type: "answer", answer: ["my commit message"] });
});

test("parseQuestionAnswer: no options, custom=false -> invalid", () => {
  const result = parseQuestionAnswer("hello", {
    question: "Q",
    options: [],
    custom: false,
  });
  assert.equal(result.type, "invalid");
});

test("parseQuestionAnswer: deduplicate multi-select numbers", () => {
  const result = parseQuestionAnswer("1,1,2", {
    question: "Pick",
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
    ],
    multiple: true,
  });
  assert.deepEqual(result, { type: "answer", answer: ["A", "B"] });
});

test("parseQuestionAnswer: unicode whitespace normalized", () => {
  // Non-breaking space (U+00A0) should be normalized
  const result = parseQuestionAnswer("1\u00A0", {
    question: "Pick",
    options: [{ label: "A", description: "" }],
  });
  assert.deepEqual(result, { type: "answer", answer: ["A"] });
});

// ===========================================================================
// questionPeerKey
// ===========================================================================

test("questionPeerKey builds correct key", () => {
  assert.equal(questionPeerKey("telegram", "default", "12345"), "telegram:default:12345");
  assert.equal(questionPeerKey("slack", "env", "D123"), "slack:env:D123");
  assert.equal(questionPeerKey("mattermost", "mm1", "ch|post"), "mattermost:mm1:ch|post");
});

// ===========================================================================
// Existing tests still pass (regression check)
// ===========================================================================

test("parseQuestionAnswer: space-separated numbers treated as free text (not multi-select)", () => {
  // "1 3" is NOT comma-separated, so it's free text
  const result = parseQuestionAnswer("1 3", {
    question: "Pick",
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
      { label: "C", description: "" },
    ],
    multiple: true,
    custom: true,
  });
  assert.deepEqual(result, { type: "answer", answer: ["1 3"] });
});

test("parseQuestionAnswer: space-separated numbers without custom -> invalid", () => {
  const result = parseQuestionAnswer("1 3", {
    question: "Pick",
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
      { label: "C", description: "" },
    ],
    multiple: true,
    custom: false,
  });
  assert.equal(result.type, "invalid");
});
