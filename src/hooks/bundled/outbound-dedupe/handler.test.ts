import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasCoreHook, listCoreHooks } from "../../../plugins/core-hooks.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import { DEFAULT_OUTBOUND_DEDUPE_CONFIG } from "./guard.js";
import {
  createOutboundDedupeHandler,
  OUTBOUND_DEDUPE_PLUGIN_ID,
  resolveOutboundDedupeConfig,
} from "./handler.js";

describe("outbound-dedupe handler", () => {
  it("registers the message_sending guard as a core hook when the module loads", () => {
    expect(hasCoreHook(OUTBOUND_DEDUPE_PLUGIN_ID, "message_sending")).toBe(true);
    expect(
      listCoreHooks().filter((hook) => hook.pluginId === OUTBOUND_DEDUPE_PLUGIN_ID),
    ).toHaveLength(1);
  });

  it("forwards message:sent to the recorder and ignores other events", async () => {
    const recordSent = vi.fn(async () => undefined);
    const handler = createOutboundDedupeHandler(recordSent);
    const sentContext = { to: "channel:C1", content: "x", success: true, channelId: "slack" };

    await handler(createInternalHookEvent("gateway", "startup", "gateway:startup"));
    await handler(createInternalHookEvent("message", "received", "agent:main:main"));
    await handler(createInternalHookEvent("message", "sent", "agent:main:main", sentContext));

    expect(recordSent).toHaveBeenCalledTimes(1);
    expect(recordSent).toHaveBeenCalledWith(sentContext, "agent:main:main");
  });

  it("reads config overrides and falls back to defaults", () => {
    expect(resolveOutboundDedupeConfig(null)).toEqual(DEFAULT_OUTBOUND_DEDUPE_CONFIG);
    const cfg = {
      hooks: {
        internal: {
          entries: {
            "outbound-dedupe": { enabled: true, windowHours: 6, maxPerThread: 20.7, minChars: 10 },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveOutboundDedupeConfig(cfg)).toEqual({
      windowHours: 6,
      maxPerThread: DEFAULT_OUTBOUND_DEDUPE_CONFIG.maxPerThread,
      minChars: 10,
    });
  });
});
