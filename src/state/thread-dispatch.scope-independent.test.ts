import {expect,it} from 'vitest';
import {resolveDispatchScope,validateDispatchConfig} from './thread-dispatch.js';
const scope='slack/C123/100.000001';
const selected='agent:main:slack:channel:c123:thread:100.000001';
const cron='agent:main:cron:12345678-1234-4123-8123-123456789abc';
const base=()=>({databasePath:'/unused/fence.sqlite',scopes:{[scope]:1},sessionScopes:{[selected]:scope},unscopedSessionKeys:['agent:main:main'],unscopedCronSessionKeys:[cron]});
it('selected lowercase and uppercase channels always resolve protected',()=>{
 const config=validateDispatchConfig(base());expect(resolveDispatchScope(config,selected)).toBe(scope);
 expect(resolveDispatchScope(config,'agent:main:slack:channel:C123:thread:100.000001')).toBe(scope);
 expect(resolveDispatchScope(config,'agent:main:slack:channel:c999:thread:100.000001')).toBeUndefined();
});
it('exact unrelated session admission does not permit its prefix relatives',()=>{
 const config=validateDispatchConfig(base());expect(resolveDispatchScope(config,'agent:main:main')).toBeUndefined();
 for(const key of ['agent:main:main:extra','agent:other:main','agent:main:unknown',' agent:main:main',undefined])expect(()=>resolveDispatchScope(config,key)).toThrow();
});
it('cron base permits only its exact valid run UUID descendant',()=>{
 const config=validateDispatchConfig(base());expect(resolveDispatchScope(config,cron)).toBeUndefined();
 expect(resolveDispatchScope(config,cron+':run:abcdefab-1234-4123-8123-123456789abc')).toBeUndefined();
 for(const key of [cron+':run:bad',cron+':run:abcdefab-1234-4123-8123-123456789abc:extra',cron+':child:123',cron.replace('main','other')])expect(()=>resolveDispatchScope(config,key)).toThrow();
});
it('host allowlist cannot contradict mapped or parsed selected scope',()=>{
 for(const key of [selected,'agent:main:slack:channel:C123:thread:100.000001'])expect(()=>validateDispatchConfig({...base(),unscopedSessionKeys:[key]})).toThrow();
 expect(()=>validateDispatchConfig({...base(),sessionScopes:{...base().sessionScopes,'agent:main:main':scope}})).toThrow();
});
it('malformed Slack thread cannot use generic unrelated fallback',()=>{
 const config=validateDispatchConfig(base());
 for(const key of ['agent:main:slack:channel:c123:thread:100.1','agent:main:slack:channel:c123:thread:100.000001:extra','agent:main:slack:channel::thread:100.000001'])expect(()=>resolveDispatchScope(config,key)).toThrow();
});
