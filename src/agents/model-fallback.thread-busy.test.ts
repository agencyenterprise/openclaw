import { expect, it, vi } from "vitest";
import { NativeDispatchBusyError } from "../state/thread-dispatch.js";
import { runWithModelFallback } from "./model-fallback.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";
it("preserves typed dispatch busy without fallback model callbacks", async () => {
 const error=new NativeDispatchBusyError(); const run=vi.fn().mockRejectedValue(error);
 await expect(runWithModelFallback({cfg:makeModelFallbackCfg(),provider:"openai",model:"gpt-4.1-mini",run})).rejects.toBe(error);
 expect(run).toHaveBeenCalledTimes(1);
});
