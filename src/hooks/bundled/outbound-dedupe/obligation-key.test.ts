import { describe, expect, it } from "vitest";
import {
  buildObligationKey,
  FIRST_RESPONSE_VERSION,
  resolveOutboundObligation,
} from "./obligation-key.js";

const CHANNEL = "C0A3C98HS48";
const REPLAYED_ASK_TS = "1788479206.951729";
const LIVE_ASK_TS = "1788479558.561999";
const ASK_ID = `${CHANNEL}:${REPLAYED_ASK_TS}`;

function slackCtx(sessionKey?: string) {
  return {
    channelId: "slack",
    conversationId: `channel:${CHANNEL}`,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

describe("outbound obligation key", () => {
  it("collapses a threaded reply and a top-level post for the same obligation", () => {
    const threaded = resolveOutboundObligation(
      {
        to: `channel:${CHANNEL}`,
        content: "In thread: the deploy finished at 02:14.",
        threadId: LIVE_ASK_TS,
        metadata: { obligationId: ASK_ID },
      },
      slackCtx(`agent:main:slack:channel:c0a3c98hs48:thread:${LIVE_ASK_TS}`),
    );
    const topLevel = resolveOutboundObligation(
      {
        to: `channel:${CHANNEL}`,
        content: "Top level: the rollout is done.",
        metadata: { obligationId: ASK_ID },
      },
      slackCtx(`agent:main:slack:channel:c0a3c98hs48:thread:${REPLAYED_ASK_TS}`),
    );

    expect(threaded?.key).toBe(topLevel?.key);
    expect(threaded?.threadRootTs).toBe(REPLAYED_ASK_TS);
    expect(threaded?.responseVersion).toBe(FIRST_RESPONSE_VERSION);
  });

  it("keeps a different obligation in the same thread apart", () => {
    const first = resolveOutboundObligation(
      { to: CHANNEL, content: "a", threadId: LIVE_ASK_TS, replyToId: REPLAYED_ASK_TS },
      slackCtx(),
    );
    const second = resolveOutboundObligation(
      { to: CHANNEL, content: "b", threadId: LIVE_ASK_TS, replyToId: LIVE_ASK_TS },
      slackCtx(),
    );
    expect(first?.key).not.toBe(second?.key);
    expect(first?.source).toBe("reply-target");
    expect(first?.obligationId).toBe(ASK_ID);
  });

  it("gives a declared follow-up version its own key", () => {
    const answer = resolveOutboundObligation(
      { to: CHANNEL, content: "a", metadata: { obligationId: ASK_ID } },
      slackCtx(),
    );
    const followUp = resolveOutboundObligation(
      { to: CHANNEL, content: "b", metadata: { obligationId: ASK_ID, responseVersion: 1 } },
      slackCtx(),
    );
    expect(followUp?.responseVersion).toBe(1);
    expect(followUp?.key).not.toBe(answer?.key);
  });

  it("falls back to the first version when the declared one is unusable", () => {
    for (const responseVersion of ["2", -1, 1.5, null]) {
      expect(
        resolveOutboundObligation(
          { to: CHANNEL, content: "a", metadata: { obligationId: ASK_ID, responseVersion } },
          slackCtx(),
        )?.responseVersion,
      ).toBe(FIRST_RESPONSE_VERSION);
    }
  });

  it("prefers the declared obligation over the reply target", () => {
    expect(
      resolveOutboundObligation(
        {
          to: CHANNEL,
          content: "a",
          replyToId: LIVE_ASK_TS,
          metadata: { obligationId: ASK_ID },
        },
        slackCtx(),
      ),
    ).toMatchObject({ obligationId: ASK_ID, source: "declared" });
  });

  it("has no obligation for an announce that answers nothing", () => {
    expect(
      resolveOutboundObligation(
        { to: CHANNEL, content: "[hcom-bridge] reconciliation required", threadId: LIVE_ASK_TS },
        slackCtx("agent:main:main"),
      ),
    ).toBeUndefined();
    expect(
      resolveOutboundObligation({ to: CHANNEL, content: "a", replyToId: "not-a-ts" }, slackCtx()),
    ).toBeUndefined();
  });

  it("case-folds the Slack channel and honours a declared thread root", () => {
    expect(
      resolveOutboundObligation(
        {
          to: "channel:c0a3c98hs48",
          content: "a",
          metadata: { obligationId: "job-4711", threadRootTs: LIVE_ASK_TS },
        },
        slackCtx(),
      )?.key,
    ).toBe(
      buildObligationKey({
        channel: CHANNEL,
        threadRootTs: LIVE_ASK_TS,
        obligationId: "job-4711",
        responseVersion: FIRST_RESPONSE_VERSION,
      }),
    );
  });
});
