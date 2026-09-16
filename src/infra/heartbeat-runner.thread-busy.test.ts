import { expect, it, vi } from "vitest";
import { NativeDispatchBusyError } from "../state/thread-dispatch.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, peekSystemEventEntries, resetSystemEventsForTest } from "./system-events.js";
vi.mock("./outbound/deliver.js",()=>({deliverOutboundPayloads:vi.fn().mockResolvedValue([]),deliverOutboundPayloadsInternal:vi.fn().mockResolvedValue([])}));
it("keeps the original heartbeat event pending on typed native busy", async()=>{
 await withTempHeartbeatSandbox(async({tmpDir,storePath,replySpy})=>{
  const cfg:OpenClawConfig={agents:{defaults:{workspace:tmpDir,heartbeat:{every:"5m",target:"whatsapp"}}},channels:{whatsapp:{allowFrom:["*"]}},session:{store:storePath}};
  const key=resolveMainSessionKey(cfg);await seedSessionStore(storePath,key,{lastChannel:"whatsapp",lastProvider:"whatsapp",lastTo:"+1555"});
  resetSystemEventsForTest();enqueueSystemEvent("pending owned fixture result",{sessionKey:key});
  const before=peekSystemEventEntries(key);replySpy.mockRejectedValueOnce(new NativeDispatchBusyError());
  const result=await runHeartbeatOnce({cfg,source:"exec-event",reason:"exec-event",deps:{getReplyFromConfig:replySpy,getQueueSize:()=>0}});
  expect(replySpy).toHaveBeenCalledTimes(1);expect(result.status).toBe("skipped");expect(peekSystemEventEntries(key)).toEqual(before);resetSystemEventsForTest();
 });
});
