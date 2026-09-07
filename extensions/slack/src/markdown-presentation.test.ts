// Slack tests cover deterministic Markdown-to-Block-Kit reply rendering.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateSlackBlockLimits } from "./block-limits.js";
import type { SlackBlock } from "./blocks-render.js";
import {
  renderSlackMarkdownPresentation,
  SLACK_REPLY_BANNED_MENTION,
  SLACK_REPLY_PLAIN_MARKER,
} from "./markdown-presentation.js";

function readFixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

function renderBlocks(markdown: string, config = {}): SlackBlock[] {
  const rendered = renderSlackMarkdownPresentation(markdown, { mode: "always", ...config });
  if (rendered?.mode !== "blocks") {
    throw new Error(`expected blocks, received ${rendered?.mode ?? "undefined"}`);
  }
  expect(validateSlackBlockLimits(rendered.blocks)).toEqual([]);
  return rendered.blocks;
}

/** Paste this into a browser to preview the rendered message. */
function buildBlockKitBuilderUrl(blocks: readonly SlackBlock[]): string {
  return `https://app.slack.com/block-kit-builder/#${encodeURIComponent(JSON.stringify({ blocks }))}`;
}

function readBlockTypes(blocks: readonly SlackBlock[]): string[] {
  return blocks.map((block) => String((block as unknown as { type: string }).type));
}

const BRIBE = readFixture("slack-reply-bribe-stage0.md");
const DAG = readFixture("slack-reply-dag000i.md");

describe("renderSlackMarkdownPresentation shape rules", () => {
  it("bolds a short first paragraph and puts a divider before the body", () => {
    const blocks = renderBlocks("Deploy is green.\n\nEverything shipped without incident.");
    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "*Deploy is green.*" } },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: "Everything shipped without incident." },
      },
    ]);
  });

  it("leaves a long headline unbolded", () => {
    const headline = `${"word ".repeat(40)}end.`;
    const [first] = renderBlocks(`${headline}\n\nBody paragraph.`);
    expect((first as { text: { text: string } }).text.text.startsWith("*")).toBe(false);
  });

  it("turns a heading and a bold-only paragraph into header blocks", () => {
    const blocks = renderBlocks("Headline.\n\n## Findings\n\nBody.\n\n**Lessons**\n\nMore body.");
    expect(readBlockTypes(blocks)).toEqual([
      "section",
      "divider",
      "header",
      "section",
      "header",
      "section",
    ]);
    expect(blocks[2]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Findings", emoji: true },
    });
    expect(blocks[4]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Lessons", emoji: true },
    });
  });

  it("keeps a bold label with trailing content as a bold section lead-in", () => {
    const blocks = renderBlocks("Headline.\n\n**What the study asked**: whether the gate held.");
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*What the study asked*: whether the gate held." },
    });
  });

  it("keeps a plain bulleted list as one section with bullets", () => {
    const blocks = renderBlocks("Headline.\n\n- first item\n- second item\n- third item");
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "• first item\n• second item\n• third item" },
    });
  });

  it("turns a number-dense bullet list into key/value fields split at the first colon", () => {
    const blocks = renderBlocks(
      "Headline.\n\n" +
        "• V10 gate: honest 0.376 vs withholding 0.339, drop 0.036\n" +
        "• V11 check: reversed -0.034, CI [-0.096, +0.029]\n",
    );
    expect(blocks[2]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*V10 gate*\nhonest 0.376 vs withholding 0.339, drop 0.036" },
        { type: "mrkdwn", text: "*V11 check*\nreversed -0.034, CI [-0.096, +0.029]" },
      ],
    });
  });

  it("caps a numbered list and sends the remainder to a context block", () => {
    const items = Array.from(
      { length: 8 },
      (_, index) => `${String(index + 1)}. lesson ${String(index + 1)}`,
    );
    const blocks = renderBlocks(`Headline.\n\n${items.join("\n")}`);
    expect(blocks[2]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "1. lesson 1\n2. lesson 2\n3. lesson 3\n4. lesson 4\n5. lesson 5",
      },
    });
    expect(blocks[3]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "…and 3 more in the artifact", verbatim: true }],
    });
  });

  it("honours maxListItems", () => {
    const blocks = renderBlocks("Headline.\n\n1. one\n2. two\n3. three", { maxListItems: 2 });
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "1. one\n2. two" },
    });
    expect(blocks[3]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "…and 1 more in the artifact", verbatim: true }],
    });
  });

  it("renders a two-column table as fields", () => {
    const blocks = renderBlocks("Headline.\n\n| Arm | Rate |\n| --- | --- |\n| loss | 0.565 |");
    expect(blocks[2]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Arm*" },
        { type: "mrkdwn", text: "*Rate*" },
        { type: "mrkdwn", text: "loss" },
        { type: "mrkdwn", text: "0.565" },
      ],
    });
  });

  it("renders a wider table as a code block", () => {
    const blocks = renderBlocks(
      "Headline.\n\n| Arm | Rate | n |\n| --- | --- | --- |\n| loss | 0.565 | 24 |",
    );
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "```\nArm   Rate   n\nloss  0.565  24\n```" },
    });
  });

  it("collects file, evidence, spend and path lines into one trailing context block", () => {
    const blocks = renderBlocks(
      "Headline.\n\nBody paragraph.\n\nFiles: /home/ubuntu/dag000/i/ (RESULT.md). Spend $1.38 of $10.",
    );
    expect(readBlockTypes(blocks)).toEqual(["section", "divider", "section", "divider", "context"]);
    expect(blocks[4]).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Files: `/home/ubuntu/dag000/i/` (RESULT.md). Spend $1.38 of $10.",
          verbatim: true,
        },
      ],
    });
  });
});

