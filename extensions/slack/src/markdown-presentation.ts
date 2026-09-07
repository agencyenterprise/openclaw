// Slack plugin module turns an ordinary Markdown reply into scannable Block Kit.
import {
  SLACK_SECTION_FIELD_TEXT_MAX,
  SLACK_SECTION_FIELDS_MAX,
  validateSlackBlockLimits,
} from "./block-limits.js";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import type { SlackBlock } from "./blocks-render.js";
import { SLACK_HEADER_TEXT_MAX, SLACK_SECTION_TEXT_MAX } from "./presentation.js";
import { truncateSlackText } from "./truncate.js";

/** Per-message escape hatch: a reply that opens with this stays plain text. */
export const SLACK_REPLY_PLAIN_MARKER = "<!plain>";

/** The constitution bans this mention token, so such replies never reach Block Kit. */
export const SLACK_REPLY_BANNED_MENTION = "<@U02AX1XQ1>";

/** How a reply is laid out. */
export type SlackReplyPresentationMode = "structured-only" | "always" | "never";

export type SlackReplyPresentationSettings = {
  mode: SlackReplyPresentationMode;
  maxVisibleChars: number;
  maxListItems: number;
};

export const SLACK_REPLY_PRESENTATION_DEFAULTS: SlackReplyPresentationSettings = {
  mode: "structured-only",
  maxVisibleChars: 2500,
  maxListItems: 5,
};

export type SlackMarkdownPresentation =
  | { mode: "plain"; text: string }
  | { mode: "blocks"; blocks: SlackBlock[]; text: string };

const HEADLINE_BOLD_MAX = 150;
const OVERFLOW_BODY_SECTIONS = 2;
const NUMERIC_DENSE_MIN = 3;
const TABLE_FIELD_COLUMNS = 2;
const SHORT_REPLY_MAX = 400;
const STRUCTURED_LIST_MIN = 3;
const HEADED_SECTION_MIN = 2;
const CODE_FENCE = "```";

const HEADING_RE = /^ {0,3}#{1,6}\s+(.*)$/;
const BULLET_RE = /^\s*[-+•*]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|(.*)\|\s*$/;
const TABLE_RULE_RE = /^\s*\|[\s:|-]+\|?\s*$/;
const BOLD_ONLY_RE = /^\*\*?([^*]+?)\*\*?:?$/;
const CONTEXT_PREFIX_RE = /^(?:Files:|Evidence:|Artifacts:|Spend\b|Spent\b)/i;
const CONTEXT_PATH_RE =
  /\/(?:home|Users|root|workspace|opt|var|srv|mnt|etc)\/[A-Za-z0-9._\-/]*[A-Za-z0-9._\-/]/g;
const ARTIFACT_CODE_PATH_RE = /`([^`\n]*\/[^`\n]*)`/;
const NUMERIC_TOKEN_RE = /[-+−]?\d[\d,]*(?:\.\d+)?%?/g;
const CODE_SPAN_RE = /`[^`\n]*`/g;
// A verdict-bearing opener marks a result, status board or decision.
const VERDICT_HEADLINE_RE = /^.{0,120}?\b(?:decision|result|verdict|status|outcome)\b\s*:/i;

type ParsedChunk =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "bullets"; items: string[] }
  | { kind: "ordered"; items: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "code"; lines: string[] }
  | { kind: "context"; lines: string[] };

function readPositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Apply presentation defaults at read time, the way other channel options resolve. */
export function resolveSlackReplyPresentationSettings(
  config: Partial<SlackReplyPresentationSettings> | undefined,
): SlackReplyPresentationSettings {
  return {
    mode: config?.mode ?? SLACK_REPLY_PRESENTATION_DEFAULTS.mode,
    maxVisibleChars:
      readPositiveInteger(config?.maxVisibleChars) ??
      SLACK_REPLY_PRESENTATION_DEFAULTS.maxVisibleChars,
    maxListItems:
      readPositiveInteger(config?.maxListItems) ?? SLACK_REPLY_PRESENTATION_DEFAULTS.maxListItems,
  };
}

function countNumericTokens(text: string): number {
  return text.match(NUMERIC_TOKEN_RE)?.length ?? 0;
}

/** Apply a rewrite only to the parts of a line that sit outside inline code spans. */
function mapOutsideCodeSpans(text: string, rewrite: (part: string) => string): string {
  CODE_SPAN_RE.lastIndex = 0;
  const out: string[] = [];
  let cursor = 0;
  for (let match = CODE_SPAN_RE.exec(text); match; match = CODE_SPAN_RE.exec(text)) {
    out.push(rewrite(text.slice(cursor, match.index)), match[0]);
    cursor = match.index + match[0].length;
  }
  out.push(rewrite(text.slice(cursor)));
  return out.join("");
}

/**
 * Normalise Markdown emphasis to Slack mrkdwn. The renderer runs after Slack
 * escaping, so this deliberately rewrites markers only and never re-escapes.
 */
function toSlackMrkdwn(text: string): string {
  return mapOutsideCodeSpans(text, (part) =>
    part.replace(/\*\*([^*\n]+)\*\*/g, "*$1*").replace(/__([^_\n]+)__/g, "*$1*"),
  );
}

/** Strip emphasis markers and Slack entities for plain_text and notification text. */
function toPlainText(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== CODE_FENCE && !line.trim().startsWith(CODE_FENCE))
    .join("\n")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function isContextLine(line: string): boolean {
  const trimmed = line.trim();
  CONTEXT_PATH_RE.lastIndex = 0;
  return CONTEXT_PREFIX_RE.test(trimmed) || CONTEXT_PATH_RE.test(trimmed);
}

/** Split a table row on pipes that sit outside code spans and Slack angle tokens. */
function splitTableCells(inner: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  let inAngle = false;
  for (const character of inner) {
    if (character === "`") {
      inCode = !inCode;
    } else if (!inCode && character === "<") {
      inAngle = true;
    } else if (!inCode && character === ">") {
      inAngle = false;
    } else if (character === "|" && !inCode && !inAngle) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function parseTableRow(line: string): string[] | undefined {
  const inner = TABLE_ROW_RE.exec(line)?.[1];
  return inner === undefined ? undefined : splitTableCells(inner);
}

