import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCanonicalSlackThreadTs } from "./handler.js";

describe("resolveCanonicalSlackThreadTs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Slack thread_ts when a child message timestamp is supplied", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            messages: [{ ts: "1779146786.539489", thread_ts: "1779146782.379509" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveCanonicalSlackThreadTs("xoxb-test", "C0AHSKBNDB6", "1779146786.539489"),
    ).resolves.toBe("1779146782.379509");
  });

  it("keeps the root timestamp when Slack returns a root message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              messages: [{ ts: "1779140034.462749" }],
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(
      resolveCanonicalSlackThreadTs("xoxb-test", "C0AHSKBNDB6", "1779140034.462749"),
    ).resolves.toBe("1779140034.462749");
  });

  it("falls back to conversations.history when replies rejects a child timestamp", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "thread_not_found" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            messages: [{ ts: "1779825062.887000", thread_ts: "1779824865.397609" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveCanonicalSlackThreadTs("xoxb-test", "C0A3C98HS48", "1779825062.887000"),
    ).resolves.toBe("1779824865.397609");
  });

  it("uses the nearest preceding threaded Slack message for synthetic callback timestamps", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "thread_not_found" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, messages: [] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts: "1779824930.461769", thread_ts: "1779824799.670059" },
              { ts: "1779824929.000000" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveCanonicalSlackThreadTs("xoxb-test", "C0AHSKBNDB6", "1779824930.503000"),
    ).resolves.toBe("1779824799.670059");
  });
});