describe("renderSlackMarkdownPresentation guard rails", () => {
  it("stays plain text behind the per-message escape hatch", () => {
    expect(renderSlackMarkdownPresentation(`${SLACK_REPLY_PLAIN_MARKER}\n## Raw\n\nbody`)).toEqual({
      mode: "plain",
      text: "## Raw\n\nbody",
    });
  });

  it("never renders Block Kit for the banned mention", () => {
    const markdown = `${SLACK_REPLY_BANNED_MENTION} Headline.\n\nBody paragraph.`;
    expect(renderSlackMarkdownPresentation(markdown)).toEqual({ mode: "plain", text: markdown });
  });

  it("stays plain text when the mode is never", () => {
    expect(renderSlackMarkdownPresentation(BRIBE, { mode: "never" })).toEqual({
      mode: "plain",
      text: BRIBE.trim(),
    });
  });

  it("falls back to plain text and warns when rendering throws", () => {
    const warnings: unknown[] = [];
    const exploding = {
      trim: () => {
        throw new Error("boom");
      },
    } as unknown as string;
    expect(renderSlackMarkdownPresentation(exploding, {}, (error) => warnings.push(error))).toEqual(
      {
        mode: "plain",
        text: exploding,
      },
    );
    expect(warnings).toHaveLength(1);
  });

  it("returns undefined for an empty reply", () => {
    expect(renderSlackMarkdownPresentation("   \n\n ")).toBeUndefined();
  });

  it("sets the top-level text to the plain-text version for notifications and search", () => {
    const rendered = renderSlackMarkdownPresentation("## Title\n\n**Bold** and `code` and _it_.", {
      mode: "always",
    });
    expect(rendered).toMatchObject({ mode: "blocks", text: "Title\n\nBold and code and it." });
  });

  it("keeps snake_case identifiers intact in the plain-text version", () => {
    const rendered = renderSlackMarkdownPresentation(
      "Headline.\n\npartial_loss beat partial_gain.",
      {
        mode: "always",
      },
    );
    expect(rendered).toMatchObject({ text: "Headline.\n\npartial_loss beat partial_gain." });
  });

  it("keeps whole blocks when the visible budget is exceeded", () => {
    const long = "sentence text. ".repeat(60).trim();
    const blocks = renderBlocks(`Headline.\n\n${long}\n\n${long}\n\n${long}\n\n${long}`, {
      maxVisibleChars: 2500,
    });
    expect(readBlockTypes(blocks)).toEqual([
      "section",
      "divider",
      "section",
      "section",
      "divider",
      "context",
    ]);
    expect(blocks[5]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Full detail in thread artifact.", verbatim: true }],
    });
    expect((blocks[2] as { text: { text: string } }).text.text.endsWith("sentence text.")).toBe(
      true,
    );
  });

  it("keeps the artifact pointer when the budget trims the body", () => {
    const long = "sentence text. ".repeat(60).trim();
    const blocks = renderBlocks(
      `Headline.\n\n${long}\n\n${long}\n\n${long}\n\nFiles: /home/ubuntu/run/ (RESULT.md).`,
      { maxVisibleChars: 800 },
    );
    expect(blocks.at(-1)).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Files: `/home/ubuntu/run/` (RESULT.md).\nFull detail in `/home/ubuntu/run/`",
          verbatim: true,
        },
      ],
    });
  });
});

