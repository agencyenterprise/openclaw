import { expect, it } from "vitest";
import { wrapSlackDurableReceiver, type SlackIngressQueue, type SlackIngressEnvelope } from "./durable-ingress.js";
it("retains receiver client/prototype/private-field lifecycle and stable method identity", () => {
  class Receiver {
    #started = false;
    client = { shuttingDown: false };
    installed: unknown;
    init(app: {processEvent(event:SlackIngressEnvelope):Promise<unknown>}) {this.installed=app;}
    start() {this.#started=true;return this.#started;}
    stop() {this.#started=false;return this.client.shuttingDown;}
    get started() {return this.#started;}
  }
  const receiver=new Receiver();
  const wrapped=wrapSlackDurableReceiver({receiver,scope:{accountId:"a",teamId:"T1",appId:"A1",channelId:"C1",threadTs:"123.000001"},queue:{} as SlackIngressQueue});
  expect(wrapped).toBeInstanceOf(Receiver);
  expect(Reflect.get(wrapped,"client")).toBe(receiver.client);
  expect(wrapped.start).toBe(wrapped.start);
  wrapped.init({processEvent:async()=>{}});
  expect(receiver.installed).toBeDefined();
  expect(wrapped.start()).toBe(true);
  expect(Reflect.get(wrapped,"started")).toBe(true);
  Reflect.get(wrapped,"client").shuttingDown=true;
  expect(wrapped.stop()).toBe(true);
  expect(receiver.started).toBe(false);
});
