// Normalizes outbound text so re-posts that differ only in timestamps, dates,
// Slack message ids or permalinks hash to the same value. Every other number
// is kept: "p=0.03" and "p=0.04" stay different messages.
import { createHash } from "node:crypto";

const ISO_DATE_RE =
  /(?<![\w-])\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?(?![\w-])/g;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|utc|et|pt|z)?\b/g;
const SLACK_PERMALINK_RE = /https?:\/\/[^\s<>|]*slack\.com\/archives\/[^\s<>|]*/g;
const SLACK_TS_RE = /\b\d{10}\.\d{6}\b/g;
const WHITESPACE_RE = /\s+/g;

export function normalizeOutboundContent(content: string): string {
  return content
    .toLowerCase()
    .replace(SLACK_PERMALINK_RE, "")
    .replace(ISO_DATE_RE, "")
    .replace(SLACK_TS_RE, "")
    .replace(CLOCK_TIME_RE, "")
    .replace(WHITESPACE_RE, "");
}

export function fingerprintOutboundContent(content: string): string {
  return createHash("sha256").update(normalizeOutboundContent(content)).digest("hex");
}