describe("structured-only gating", () => {
  const render = (markdown: string, config = {}) =>
    renderSlackMarkdownPresentation(markdown, config)?.mode;

  it("keeps a short answer without a list as plain mrkdwn", () => {
    expect(render("All three checks passed; nothing else to report.")).toBe("plain");
  });

  it("keeps a long answer with no structure as plain mrkdwn", () => {
    expect(render("This is a narrative sentence that carries no structure. ".repeat(9))).toBe(
      "plain",
    );
  });

  it("renders a short answer that carries a three-item list", () => {
    expect(render("Status.\n\n- one\n- two\n- three")).toBe("blocks");
  });

  it("renders a long answer whose paragraph is number-dense", () => {
    const dense = `Break rates were 0.565 and 0.451, D = +0.114, CI [+0.056, +0.178]. ${"Filler prose to clear the short-answer floor. ".repeat(9)}`;
    expect(render(dense)).toBe("blocks");
  });

  it("renders two headed sections once past the short-answer floor", () => {
    const body = "Supporting prose that carries the section past the floor. ".repeat(4);
    expect(render(`Headline.\n\n## First\n\n${body}\n\n## Second\n\n${body}`)).toBe("blocks");
  });

  it("renders a table once past the short-answer floor", () => {
    const body = "Supporting prose that carries the reply past the floor. ".repeat(9);
    expect(render(`Headline.\n\n${body}\n\n| Arm | Rate |\n| --- | --- |\n| loss | 0.565 |`)).toBe(
      "blocks",
    );
  });

  it("keeps a short structured answer plain: the short-answer floor wins", () => {
    expect(render("Headline.\n\n| Arm | Rate |\n| --- | --- |\n| loss | 0.565 |")).toBe("plain");
    expect(render("Headline.\n\n## First\n\nBody.\n\n## Second\n\nBody.")).toBe("plain");
  });

  it("renders both real replies under the default mode", () => {
    expect(render(BRIBE)).toBe("blocks");
    expect(render(DAG)).toBe("blocks");
  });

  it("renders anything under mode always", () => {
    expect(render("ok.")).toBe("plain");
    expect(render("ok.", { mode: "always" })).toBe("blocks");
  });
});

