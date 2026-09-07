import { describe, expect, it } from "vitest";
import { buildRetrievalQuery, InboundMessageStash, turnKey } from "./inbound-messages.js";

const SESSION = "agent:main:slack:channel:c0a3c98hs48";
const THREAD_A = "1786591963.108609";
const THREAD_B = "1786591999.000001";

describe("InboundMessageStash", () => {
  it("finds a stashed message by session, thread and id", () => {
    const stash = new InboundMessageStash();
    stash.record(SESSION, { messageId: "1", text: "first", threadId: THREAD_A });
    expect(stash.find(SESSION, THREAD_A, "1")?.text).toBe("first");
    expect(stash.find(SESSION, THREAD_B, "1")).toBeUndefined();
    expect(stash.find(SESSION, THREAD_A, "2")).toBeUndefined();
    expect(stash.find("agent:main:main", THREAD_A, "1")).toBeUndefined();
  });

  it("keeps threads apart so a busy sibling thread cannot evict the previous message", () => {
    const stash = new InboundMessageStash();
    stash.record(SESSION, { messageId: "a1", text: "A one", threadId: THREAD_A });
    for (let i = 0; i < 10; i += 1) {
      stash.record(SESSION, { messageId: `b${i}`, text: `B ${i}`, threadId: THREAD_B });
    }
    stash.record(SESSION, { messageId: "a2", text: "A two", threadId: THREAD_A });

    expect(stash.findThreadContext(SESSION, stash.find(SESSION, THREAD_A, "a2")!)?.messageId).toBe(
      "a1",
    );
    expect(stash.findThreadContext(SESSION, stash.find(SESSION, THREAD_A, "a1")!)).toBeUndefined();
  });

  it("keeps only the last three messages per thread", () => {
    const stash = new InboundMessageStash();
    for (const id of ["1", "2", "3", "4"]) {
      stash.record(SESSION, { messageId: id, text: id, threadId: THREAD_A });
    }
    expect(stash.find(SESSION, THREAD_A, "1")).toBeUndefined();
    expect(stash.find(SESSION, THREAD_A, "2")).toBeDefined();
  });

  it("dedupes a redelivery in place, keeping the original order", () => {
    const stash = new InboundMessageStash();
    stash.record(SESSION, { messageId: "1", text: "one", threadId: THREAD_A });
    stash.record(SESSION, { messageId: "2", text: "two", threadId: THREAD_A });
    stash.record(SESSION, { messageId: "1", text: "one (edited)", threadId: THREAD_A });

    expect(stash.find(SESSION, THREAD_A, "1")?.text).toBe("one (edited)");
    expect(stash.findThreadContext(SESSION, stash.find(SESSION, THREAD_A, "2")!)?.text).toBe(
      "one (edited)",
    );
  });

  it("ignores a redelivery of a message already evicted from the retained history", () => {
    const stash = new InboundMessageStash();
    for (const id of ["1", "2", "3", "4"]) {
      stash.record(SESSION, { messageId: id, text: id, threadId: THREAD_A });
    }
    stash.record(SESSION, { messageId: "1", text: "one again", threadId: THREAD_A });

    expect(stash.find(SESSION, THREAD_A, "1")).toBeUndefined();
    expect(
      stash.findThreadContext(SESSION, { messageId: "5", text: "n", threadId: THREAD_A })
        ?.messageId,
    ).toBe("4");
  });

  it("still recognises a redelivery long after the retained history dropped it", () => {
    const stash = new InboundMessageStash();
    for (let i = 0; i < 30; i += 1) {
      stash.record(SESSION, { messageId: `m${i}`, text: `m${i}`, threadId: THREAD_A });
    }
    stash.record(SESSION, { messageId: "m0", text: "m0 redelivered", threadId: THREAD_A });

    expect(stash.find(SESSION, THREAD_A, "m0")).toBeUndefined();
    expect(
      stash.findThreadContext(SESSION, { messageId: "m30", text: "n", threadId: THREAD_A })
        ?.messageId,
    ).toBe("m29");
  });

  it("forgets an id once it falls out of the per-thread redelivery window", () => {
    const stash = new InboundMessageStash({ maxSeenIdsPerThread: 4 });
    for (const id of ["1", "2", "3", "4", "5"]) {
      stash.record(SESSION, { messageId: id, text: id, threadId: THREAD_A });
    }
    stash.record(SESSION, { messageId: "1", text: "one again", threadId: THREAD_A });

    expect(stash.find(SESSION, THREAD_A, "1")?.text).toBe("one again");
  });

  it("scopes the redelivery window per thread", () => {
    const stash = new InboundMessageStash();
    for (const id of ["1", "2", "3", "4"]) {
      stash.record(SESSION, { messageId: id, text: id, threadId: THREAD_A });
    }
    stash.record(SESSION, { messageId: "1", text: "same id, other thread", threadId: THREAD_B });

    expect(stash.find(SESSION, THREAD_B, "1")?.text).toBe("same id, other thread");
  });

  it("gives no thread context outside a thread, and uses all history for an unknown id", () => {
    const stash = new InboundMessageStash();
    stash.record(SESSION, { messageId: "a1", text: "A one", threadId: THREAD_A });
    stash.record(SESSION, { messageId: "x", text: "top level" });
    expect(stash.findThreadContext(SESSION, { messageId: "x", text: "top level" })).toBeUndefined();
    expect(
      stash.findThreadContext(SESSION, { messageId: "new", text: "n", threadId: THREAD_A })
        ?.messageId,
    ).toBe("a1");
  });

  it("evicts the oldest thread past the cap", () => {
    const stash = new InboundMessageStash({ maxThreads: 1 });
    stash.record("a", { messageId: "1", text: "a", threadId: "t" });
    stash.record("b", { messageId: "2", text: "b", threadId: "t" });
    expect(stash.find("a", "t", "1")).toBeUndefined();
    expect(stash.find("b", "t", "2")).toBeDefined();
  });

  it("remembers rejected bot message ids per session until a human record clears them", () => {
    const stash = new InboundMessageStash();
    stash.rejectBotMessage(SESSION, "1");
    expect(stash.isRejectedBotMessage(SESSION, "1")).toBe(true);
    expect(stash.isRejectedBotMessage("agent:main:main", "1")).toBe(false);
    stash.record(SESSION, { messageId: "1", text: "human after all" });
    expect(stash.isRejectedBotMessage(SESSION, "1")).toBe(false);
  });
});

describe("turnKey", () => {
  it("does not collide when the separator appears inside the parts", () => {
    expect(turnKey("a:b", "c")).not.toBe(turnKey("a", "b:c"));
    expect(turnKey("a", "b")).toBe(turnKey("a", "b"));
  });
});

describe("buildRetrievalQuery", () => {
  it("joins the message with its thread context and caps the length", () => {
    expect(buildRetrievalQuery(" now ", { messageId: "1", text: " before " })).toBe("now\nbefore");
    expect(buildRetrievalQuery("x".repeat(2000))).toHaveLength(1000);
  });
});
