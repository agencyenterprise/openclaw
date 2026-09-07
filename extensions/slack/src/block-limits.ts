// Slack helper module bounds Block Kit payloads to the documented API limits.
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import type { SlackBlock } from "./blocks-render.js";
import { SLACK_HEADER_TEXT_MAX, SLACK_SECTION_TEXT_MAX } from "./presentation.js";

export const SLACK_SECTION_FIELDS_MAX = 10;
export const SLACK_SECTION_FIELD_TEXT_MAX = 2000;
export const SLACK_CONTEXT_ELEMENTS_MAX = 10;

export type SlackBlockLimitViolation = {
  index: number;
  blockType: string;
  reason: string;
};

type SlackTextObject = { type?: unknown; text?: unknown };

function readTextLength(value: unknown): number | undefined {
  const text = (value as SlackTextObject | undefined)?.text;
  return typeof text === "string" ? text.length : undefined;
}

function isEmptyText(value: unknown): boolean {
  const text = (value as SlackTextObject | undefined)?.text;
  return typeof text === "string" && text.trim().length === 0;
}

function checkHeader(block: Record<string, unknown>): string[] {
  const length = readTextLength(block.text);
  if (length === undefined) {
    return ["header is missing a text object"];
  }
  if (isEmptyText(block.text)) {
    return ["header text is empty"];
  }
  return length > SLACK_HEADER_TEXT_MAX
    ? [`header text is ${String(length)} chars (max ${String(SLACK_HEADER_TEXT_MAX)})`]
    : [];
}

function checkSection(block: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const textLength = readTextLength(block.text);
  if (textLength !== undefined && isEmptyText(block.text)) {
    reasons.push("section text is empty");
  }
  if (textLength !== undefined && textLength > SLACK_SECTION_TEXT_MAX) {
    reasons.push(
      `section text is ${String(textLength)} chars (max ${String(SLACK_SECTION_TEXT_MAX)})`,
    );
  }
  const fields = block.fields;
  if (fields === undefined) {
    if (textLength === undefined) {
      reasons.push("section needs text or fields");
    }
    return reasons;
  }
  if (!Array.isArray(fields)) {
    reasons.push("section fields must be an array");
    return reasons;
  }
  if (fields.length === 0) {
    reasons.push("section fields must not be empty");
  }
  if (fields.length > SLACK_SECTION_FIELDS_MAX) {
    reasons.push(
      `section has ${String(fields.length)} fields (max ${String(SLACK_SECTION_FIELDS_MAX)})`,
    );
  }
  fields.forEach((field, fieldIndex) => {
    const fieldLength = readTextLength(field);
    if (fieldLength === undefined) {
      reasons.push(`field ${String(fieldIndex)} is missing text`);
      return;
    }
    if (isEmptyText(field)) {
      reasons.push(`field ${String(fieldIndex)} is empty`);
      return;
    }
    if (fieldLength > SLACK_SECTION_FIELD_TEXT_MAX) {
      reasons.push(
        `field ${String(fieldIndex)} is ${String(fieldLength)} chars (max ${String(SLACK_SECTION_FIELD_TEXT_MAX)})`,
      );
    }
  });
  return reasons;
}

function checkContext(block: Record<string, unknown>): string[] {
  const elements = block.elements;
  if (!Array.isArray(elements)) {
    return ["context elements must be an array"];
  }
  const reasons: string[] = [];
  if (elements.length > SLACK_CONTEXT_ELEMENTS_MAX) {
    reasons.push(
      `context has ${String(elements.length)} elements (max ${String(SLACK_CONTEXT_ELEMENTS_MAX)})`,
    );
  }
  elements.forEach((element, elementIndex) => {
    const length = readTextLength(element);
    if (length !== undefined && length > SLACK_SECTION_TEXT_MAX) {
      reasons.push(
        `context element ${String(elementIndex)} is ${String(length)} chars (max ${String(SLACK_SECTION_TEXT_MAX)})`,
      );
    }
  });
  return reasons;
}

function checkBlock(block: SlackBlock): string[] {
  const record = block as unknown as Record<string, unknown>;
  switch (record.type) {
    case "header":
      return checkHeader(record);
    case "section":
      return checkSection(record);
    case "context":
      return checkContext(record);
    default:
      return [];
  }
}

/** Report every Slack Block Kit limit a rendered block list breaks. */
export function validateSlackBlockLimits(
  blocks: readonly SlackBlock[],
): SlackBlockLimitViolation[] {
  const violations: SlackBlockLimitViolation[] = blocks.flatMap((block, index) => {
    const blockType = String((block as unknown as Record<string, unknown>).type ?? "unknown");
    return checkBlock(block).map((reason) => ({ index, blockType, reason }));
  });
  if (blocks.length > SLACK_MAX_BLOCKS) {
    violations.push({
      index: -1,
      blockType: "message",
      reason: `message has ${String(blocks.length)} blocks (max ${String(SLACK_MAX_BLOCKS)})`,
    });
  }
  return violations;
}