describe("review regressions", () => {
  it("never emits an empty field for a blank table cell", () => {
    const blocks = renderBlocks("Headline.\n\n| Key | Value |\n| --- | --- |\n| x |  |");
    expect(blocks[2]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Key*" },
        { type: "mrkdwn", text: "*Value*" },
        { type: "mrkdwn", text: "x" },
      ],
    });
  });

  it("holds the visible budget after trimming, not just before", () => {
    const blocks = renderBlocks(
      `Headline.\n\n${"A".repeat(2000)}\n\n${"B".repeat(2000)}\n\nTail.`,
      { maxVisibleChars: 2500 },
    );
    const visible = blocks.reduce((total, block) => {
      const own = (block as { text?: { text?: string } }).text?.text ?? "";
      const fields = (block as { fields?: { text: string }[] }).fields ?? [];
      const elements = (block as { elements?: { text: string }[] }).elements ?? [];
      return total + own.length + [...fields, ...elements].reduce((n, e) => n + e.text.length, 0);
    }, 0);
    expect(visible).toBeLessThanOrEqual(2500);
  });

  it("keeps a fenced code block whole instead of parsing it as a list", () => {
    const blocks = renderBlocks(
      "Headline.\n\n```text\n- not a list\n- still code\n- third item\n```",
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```text\n- not a list\n- still code\n- third item\n```",
      },
    });
  });

  it("does not split a table on a pipe inside inline code", () => {
    const blocks = renderBlocks("Headline.\n\n| regex | `a|b` |\n| --- | --- |\n| alt | x |");
    expect(blocks[2]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*regex*" },
        { type: "mrkdwn", text: "*`a|b`*" },
        { type: "mrkdwn", text: "alt" },
        { type: "mrkdwn", text: "x" },
      ],
    });
  });

  it("renders an over-long heading as a bold lead-in instead of truncating it", () => {
    const heading = "H".repeat(170);
    const blocks = renderBlocks(`Headline.\n\n## ${heading}\n\nBody.`);
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: `*${heading}*` },
    });
  });

  it("treats a verdict opener as structure even without lists or numbers", () => {
    const prose = "Narrative justification without any structural markers. ".repeat(9);
    expect(renderSlackMarkdownPresentation(`Decision: do not launch.\n\n${prose}`)?.mode).toBe(
      "blocks",
    );
  });

  it("lifts a context line that has no blank line before it", () => {
    const blocks = renderBlocks("Headline.\n\nBody line\nFiles: /home/ubuntu/run/RESULT.md");
    expect(readBlockTypes(blocks)).toEqual(["section", "divider", "section", "divider", "context"]);
    expect(blocks[2]).toEqual({ type: "section", text: { type: "mrkdwn", text: "Body line" } });
    expect(blocks[4]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Files: `/home/ubuntu/run/RESULT.md`", verbatim: true }],
    });
  });
});

describe("validateSlackBlockLimits", () => {
  it("passes a clean message", () => {
    expect(
      validateSlackBlockLimits([
        { type: "header", text: { type: "plain_text", text: "ok" } },
        { type: "divider" },
      ] as SlackBlock[]),
    ).toEqual([]);
  });

  it("reports every broken limit", () => {
    expect(
      validateSlackBlockLimits([
        { type: "header", text: { type: "plain_text", text: "h".repeat(151) } },
        { type: "section", text: { type: "mrkdwn", text: "s".repeat(3001) } },
        {
          type: "section",
          fields: Array.from({ length: 11 }, () => ({ type: "mrkdwn", text: "f" })),
        },
        {
          type: "section",
          fields: [{ type: "mrkdwn", text: "f".repeat(2001) }],
        },
      ] as SlackBlock[]),
    ).toEqual([
      { index: 0, blockType: "header", reason: "header text is 151 chars (max 150)" },
      { index: 1, blockType: "section", reason: "section text is 3001 chars (max 3000)" },
      { index: 2, blockType: "section", reason: "section has 11 fields (max 10)" },
      { index: 3, blockType: "section", reason: "field 0 is 2001 chars (max 2000)" },
    ]);
  });

  it("rejects empty text objects that Slack would refuse", () => {
    expect(
      validateSlackBlockLimits([
        { type: "section", fields: [{ type: "mrkdwn", text: "" }] },
        { type: "section", fields: [] },
      ] as SlackBlock[]),
    ).toEqual([
      { index: 0, blockType: "section", reason: "field 0 is empty" },
      { index: 1, blockType: "section", reason: "section fields must not be empty" },
    ]);
  });
});

