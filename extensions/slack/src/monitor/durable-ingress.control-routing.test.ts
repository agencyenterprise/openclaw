import { expect, it, vi } from "vitest";
import { createSlackDurableIngress, type SlackIngressQueue } from "./durable-ingress.js";
const scope={accountId:"fixture",teamId:"T1",appId:"A1",channelId:"C1",threadTs:"100.000001"};
const body=()=>({type:"event_callback",team_id:"T1",api_app_id:"A1",event_id:"Ev1",event:{type:"message",channel:"C1",user:"U1",ts:"101.000001",thread_ts:"100.000001",text:"stop"}});
it("handled authenticated control does not wait on or enqueue ordinary work",async()=>{
  const enqueue=vi.fn();const ack=vi.fn(async()=>{});
  const journal=createSlackDurableIngress({scope,queue:{enqueue} as unknown as SlackIngressQueue,delegate:vi.fn(),probeControl:async()=>"HANDLED"});
  await journal.receive({body:body(),ack});
  expect(enqueue).not.toHaveBeenCalled();expect(ack).toHaveBeenCalledOnce();
});
it("verified unhandled probe journals original normalized event before ACK",async()=>{
  let saved:unknown;
  const enqueue=vi.fn(async(_id,payload,options)=>{saved=payload.body;return {kind:"pending",record:{payload,metadata:options.metadata}};});
  const ack=vi.fn(async()=>{expect(saved).toMatchObject({event:{text:"stop"}});});
  const journal=createSlackDurableIngress({scope,queue:{enqueue} as unknown as SlackIngressQueue,delegate:vi.fn(),probeControl:async(candidate)=>{(candidate.event as {text:string}).text="probe mutation";return "NOT_HANDLED";}});
  await journal.receive({body:body(),ack});expect(ack).toHaveBeenCalledOnce();expect(enqueue).toHaveBeenCalledOnce();
});
it("uncertain control never becomes normal scientific dispatch or ACK",async()=>{
  const enqueue=vi.fn();const ack=vi.fn(async()=>{});const delegate=vi.fn();
  const journal=createSlackDurableIngress({scope,queue:{enqueue} as unknown as SlackIngressQueue,delegate,probeControl:async()=>"UNVERIFIED"});
  await expect(journal.receive({body:body(),ack})).rejects.toThrow("CONTROL_UNVERIFIED");
  expect(enqueue).not.toHaveBeenCalled();expect(ack).not.toHaveBeenCalled();expect(delegate).not.toHaveBeenCalled();
});