/** Split a paragraph's trailing file/spend/path lines into their own context chunk. */
function partitionParagraph(lines: readonly string[]): ParsedChunk[] {
  const body = lines.filter((line) => !isContextLine(line));
  const context = lines.filter((line) => isContextLine(line));
  const chunks: ParsedChunk[] = [];
  if (body.length > 0) {
    chunks.push({ kind: "paragraph", lines: body });
  }
  if (context.length > 0) {
    chunks.push({ kind: "context", lines: context });
  }
  return chunks;
}

/** Group reply lines into ordered chunks without losing author intent. */
function parseChunks(markdown: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let pending: ParsedChunk | undefined;
  const flush = () => {
    if (pending) {
      chunks.push(
        ...(pending.kind === "paragraph" ? partitionParagraph(pending.lines) : [pending]),
      );
      pending = undefined;
    }
  };
  const appendItem = (kind: "bullets" | "ordered", item: string) => {
    if (pending?.kind === kind) {
      pending.items.push(item);
      return;
    }
    flush();
    pending =
      kind === "bullets" ? { kind: "bullets", items: [item] } : { kind: "ordered", items: [item] };
  };

  let fence: { lines: string[] } | undefined;
  for (const line of markdown.split("\n")) {
    if (fence) {
      fence.lines.push(line);
      if (line.trim().startsWith(CODE_FENCE)) {
        chunks.push({ kind: "code", lines: fence.lines });
        fence = undefined;
      }
      continue;
    }
    if (line.trim().startsWith(CODE_FENCE)) {
      flush();
      fence = { lines: [line] };
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING_RE.exec(line)?.[1];
    if (heading) {
      flush();
      chunks.push({ kind: "heading", text: heading.trim() });
      continue;
    }
    const bullet = BULLET_RE.exec(line)?.[1];
    if (bullet !== undefined) {
      appendItem("bullets", bullet.trim());
      continue;
    }
    const ordered = ORDERED_RE.exec(line)?.[1];
    if (ordered !== undefined) {
      appendItem("ordered", ordered.trim());
      continue;
    }
    if (TABLE_RULE_RE.test(line)) {
      continue;
    }
    const row = parseTableRow(line);
    if (row) {
      if (pending?.kind === "table") {
        pending.rows.push(row);
      } else {
        flush();
        pending = { kind: "table", rows: [row] };
      }
      continue;
    }
    if (pending?.kind === "paragraph") {
      pending.lines.push(line.trim());
      continue;
    }
    flush();
    pending = { kind: "paragraph", lines: [line.trim()] };
  }
  if (fence) {
    chunks.push({ kind: "code", lines: fence.lines });
  }
  flush();
  return chunks;
}

/** The text a chunk contributes as a Block Kit header, when it reads as one. */
function readHeadingText(chunk: ParsedChunk): string | undefined {
  const candidate =
    chunk.kind === "heading"
      ? chunk.text
      : chunk.kind === "paragraph" && chunk.lines.length === 1
        ? BOLD_ONLY_RE.exec((chunk.lines[0] ?? "").trim())?.[1]
        : undefined;
  // Slack headers are plain_text and capped; a longer label stays a bold lead-in.
  return candidate && toPlainText(candidate).length <= SLACK_HEADER_TEXT_MAX
    ? candidate
    : undefined;
}

function buildHeaderBlock(text: string): SlackBlock {
  return {
    type: "header",
    text: {
      type: "plain_text",
      text: truncateSlackText(toPlainText(text), SLACK_HEADER_TEXT_MAX),
      emoji: true,
    },
  };
}

function buildSectionBlock(text: string): SlackBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: truncateSlackText(text, SLACK_SECTION_TEXT_MAX) },
  };
}

