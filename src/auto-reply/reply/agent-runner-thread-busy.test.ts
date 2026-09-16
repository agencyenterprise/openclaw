import { expect, it, vi } from "vitest";
import { NativeDispatchBusyError } from "../../state/thread-dispatch.js";
import { setupAgentRunnerExecutionTestState, getRunAgentTurnWithFallback, createMinimalRunAgentTurnParams } from "./agent-runner-execution.test-support.js";
const state=setupAgentRunnerExecutionTestState();
it("propagates typed admission busy without a generic failed reply", async () => {
 const error=new NativeDispatchBusyError();state.runEmbeddedAgentMock.mockRejectedValueOnce(error);
 const run=await getRunAgentTurnWithFallback();
 await expect(run(createMinimalRunAgentTurnParams())).rejects.toBe(error);
 expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
});
