// Slack tests cover Markdown replies reaching Block Kit through the reply pipeline.
import { readFileSync } from "node:fs";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { readSlackReplyPresentationConfig } from "./markdown-presentation-config.js";
import { SLACK_REPLY_PLAIN_MARKER } from "./markdown-presentation.js";
import {
  resolveSlackReplyBlockResolution,
  resolveSlackReplyDeliveryMessages,
} from "./reply-blocks.js";

const DAG = readFileSync(new URL("./__fixtures__/slack-reply-dag000i.md", import.meta.url), "utf8");

function resolve(text: string, presentation?: Record<string, unknown>) {
  const payload = { text } as ReplyPayload;
  return resolveSlackReplyBlockResolution(
    payload,
    presentation ? { authoredMarkdownPresentation: presentation } : {},
  );
}

describe("authored Markdown reaches Block Kit", () => {
  it("renders a plain Markdown reply as one Block Kit segment", () => {
    const { segments, authoredTextPlacement } = resolve(DAG, {});
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("blocks");
    // "outside-blocks" keeps the full reply as the message's top-level text.
    expect(authoredTextPlacement).toBe("outside-blocks");
  });

  it("sends one message whose top-level text still carries the reply", () => {
    const { segments, authoredTextPlacement } = resolve(DAG, {});
    const messages = resolveSlackReplyDeliveryMessages({
      authoredTextPlacement,
      segments,
      text: DAG,
    });
    // One message: Slack shows the blocks, the text is the notification copy.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks?.length).toBeGreaterThan(3);
    expect(messages[0]?.nativeDataFallbackBaseText).toBe(DAG.trim());
    // Notifications and search read the top-level text, so it keeps the reply.
    expect(messages[0]?.text).toContain("DAG-000i result");
    expect(messages[0]?.text).toContain("Does not license");
  });

  it("leaves replies untouched when the caller does not opt in", () => {
    expect(resolve(DAG).segments).toEqual([]);
  });

  it("leaves replies untouched when the mode is never", () => {
    expect(resolve(DAG, { mode: "never" }).segments).toEqual([]);
  });

  it("leaves an unstructured short reply as plain text", () => {
    expect(resolve("All good, nothing to report.", {}).segments).toEqual([]);
  });

  it("leaves replies untouched behind the per-message escape hatch", () => {
    expect(resolve(`${SLACK_REPLY_PLAIN_MARKER}\n${DAG}`, {}).segments).toEqual([]);
  });

  it("leaves an empty reply untouched", () => {
    expect(resolve("   ", {}).segments).toEqual([]);
  });
});

describe("readSlackReplyPresentationConfig", () => {
  it("defaults to an empty override", () => {
    expect(readSlackReplyPresentationConfig(undefined)).toEqual({});
    expect(readSlackReplyPresentationConfig({})).toEqual({});
  });

  it("reads channels.slack.presentation", () => {
    expect(
      readSlackReplyPresentationConfig({
        channels: { slack: { presentation: { mode: "never", maxListItems: 3 } } },
      }),
    ).toEqual({ mode: "never", maxListItems: 3 });
  });

  it("lets a per-account entry win", () => {
    expect(
      readSlackReplyPresentationConfig(
        {
          channels: {
            slack: {
              presentation: { mode: "always", maxVisibleChars: 2500 },
              accounts: { ops: { presentation: { maxVisibleChars: 900 } } },
            },
          },
        },
        "ops",
      ),
    ).toEqual({ mode: "always", maxVisibleChars: 900 });
  });
});
