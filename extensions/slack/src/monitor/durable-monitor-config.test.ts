import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const { loadFence } = vi.hoisted(()=>({loadFence:vi.fn()}));
vi.mock("openclaw/plugin-sdk/reply-runtime",()=>({loadDispatchConfig:loadFence}));
import { loadSlackDurableMonitorConfig } from "./durable-monitor-config.js";
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();loadFence.mockReset();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function setup(){
  const dir=mkdtempSync(path.join(os.tmpdir(),"slack-monitor-config-"));dirs.push(dir);chmodSync(dir,0o700);
  const file=path.join(dir,"config.json");
  const scope={accountId:"default",teamId:"T1",appId:"A1",channelId:"C1",threadTs:"123.000001"};
  const value={version:1,scope,sessionKey:"agent:main:slack:channel:c1:thread:123.000001",stateDir:dir};
  writeFileSync(file,JSON.stringify(value),{mode:0o600});vi.stubEnv("OPENCLAW_SLACK_DURABLE_INGRESS_CONFIG",file);
  loadFence.mockReturnValue({scopes:{"slack/C1/123.000001":1},sessionScopes:{[value.sessionKey]:"slack/C1/123.000001"}});
  return {dir,file,value};
}
it("default-off does not inspect native configuration",()=>{vi.stubEnv("OPENCLAW_SLACK_DURABLE_INGRESS_CONFIG",undefined);expect(loadSlackDurableMonitorConfig("default","socket")).toBeUndefined();expect(loadFence).not.toHaveBeenCalled();});
it("loads private exact scope paired with native session fence",()=>{const {value}=setup();const actual=loadSlackDurableMonitorConfig("default","socket");expect(actual).toEqual(value);expect(Object.isFrozen(actual?.scope)).toBe(true);});
it("does not enroll another account",()=>{setup();expect(loadSlackDurableMonitorConfig("other","socket")).toBeUndefined();expect(loadFence).not.toHaveBeenCalled();});
it("refuses an absent native fence and unsupported transport",()=>{setup();loadFence.mockReturnValue(undefined);expect(()=>loadSlackDurableMonitorConfig("default","socket")).toThrow("CONFIG_REFUSED");expect(()=>loadSlackDurableMonitorConfig("default","http")).toThrow("CONFIG_REFUSED");});
it("refuses public or symlink configuration and mismatched session scope",()=>{const {file,dir}=setup();chmodSync(file,0o644);expect(()=>loadSlackDurableMonitorConfig("default","socket")).toThrow("CONFIG_REFUSED");chmodSync(file,0o600);const link=path.join(dir,"link");symlinkSync(file,link);vi.stubEnv("OPENCLAW_SLACK_DURABLE_INGRESS_CONFIG",link);expect(()=>loadSlackDurableMonitorConfig("default","socket")).toThrow("CONFIG_REFUSED");vi.stubEnv("OPENCLAW_SLACK_DURABLE_INGRESS_CONFIG",file);loadFence.mockReturnValue({scopes:{},sessionScopes:{}});expect(()=>loadSlackDurableMonitorConfig("default","socket")).toThrow("CONFIG_REFUSED");});