describe("real Slack replies render as Block Kit", () => {
  // Preview: paste the URL printed by this suite into a browser (Block Kit Builder).
  it("renders the BRIBE stage 0 answer within the default 2500-char budget", () => {
    const blocks = renderBlocks(BRIBE);
    expect(blocks).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "text": "*<@U03EH553GBE> Short version: Stage 0 never validated the instrument, and the failure taught us more about measurement than about bribes.*",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "type": "divider",
        },
        {
          "text": {
            "text": "*What the study asked*: can a Qwen3-32B agent, told its payoff depends on the grader's difficulty rating, be caught deliberately withholding effort (scoring lower) vs an honest arm? Stage 0 was the instrument check before the 2,240-session campaign.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "text": {
            "emoji": true,
            "text": "What we found",
            "type": "plain_text",
          },
          "type": "header",
        },
        {
          "fields": [
            {
              "text": "*V10 (the corrected non-thinking instrument) failed its preregistered gate*
      honest 0.376 vs withholding 0.339, drop 0.036, task-cluster CI [-0.056, +0.140], 96/arm. Campaign never launched.",
              "type": "mrkdwn",
            },
            {
              "text": "*V11 manipulation check*
      _conditional_ withholding ("hold back when the task is easy") did nothing again, even slightly reversed (-0.034, CI [-0.096, +0.029], and it used ~1.4 more calls than honest). But an _unconditional_ "deliberately underperform" instruction dropped score by 0.35 on all 28 of 28 tasks. So the instrument can see sandbagging when it happens; the model just does not do it under the conditional bribe framing.",
              "type": "mrkdwn",
            },
            {
              "text": "*V12 decomposition*
      explicit-conditional, soft-unconditional and full-unconditional all produce ~0.31–0.36 drops. The thing that kills the effect is specifically the model having to _judge_ the contingency itself. Comprehension probes were 100% in every arm, so it is not misunderstanding.",
              "type": "mrkdwn",
            },
          ],
          "type": "section",
        },
        {
          "type": "divider",
        },
        {
          "elements": [
            {
              "text": "Full detail in \`experiments/2026-08-19-bribe-test-agentic/RESULT_STAGE0_V2.md\`",
              "type": "mrkdwn",
              "verbatim": true,
            },
          ],
          "type": "context",
        },
      ]
    `);
  });

  it("renders the full BRIBE stage 0 answer when the budget allows", () => {
    const blocks = renderBlocks(BRIBE, { maxVisibleChars: 20000 });
    // eslint-disable-next-line no-console
    console.log(`BRIBE Block Kit Builder: ${buildBlockKitBuilderUrl(blocks)}`);
    expect(blocks).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "text": "*<@U03EH553GBE> Short version: Stage 0 never validated the instrument, and the failure taught us more about measurement than about bribes.*",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "type": "divider",
        },
        {
          "text": {
            "text": "*What the study asked*: can a Qwen3-32B agent, told its payoff depends on the grader's difficulty rating, be caught deliberately withholding effort (scoring lower) vs an honest arm? Stage 0 was the instrument check before the 2,240-session campaign.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "text": {
            "emoji": true,
            "text": "What we found",
            "type": "plain_text",
          },
          "type": "header",
        },
        {
          "fields": [
            {
              "text": "*V10 (the corrected non-thinking instrument) failed its preregistered gate*
      honest 0.376 vs withholding 0.339, drop 0.036, task-cluster CI [-0.056, +0.140], 96/arm. Campaign never launched.",
              "type": "mrkdwn",
            },
            {
              "text": "*V11 manipulation check*
      _conditional_ withholding ("hold back when the task is easy") did nothing again, even slightly reversed (-0.034, CI [-0.096, +0.029], and it used ~1.4 more calls than honest). But an _unconditional_ "deliberately underperform" instruction dropped score by 0.35 on all 28 of 28 tasks. So the instrument can see sandbagging when it happens; the model just does not do it under the conditional bribe framing.",
              "type": "mrkdwn",
            },
            {
              "text": "*V12 decomposition*
      explicit-conditional, soft-unconditional and full-unconditional all produce ~0.31–0.36 drops. The thing that kills the effect is specifically the model having to _judge_ the contingency itself. Comprehension probes were 100% in every arm, so it is not misunderstanding.",
              "type": "mrkdwn",
            },
          ],
          "type": "section",
        },
        {
          "text": {
            "text": "*Reading*: on this model and battery, there is no measurable spontaneous strategic withholding. That is a validated negative for the _instrument-in-this-form_, not a claim that the behavior does not exist — cluster-aware power for the 0.10 effect was only 30–46%.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "text": {
            "text": "*Lessons that generalize* (now in memory/standing rules)",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "text": {
            "text": "1. Compute power in the same unit as the preregistered analysis (task clusters, not rows). Row-level MDE was 0.09; cluster-aware was 0.15–0.17.
      2. Per-task degeneracy guard before any aggregate: one task scored 0 in all sessions, two had identical arm means, dropping one task flipped the sign. Same guard later caught the PCB-001 inversion.
      3. Report budget exhaustion per task; pooled counts cancelled opposite-direction confounds.
      4. Plumbing: \`python -I\` dropped the env var, so Qwen silently ran in thinking mode for two runs (score 0.76 → 0.36, throughput 12x). Now: capture a real request body, hash the harness per run, hard-abort on the failure signature.
      5. Never edit harness files mid-measurement; a self-written "resolution" file is not a closed review gate.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "elements": [
            {
              "text": "…and 1 more in the artifact",
              "type": "mrkdwn",
              "verbatim": true,
            },
          ],
          "type": "context",
        },
        {
          "text": {
            "text": "Lane state: closed by announced default on 08-25, campaign rule still \`do_not_launch\`. Reopens on your word if you want the rebuilt battery run. Artifacts: \`experiments/2026-08-19-bribe-test-agentic/RESULT_STAGE0_V2.md\`, \`RESULT_STAGE0_REBUILD_V11.md\`, \`RESULT_STAGE0_REBUILD_V12.md\`.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
      ]
    `);
  });

  it("renders the DAG-000i result", () => {
    const blocks = renderBlocks(DAG);
    // eslint-disable-next-line no-console
    console.log(`DAG-000i Block Kit Builder: ${buildBlockKitBuilderUrl(blocks)}`);
    expect(blocks).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "text": "*DAG-000i result: frame-driven, verdict-bearing.*",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "type": "divider",
        },
        {
          "text": {
            "text": "At a moderate operating point, with only the guarantee clause swapped for a partial-contingency clause in both arms, the loss frame raised commitment abandonment above the gain frame. Break rates (scenario-weighted, 23 scenarios × 24 samples per arm): partial_loss 0.565, partial_gain 0.451. D = +0.114, scenario-bootstrap 95% [+0.056, +0.178], two-level [+0.038, +0.194], paired t(22) = 3.54, p = 0.002. 16 scenarios positive, 3 negative, 4 zero. Pre-registered rule (D ≥ +0.10 and lower bound &gt; 0) met.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "text": {
            "text": "Gates: operating point 0.508 (window 0.35–0.65), headroom 0.549 (≥ 0.20), parse failures 0, prompt-integrity failures 0, 23 usable scenarios. All pass.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "text": {
            "text": "Review: gpt-5.6-sol reproduced every number and passed the freeze. It returned one BLOCKING finding, accepted as a wording correction: the "guarantee effect" (g_loss − partial_loss = +0.192 [+0.126, +0.263]) compares rows from different days, seeds and sessions, with a pip upgrade of the inference stack in between, so it is a descriptive cross-run gap, not an isolated estimate of what the clause caused. RESULT.md says so; the primary contrast is unaffected (within-run, randomized). Nothing open.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "text": {
            "text": "Companions (exploratory): 5-scenario mid subset D = +0.042 [−0.067, +0.142], underpowered as pre-stated; stage-3 self-labels are unblinded model output; the pre-registered prose-verified tagger pass has not been run yet and cannot change the verdict.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "text": {
            "text": "Does not license: one model (Qwen3.5-4B), 23 scenarios, one wording package, third-party stake only, no mechanism claim.",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "text": {
            "text": "job:dag000i-frame:66d5d8d0:terminal",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "type": "divider",
        },
        {
          "elements": [
            {
              "text": "Files: \`/home/ubuntu/dag000/i/\` (RESULT.md, REVIEW.md, REVIEW_RESOLUTION.md, i_result.json, rows_i.jsonl 2,208 rows). Spend $1.38 of $10; pod stopped.",
              "type": "mrkdwn",
              "verbatim": true,
            },
          ],
          "type": "context",
        },
      ]
    `);
  });
});
