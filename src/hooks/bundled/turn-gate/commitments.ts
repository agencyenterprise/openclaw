// Commitment phrases: the words a turn uses to promise future work ("Next:",
// "I'll start the harvest"). The list is config-extensible because the phrasing
// drifts with the model, not with the rule the hook enforces.

export const DEFAULT_COMMITMENT_PHRASES = [
  "Next:",
  "I will",
  "I'll",
  "will start",
  "starting now",
  "armed",
  "scheduled",
];

export type CompiledCommitment = {
  phrase: string;
  pattern: RegExp;
};

const CURLY_APOSTROPHE_RE = /’/g;

/** The model writes "I’ll" with a curly apostrophe; an operator configures "I'll". */
function normalizeApostrophes(text: string): string {
  return text.replace(CURLY_APOSTROPHE_RE, "'");
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A phrase that starts or ends on a word character is anchored to a word
 * boundary, so "armed" is a commitment and "disarmed" is not. Punctuated
 * phrases such as "Next:" keep their own edges.
 */
function toBoundedSource(phrase: string): string {
  const leading = /^\w/.test(phrase) ? "\\b" : "";
  const trailing = /\w$/.test(phrase) ? "\\b" : "";
  return `${leading}${escapeRegExp(phrase)}${trailing}`;
}

/**
 * Phrases are matched literally and case-insensitively: an operator adding one
 * writes the words the model says, not a regular expression they have to debug.
 * A blank configured phrase is dropped, because an empty pattern matches every
 * turn and would mark the whole workspace as committing.
 */
export function compileCommitments(phrases: string[]): CompiledCommitment[] {
  return phrases
    .filter((phrase) => phrase.trim().length > 0)
    .map((phrase) => ({
      phrase,
      pattern: new RegExp(toBoundedSource(normalizeApostrophes(phrase)), "i"),
    }));
}

/** Every configured phrase the text commits to, in configured order. */
export function findCommitments(
  text: string | undefined,
  compiled: CompiledCommitment[],
): string[] {
  if (!text) {
    return [];
  }
  const normalized = normalizeApostrophes(text);
  return compiled.filter((entry) => entry.pattern.test(normalized)).map((entry) => entry.phrase);
}