function buildFieldsBlocks(rawFields: readonly string[]): SlackBlock[] {
  // Slack rejects an empty text object, so a blank cell must never become a field.
  const fields = rawFields.map((field) => field.trim()).filter(Boolean);
  const blocks: SlackBlock[] = [];
  for (let index = 0; index < fields.length; index += SLACK_SECTION_FIELDS_MAX) {
    blocks.push({
      type: "section",
      fields: fields.slice(index, index + SLACK_SECTION_FIELDS_MAX).map((field) => ({
        type: "mrkdwn" as const,
        text: truncateSlackText(field, SLACK_SECTION_FIELD_TEXT_MAX),
      })),
    });
  }
  return blocks;
}

function buildContextBlock(text: string): SlackBlock {
  return {
    type: "context",
    elements: [
      { type: "mrkdwn", text: truncateSlackText(text, SLACK_SECTION_TEXT_MAX), verbatim: true },
    ],
  };
}

/** Split a number-dense bullet at its first colon into a key/value field. */
function buildBulletField(item: string): string {
  const separator = item.indexOf(":");
  if (separator <= 0) {
    return toSlackMrkdwn(item);
  }
  const key = toPlainText(item.slice(0, separator)).trim();
  const value = toSlackMrkdwn(item.slice(separator + 1).trim());
  return value ? `*${key}*\n${value}` : `*${key}*`;
}

function renderBullets(items: readonly string[]): SlackBlock[] {
  const numberDense = items.some((item) => countNumericTokens(item) >= NUMERIC_DENSE_MIN);
  return numberDense
    ? buildFieldsBlocks(items.map(buildBulletField))
    : [buildSectionBlock(items.map((item) => `• ${toSlackMrkdwn(item)}`).join("\n"))];
}

function renderOrdered(items: readonly string[], maxListItems: number): SlackBlock[] {
  const shown = items.slice(0, Math.max(1, maxListItems));
  const blocks: SlackBlock[] = [
    buildSectionBlock(
      shown.map((item, index) => `${String(index + 1)}. ${toSlackMrkdwn(item)}`).join("\n"),
    ),
  ];
  const hidden = items.length - shown.length;
  if (hidden > 0) {
    blocks.push(buildContextBlock(`…and ${String(hidden)} more in the artifact`));
  }
  return blocks;
}

/** Bold a header cell without nesting markers the author already wrote. */
function buildTableHeaderCell(cell: string): string {
  const mrkdwn = toSlackMrkdwn(cell);
  return !mrkdwn || mrkdwn.includes("*") ? mrkdwn : `*${mrkdwn}*`;
}

function renderTable(rows: readonly string[][]): SlackBlock[] {
  const columns = Math.max(...rows.map((row) => row.length));
  if (columns > TABLE_FIELD_COLUMNS) {
    const widths = rows.map((row) => row.map((cell) => cell.length));
    const columnWidth = (column: number) => Math.max(...widths.map((row) => row[column] ?? 0));
    const rendered = rows
      .map((row) =>
        row
          .map((cell, column) => cell.padEnd(columnWidth(column)))
          .join("  ")
          .trimEnd(),
      )
      .join("\n");
    return [buildSectionBlock(`${CODE_FENCE}\n${rendered}\n${CODE_FENCE}`)];
  }
  const [head, ...body] = rows;
  return buildFieldsBlocks([
    ...(head ?? []).map((cell) => buildTableHeaderCell(cell)),
    ...body.flatMap((row) => row.map((cell) => toSlackMrkdwn(cell))),
  ]);
}

