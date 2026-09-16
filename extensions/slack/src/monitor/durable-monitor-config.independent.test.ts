import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const {loadFence}=vi.hoisted(()=>({loadFence:vi.fn()}));
vi.mock('openclaw/plugin-sdk/reply-runtime',()=>({loadDispatchConfig:loadFence}));
import { loadSlackDurableMonitorConfig } from './durable-monitor-config.js';
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();loadFence.mockReset();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function root(){const d=mkdtempSync(path.join(os.tmpdir(),'monitor-independent-'));dirs.push(d);chmodSync(d,0o700);return d;}
it('actual FIFO config refuses promptly without waiting for a writer',()=>{
 const d=root(),f=path.join(d,'config');execFileSync('/usr/bin/mkfifo',[f],{timeout:2000});
 vi.stubEnv('OPENCLAW_SLACK_DURABLE_INGRESS_CONFIG',f);const started=performance.now();
 expect(()=>loadSlackDurableMonitorConfig('default','socket')).toThrow('CONFIG_REFUSED');
 expect(performance.now()-started).toBeLessThan(1000);expect(loadFence).not.toHaveBeenCalled();
});
it('oversized private config is refused before parsing or fence lookup',()=>{
 const f=path.join(root(),'config');writeFileSync(f,' '.repeat(16385),{mode:0o600});vi.stubEnv('OPENCLAW_SLACK_DURABLE_INGRESS_CONFIG',f);
 expect(()=>loadSlackDurableMonitorConfig('default','socket')).toThrow('CONFIG_REFUSED');expect(loadFence).not.toHaveBeenCalled();
});
it('state directory cannot be public even with exact selected account/scope',()=>{
 const d=root(),state=path.join(d,'state');execFileSync('/bin/mkdir',[state]);chmodSync(state,0o755);
 const f=path.join(d,'config');writeFileSync(f,JSON.stringify({version:1,scope:{accountId:'default',teamId:'T1',appId:'A1',channelId:'C1',threadTs:'100.000001'},sessionKey:'agent:main:slack:channel:c1:thread:100.000001',stateDir:state}),{mode:0o600});
 vi.stubEnv('OPENCLAW_SLACK_DURABLE_INGRESS_CONFIG',f);
 expect(()=>loadSlackDurableMonitorConfig('default','socket')).toThrow('CONFIG_REFUSED');expect(loadFence).not.toHaveBeenCalled();
});
