import type { ChannelName } from "./config.js";

// --- Types ---

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionAnswer = string[];

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
};

export type PendingQuestion = {
  requestID: string;
  sessionID: string;
  questions: QuestionInfo[];
  currentIndex: number;
  answers: QuestionAnswer[];
  directory: string;
  channel: ChannelName;
  identityId: string;
  peerId: string;
  peerKey: string;
  createdAt: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
  resolved: boolean;
};

// --- Formatting ---

export function formatQuestionMessage(
  question: QuestionInfo,
  index: number,
  total: number,
): string {
  const lines: string[] = [];

  const title = question.header?.trim() || question.question?.trim() || "Question";
  const stepLabel = total > 1 ? ` ${index + 1}/${total}` : "";
  lines.push(`[Question${stepLabel}] ${title}`);

  if (question.header?.trim() && question.question?.trim() && question.header.trim() !== question.question.trim()) {
    lines.push(question.question.trim());
  }

  if (question.options.length > 0) {
    for (let i = 0; i < question.options.length; i++) {
      const opt = question.options[i];
      const desc = opt.description?.trim() ? ` — ${opt.description.trim()}` : "";
      lines.push(`${i + 1}. ${opt.label}${desc}`);
    }
  }

  const isCustom = question.custom === undefined || question.custom === true;

  if (question.options.length > 0) {
    if (question.multiple) {
      lines.push("Reply with numbers separated by commas (e.g. 1,3).");
    } else if (isCustom) {
      lines.push("Reply with a number, or type your own answer.");
    } else {
      lines.push("Reply with a number.");
    }
  } else if (isCustom) {
    lines.push("Type your answer.");
  }

  lines.push("Send /skip to skip this question.");

  return lines.join("\n");
}

// --- Parsing ---

export type ParseResult =
  | { type: "answer"; answer: QuestionAnswer }
  | { type: "reject" }
  | { type: "invalid"; reason: string }
  | { type: "ignore" };

export function parseQuestionAnswer(
  rawInput: string,
  question: QuestionInfo,
): ParseResult {
  const input = normalizeWhitespace(rawInput);

  if (!input) {
    return { type: "ignore" };
  }

  const lower = input.toLowerCase();
  if (lower === "/skip" || lower === "/reject") {
    return { type: "reject" };
  }

  const isCustom = question.custom === undefined || question.custom === true;
  const options = question.options ?? [];

  // No options: accept any text if custom enabled
  if (options.length === 0) {
    if (isCustom) {
      return { type: "answer", answer: [input] };
    }
    return { type: "invalid", reason: "No options available and custom input is disabled." };
  }

  // Check exact label match first (case-insensitive) — avoids "1password" ambiguity
  const labelMatch = options.find(
    (opt) => opt.label.trim().toLowerCase() === lower,
  );
  if (labelMatch) {
    return { type: "answer", answer: [labelMatch.label] };
  }

  // Try number parsing (comma-separated only)
  const numberPattern = /^\d+(\s*,\s*\d+)*$/;
  if (numberPattern.test(input)) {
    const nums = input.split(",").map((s) => Number.parseInt(s.trim(), 10));
    const validNums = nums.filter((n) => n >= 1 && n <= options.length);

    if (validNums.length === 0) {
      // All numbers out of range
      if (isCustom) {
        return { type: "answer", answer: [input] };
      }
      return { type: "invalid", reason: `Invalid option. Choose 1–${options.length}.` };
    }

    if (!question.multiple && nums.length > 1) {
      // Single-select but multiple numbers given — take first
      return { type: "answer", answer: [options[validNums[0] - 1].label] };
    }

    const unique = [...new Set(validNums)];
    const labels = unique.map((n) => options[n - 1].label);
    return { type: "answer", answer: labels };
  }

  // Free text fallback
  if (isCustom) {
    return { type: "answer", answer: [input] };
  }

  return { type: "invalid", reason: `Invalid option. Choose 1–${options.length}, or type an option label.` };
}

// --- Helpers ---

function normalizeWhitespace(input: string): string {
  return input.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ").trim().replace(/\s+/g, " ");
}

export function questionPeerKey(
  channel: ChannelName,
  identityId: string,
  peerKey: string,
): string {
  return `${channel}:${identityId}:${peerKey}`;
}