function renderBodyChunk(chunk: ParsedChunk, config: SlackReplyPresentationSettings): SlackBlock[] {
  const heading = readHeadingText(chunk);
  if (heading) {
    return [buildHeaderBlock(heading)];
  }
  switch (chunk.kind) {
    case "heading":
      // Too long for a plain_text header, so keep it as a bold lead-in.
      return [buildSectionBlock(`*${toSlackMrkdwn(chunk.text)}*`)];
    case "paragraph":
      return [buildSectionBlock(toSlackMrkdwn(chunk.lines.join("\n")))];
    case "bullets":
      return renderBullets(chunk.items);
    case "ordered":
      return renderOrdered(chunk.items, config.maxListItems);
    case "table":
      return renderTable(chunk.rows);
    case "code":
      return [buildSectionBlock(chunk.lines.join("\n"))];
    case "context":
      return [];
  }
}

function renderHeadline(chunk: ParsedChunk): SlackBlock {
  const heading = readHeadingText(chunk);
  if (chunk.kind === "heading") {
    return heading
      ? buildHeaderBlock(heading)
      : buildSectionBlock(`*${toSlackMrkdwn(chunk.text)}*`);
  }
  const text = chunk.kind === "paragraph" ? chunk.lines.join("\n") : "";
  const mrkdwn = toSlackMrkdwn(text);
  const shouldBold = mrkdwn.length < HEADLINE_BOLD_MAX && !mrkdwn.includes("*");
  return buildSectionBlock(shouldBold ? `*${mrkdwn}*` : mrkdwn);
}

function buildContextText(chunks: readonly ParsedChunk[]): string | undefined {
  const lines = chunks.flatMap((chunk) => (chunk.kind === "context" ? chunk.lines : []));
  if (lines.length === 0) {
    return undefined;
  }
  return mapOutsideCodeSpans(toSlackMrkdwn(lines.join("\n")), (part) =>
    part.replace(CONTEXT_PATH_RE, (path) => `\`${path}\``),
  );
}

/** Point an over-budget reply at the artifact the author already named. */
function buildOverflowNote(source: string): string {
  CONTEXT_PATH_RE.lastIndex = 0;
  const path = CONTEXT_PATH_RE.exec(source)?.[0] ?? ARTIFACT_CODE_PATH_RE.exec(source)?.[1];
  return path ? `Full detail in \`${path}\`` : "Full detail in thread artifact.";
}

/**
 * Block Kit earns its place only when the reply has something to separate: two
 * or more headed sections, a real list, a table, a number-dense paragraph, or
 * the verdict/files trailer that marks a result, status board or decision.
 */
function hasRenderableStructure(chunks: readonly ParsedChunk[], source: string): boolean {
  if (VERDICT_HEADLINE_RE.test(source.split("\n")[0] ?? "")) {
    return true;
  }
  const headedSections = chunks.filter((chunk) => readHeadingText(chunk) !== undefined).length;
  if (headedSections >= HEADED_SECTION_MIN) {
    return true;
  }
  return chunks.some((chunk) => {
    switch (chunk.kind) {
      case "bullets":
      case "ordered":
        return chunk.items.length >= STRUCTURED_LIST_MIN;
      case "table":
      case "code":
      case "context":
        return true;
      case "paragraph":
        return countNumericTokens(chunk.lines.join(" ")) >= NUMERIC_DENSE_MIN;
      case "heading":
        return false;
    }
  });
}

function shouldRenderBlocks(
  chunks: readonly ParsedChunk[],
  source: string,
  mode: SlackReplyPresentationMode,
): boolean {
  if (mode !== "structured-only") {
    return mode === "always";
  }
  const hasList = chunks.some((chunk) => chunk.kind === "bullets" || chunk.kind === "ordered");
  // A short answer with no list has nothing to lay out.
  if (source.length < SHORT_REPLY_MAX && !hasList) {
    return false;
  }
  return hasRenderableStructure(chunks, source);
}

function readBlockType(block: SlackBlock): string {
  return String((block as unknown as Record<string, unknown>).type ?? "");
}

function readBlockVisibleText(block: SlackBlock): string {
  const record = block as unknown as Record<string, unknown>;
  const own = (record.text as { text?: unknown } | undefined)?.text;
  const parts = [typeof own === "string" ? own : ""];
  for (const key of ["fields", "elements"] as const) {
    const list = record[key];
    if (Array.isArray(list)) {
      parts.push(
        ...list.map((entry) => {
          const value = (entry as { text?: unknown } | undefined)?.text;
          return typeof value === "string" ? value : "";
        }),
      );
    }
  }
  return parts.filter(Boolean).join("\n");
}

function countVisibleCharacters(blocks: readonly SlackBlock[]): number {
  return blocks.reduce((total, block) => total + readBlockVisibleText(block).length, 0);
}

function assembleBlocks(params: {
  headline: SlackBlock;
  body: readonly SlackBlock[];
  contextText: string | undefined;
}): SlackBlock[] {
  const blocks: SlackBlock[] = [params.headline];
  if (params.body.length > 0) {
    blocks.push({ type: "divider" }, ...params.body);
  }
  if (params.contextText) {
    blocks.push({ type: "divider" }, buildContextBlock(params.contextText));
  }
  return blocks;
}

/** Group each content section with the header that introduces it. */
function collectSectionGroups(body: readonly SlackBlock[]): SlackBlock[][] {
  const groups: SlackBlock[][] = [];
  let pendingHeader: SlackBlock | undefined;
  for (const block of body) {
    const type = readBlockType(block);
    if (type === "header") {
      pendingHeader = block;
      continue;
    }
    if (type !== "section") {
      continue;
    }
    groups.push(pendingHeader ? [pendingHeader, block] : [block]);
    pendingHeader = undefined;
  }
  return groups;
}

/**
 * Drop back to the headline plus the leading content sections that still fit.
 * Whole blocks are kept or dropped so the reply never stops mid-sentence.
 */
function applyVisibleBudget(params: {
  headline: SlackBlock;
  body: readonly SlackBlock[];
  contextText: string | undefined;
  maxVisibleChars: number;
  overflowNote: string;
}): SlackBlock[] {
  const full = assembleBlocks(params);
  if (countVisibleCharacters(full) <= params.maxVisibleChars && full.length <= SLACK_MAX_BLOCKS) {
    return full;
  }
  const contextText = params.contextText
    ? `${params.contextText}\n${params.overflowNote}`
    : params.overflowNote;
  const kept: SlackBlock[] = [];
  for (const group of collectSectionGroups(params.body).slice(0, OVERFLOW_BODY_SECTIONS)) {
    const candidate = assembleBlocks({
      headline: params.headline,
      body: [...kept, ...group],
      contextText,
    });
    if (
      countVisibleCharacters(candidate) > params.maxVisibleChars ||
      candidate.length > SLACK_MAX_BLOCKS
    ) {
      break;
    }
    kept.push(...group);
  }
  return assembleBlocks({ headline: params.headline, body: kept, contextText });
}

function buildPresentation(
  source: string,
  config: SlackReplyPresentationSettings,
): SlackMarkdownPresentation {
  const chunks = parseChunks(source);
  const headlineChunk = chunks.find(
    (chunk) => chunk.kind === "paragraph" || chunk.kind === "heading",
  );
  if (!headlineChunk || !shouldRenderBlocks(chunks, source, config.mode)) {
    return { mode: "plain", text: source };
  }
  const blocks = applyVisibleBudget({
    headline: renderHeadline(headlineChunk),
    body: chunks
      .filter((chunk) => chunk !== headlineChunk)
      .flatMap((chunk) => renderBodyChunk(chunk, config)),
    contextText: buildContextText(chunks),
    maxVisibleChars: config.maxVisibleChars,
    overflowNote: buildOverflowNote(source),
  });
  return validateSlackBlockLimits(blocks).length > 0
    ? { mode: "plain", text: source }
    : { mode: "blocks", blocks, text: toPlainText(source) };
}

/**
 * Render an ordinary Markdown reply as Block Kit. Returns `plain` when the
 * reply opted out, carried the banned mention, has no structure worth laying
 * out, or failed to render — rendering must never make a send fail.
 */
export function renderSlackMarkdownPresentation(
  markdown: string,
  config: Partial<SlackReplyPresentationSettings> = {},
  onRenderError: (error: unknown) => void = () => {},
): SlackMarkdownPresentation | undefined {
  try {
    const source = markdown.trim();
    if (!source) {
      return undefined;
    }
    if (source.startsWith(SLACK_REPLY_PLAIN_MARKER)) {
      const text = source.slice(SLACK_REPLY_PLAIN_MARKER.length).trim();
      return text ? { mode: "plain", text } : undefined;
    }
    if (source.includes(SLACK_REPLY_BANNED_MENTION)) {
      return { mode: "plain", text: source };
    }
    return buildPresentation(source, resolveSlackReplyPresentationSettings(config));
  } catch (error) {
    onRenderError(error);
    return { mode: "plain", text: markdown };
  }
}
