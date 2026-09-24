import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebClient } from "@slack/web-api";
import { afterEach, expect, it, vi } from "vitest";
import {
  beginNativeCleanupAttempt,
  withNativeCleanupTracking,
} from "../../../src/agents/embedded-agent-runner/native-cleanup-proof.js";
import { requireNodeSqlite } from "../../../src/infra/node-sqlite.js";
import {
  runLogicalNativeAttempt,
  withLogicalReplyDispatch,
  type DispatchConfig,
} from "../../../src/state/thread-dispatch.js";
import { SLACK_READ_METHODS, SLACK_WRITE_METHODS } from "./slack-api-methods.js";
import {
  accountTurnWrite,
  classifySlackRequest,
  installSlackWriteAccounting,
  slackAnswerOutcome,
  slackRejectionOutcome,
  slackUploadOutcome,
} from "./slack-write-accounting.js";

installSlackWriteAccounting();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "slack-write-accounting-"));
  roots.push(root);
  const databasePath = join(root, "state.sqlite");
  const fixtureSource = readFileSync(
    new URL(
      "../../../src/agents/embedded-agent-runner/run.thread-dispatch.test.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const schema = JSON.parse(fixtureSource.match(/const fenceSql =\s*("(?:[^"\\]|\\.)*");/)![1]);
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(schema);
  chmodSync(databasePath, 0o600);
  const scope = "slack/C123/1788816064.061969";
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
  const config: DispatchConfig = {
    databasePath,
    scopes: { [scope]: 1 },
    sessionScopes: { session: scope },
  };
  const state = () => db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state;
  return { db, config, state };
}

type Transport = (url: string) => Promise<{ status: number; data: unknown }>;
function slackClient(transport: Transport) {
  return new WebClient("xoxb-test", {
    retryConfig: { retries: 0 },
    adapter: async (config) => {
      const url = String(config.url);
      const response = await transport(url);
      return {
        ...response,
        statusText: "OK",
        headers: {},
        config,
        request: { path: new URL(url).pathname },
      };
    },
  });
}
const answered: Transport = async () => ({
  status: 200,
  data: { ok: true, channel: "C123", ts: "1.000001" },
});
const lostResponse: Transport = async () => {
  throw Object.assign(new Error("socket hang up"), { request: {} });
};

async function turnUsing(config: DispatchConfig, use: () => Promise<unknown>, source = "a") {
  await withLogicalReplyDispatch({
    config,
    sessionKey: "session",
    sourceTurnId: `channel-user:v1:${source.repeat(64)}`,
    prompt: "prompt",
    run: async () => {
      await runLogicalNativeAttempt({
        sessionKey: "session",
        cleanupIdentity: "cleanup-identity",
        refused: () => ({ meta: {} }),
        run: () =>
          withNativeCleanupTracking("cleanup-identity", async () => {
            beginNativeCleanupAttempt()(true);
            return { meta: {} };
          }),
      });
      await use();
    },
  });
}

it("a Slack write that Slack answered settles the turn TERMINAL", async () => {
  const { db, config, state } = fixture();
  try {
    await turnUsing(config, () =>
      slackClient(answered).apiCall("chat.postMessage", { channel: "C123", text: "hi" }),
    );
    expect(state()).toBe("TERMINAL");
  } finally {
    db.close();
  }
});

it("a Slack write whose response was lost keeps the turn UNKNOWN", async () => {
  const { db, config, state } = fixture();
  try {
    await turnUsing(config, () =>
      slackClient(lostResponse)
        .apiCall("chat.postMessage", { channel: "C123", text: "hi" })
        .catch(() => undefined),
    );
    expect(state()).toBe("UNKNOWN");
  } finally {
    db.close();
  }
});

it("a write Slack answered with ok:false (channel_not_found) is a known refusal: TERMINAL", async () => {
  const { db, config, state } = fixture();
  const refused: Transport = async () => ({
    status: 200,
    data: { ok: false, error: "channel_not_found" },
  });
  try {
    await turnUsing(config, () =>
      slackClient(refused)
        .apiCall("chat.postMessage", { channel: "C404", text: "hi" })
        .catch(() => undefined),
    );
    expect(state()).toBe("TERMINAL");
  } finally {
    db.close();
  }
});

it.each([
  [{ status: 200, data: { ok: true, ts: "1.1" } }, "completed"],
  [{ status: 200, data: '{"ok":true,"ts":"1.1"}' }, "completed"],
  [{ status: 200, data: { ok: false, error: "not_in_channel" } }, "not_sent"],
  [{ status: 200, data: '{"ok":false,"error":"not_in_channel"}' }, "not_sent"],
  [{ status: 200, data: "not json" }, "unknown"],
  [{ status: 200, data: {} }, "unknown"],
  [{ status: 200, data: { ok: "true" } }, "unknown"],
  [{ status: 200, data: { ok: 1 } }, "unknown"],
  [{ status: 200, data: '"ok"' }, "unknown"],
  [{ status: 200, data: null }, "unknown"],
  [{ status: 200 }, "unknown"],
  [null, "unknown"],
  [undefined, "unknown"],
])("an answer %j settles %s", (response, outcome) => {
  expect(slackAnswerOutcome(response)).toBe(outcome);
});

it.each([
  { name: "data", target: {}, key: "data" },
  { name: "ok", target: { data: {} }, key: "ok" },
])("an answer whose $name accessor throws settles unknown", ({ target, key }) => {
  const holder = key === "data" ? target : (target as { data: object }).data;
  Object.defineProperty(holder, key, {
    get() {
      throw new Error("unreadable response");
    },
  });
  expect(slackAnswerOutcome(target)).toBe("unknown");
});

it.each([
  [{ status: 200, data: "OK - 5" }, "completed"],
  [{ status: 500, data: "error" }, "unknown"],
  [{ data: "OK - 5" }, "unknown"],
  [undefined, "unknown"],
])("an external upload answer %j settles %s", (response, outcome) => {
  expect(slackUploadOutcome(response)).toBe(outcome);
});

it("the real web-api 7.18.0 success shape reads as ok:true: a JSON-string body still settles TERMINAL", async () => {
  const { db, config, state } = fixture();
  const stringBody: Transport = async () => ({
    status: 200,
    data: JSON.stringify({ ok: true, channel: "C123", ts: "1.000001" }),
  });
  try {
    await turnUsing(config, async () => {
      const result = await slackClient(stringBody).apiCall("chat.postMessage", {
        channel: "C123",
        text: "hi",
      });
      expect(result).toMatchObject({ ok: true, ts: "1.000001" });
    });
    expect(state()).toBe("TERMINAL");
  } finally {
    db.close();
  }
});

it("a real filesUploadV2 (URL, external upload, complete) settles TERMINAL", async () => {
  const { db, config, state } = fixture();
  const seen: string[] = [];
  const uploadFlow: Transport = async (url) => {
    seen.push(new URL(url).pathname);
    if (url.endsWith("/files.getUploadURLExternal")) {
      return {
        status: 200,
        data: { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" },
      };
    }
    if (url.startsWith("https://files.slack.com/upload/")) {
      return { status: 200, data: "OK - 5" };
    }
    return { status: 200, data: { ok: true, files: [{ id: "F1" }] } };
  };
  try {
    await turnUsing(config, () =>
      slackClient(uploadFlow).filesUploadV2({
        channel_id: "C123",
        filename: "a.txt",
        content: "hello",
      }),
    );
    expect(seen).toEqual([
      "/api/files.getUploadURLExternal",
      "/upload/v1/abc",
      "/api/files.completeUploadExternal",
    ]);
    expect(state()).toBe("TERMINAL");
  } finally {
    db.close();
  }
});

it("a failed Slack read is not a send and does not block settlement", async () => {
  const { db, config, state } = fixture();
  try {
    await turnUsing(config, () =>
      slackClient(lostResponse)
        .conversations.info({ channel: "C123" })
        .catch(() => undefined),
    );
    expect(state()).toBe("TERMINAL");
  } finally {
    db.close();
  }
});

it("writes outside a thread-dispatch turn pass through untouched", async () => {
  await expect(
    slackClient(answered).apiCall("chat.postMessage", { channel: "C123", text: "hi" }),
  ).resolves.toMatchObject({ ok: true });
});

it.each([
  { name: "answered", transport: answered },
  { name: "with its response lost", transport: lostResponse },
])(
  "a stale write queued outside every turn ($name) does not taint a later turn in its thread",
  async ({ transport }) => {
    const { db, config, state } = fixture();
    let release!: () => void;
    // Queued before the turn opens, so its continuation runs with no turn context.
    const stale = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() =>
      slackClient(transport)
        .apiCall("chat.postMessage", { channel: "C123", thread_ts: "1788816064.061969", text: "x" })
        .catch(() => undefined),
    );
    try {
      await turnUsing(config, async () => {
        release();
        await stale;
      });
      expect(state()).toBe("TERMINAL");
    } finally {
      db.close();
    }
  },
);

it("a void'd write after the turn settled runs untracked and raises no unhandled rejection", async () => {
  const { db, config, state } = fixture();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let release!: () => void;
  let lateWrite!: Promise<unknown>;
  let lateSent!: Promise<void>;
  try {
    await turnUsing(config, async () => {
      // Registered inside the turn, so the late write runs with the settled turn's context.
      lateSent = new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        lateWrite = slackClient(answered).apiCall("chat.postMessage", {
          channel: "C123",
          text: "late",
        });
        void lateWrite;
      });
    });
    expect(state()).toBe("TERMINAL");
    release();
    await lateSent;
    await expect(lateWrite).resolves.toMatchObject({ ok: true });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    db.close();
  }
});

it.each(["chat.scheduledMessages.list", "admin.conversations.list", "users.getPresence"])(
  "a lost response on the read %s is not a send: TERMINAL",
  async (method) => {
    const { db, config, state } = fixture();
    try {
      await turnUsing(config, () =>
        slackClient(lostResponse)
          .apiCall(method, {})
          .catch(() => undefined),
      );
      expect(state()).toBe("TERMINAL");
    } finally {
      db.close();
    }
  },
);

it("a synchronous throw from the transport settles the send as unknown", () => {
  const settle = vi.fn();
  expect(() =>
    accountTurnWrite(() => {
      throw new Error("bad arguments");
    }, settle),
  ).toThrow("bad arguments");
  expect(settle).toHaveBeenCalledExactlyOnceWith("unknown");
});

it("an answered request whose body cannot be read settles unknown and still returns the response", async () => {
  const settle = vi.fn();
  const response = Object.defineProperty({}, "data", {
    get() {
      throw new Error("unreadable response");
    },
  });
  await expect(accountTurnWrite(async () => response, settle)).resolves.toBe(response);
  expect(settle).toHaveBeenCalledExactlyOnceWith("unknown");
});

it("an answer reader that throws still settles the send once, as unknown", async () => {
  const settle = vi.fn();
  const reader = () => {
    throw new Error("reader bug");
  };
  await expect(accountTurnWrite(async () => ({}), settle, reader)).rejects.toThrow("reader bug");
  expect(settle).toHaveBeenCalledExactlyOnceWith("unknown");
});

it.each([
  [{ code: "slack_webapi_rate_limited_error" }, "not_sent"],
  [{ code: "slack_webapi_http_error", statusCode: 404 }, "unknown"],
  [{ code: "slack_webapi_http_error", statusCode: 408 }, "unknown"],
  [{ code: "slack_webapi_http_error", statusCode: 502 }, "unknown"],
  [{ code: "slack_webapi_request_error" }, "unknown"],
  [new Error("socket hang up"), "unknown"],
  [undefined, "unknown"],
])("a rejection %j settles %s", (error, outcome) => {
  expect(slackRejectionOutcome(error)).toBe(outcome);
});

const ACCOUNTING_UNAVAILABLE = Symbol.for("openclaw.threadDispatch.accountingUnavailable");
function clearAccountingUnavailable() {
  (globalThis as Record<symbol, { reasons: Set<string> }>)[ACCOUNTING_UNAVAILABLE].reasons.clear();
}

it.each([
  {
    name: "missing",
    breakTransport: (prototype: object) =>
      Object.defineProperty(prototype, "makeRequest", {
        value: undefined,
        writable: true,
        configurable: true,
      }),
  },
  {
    name: "not writable",
    breakTransport: (prototype: object) =>
      Object.defineProperty(prototype, "makeRequest", {
        value: async () => ({ ok: true }),
        writable: false,
        configurable: true,
      }),
  },
])(
  "a transport that is $name does not throw at install and every turn settles UNKNOWN",
  async ({ breakTransport }) => {
    const prototype = WebClient.prototype as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "makeRequest")!;
    const { db, config, state } = fixture();
    try {
      breakTransport(prototype);
      vi.resetModules();
      const copy = await import("./slack-write-accounting.js");
      expect(() => copy.installSlackWriteAccounting()).not.toThrow();
      Object.defineProperty(prototype, "makeRequest", descriptor);
      await turnUsing(config, () =>
        slackClient(answered).apiCall("chat.postMessage", { channel: "C123", text: "hi" }),
      );
      expect(state()).toBe("UNKNOWN");
    } finally {
      Object.defineProperty(prototype, "makeRequest", descriptor);
      clearAccountingUnavailable();
      db.close();
    }
  },
);

it("a second loaded copy of the module does not wrap the transport again", async () => {
  const wrapped = WebClient.prototype.makeRequest;
  vi.resetModules();
  const copy = await import("./slack-write-accounting.js");
  expect(copy.installSlackWriteAccounting).not.toBe(installSlackWriteAccounting);
  copy.installSlackWriteAccounting();
  expect(WebClient.prototype.makeRequest).toBe(wrapped);
});

it.each([
  ["https://slack.com/api/conversations.info", "read"],
  ["https://slack.com/api/conversations.replies", "read"],
  ["https://slack.com/api/users.profile.get", "read"],
  ["https://slack.com/api/chat.getPermalink", "read"],
  ["https://slack.com/api/auth.test", "read"],
  ["https://slack.com/api/admin.conversations.list", "read"],
  ["https://slack.com/api/chat.scheduledMessages.list", "read"],
  ["https://slack.com/api/users.getPresence", "read"],
  ["https://slack.com/api/users.lookupByEmail", "read"],
  ["https://slack.com/api/files.getUploadURLExternal", "write"],
  ["https://slack.com/api/users.identity", "read"],
  ["https://slack.com/api/team.accessLogs", "read"],
  ["https://slack.com/api/team.integrationLogs", "read"],
  ["https://slack.com/api/migration.exchange", "read"],
  ["https://slack.com/api/conversations.mark", "write"],
  ["https://slack.com/api/views.publish", "write"],
  ["https://slack.com/api/chat.startStream", "write"],
  ["https://slack.com/api/brand.new.method", "write"],
  ["https://slack.com/api/users.listen", "write"],
  ["https://slack.com/api/users.setPresence", "write"],
  ["https://slack.com/api/conversations.open", "write"],
  ["https://slack.com/api/chat.postMessage", "write"],
  ["https://slack.com/api/chat.update", "write"],
  ["https://slack.com/api/reactions.add", "write"],
  ["https://slack.com/api/files.completeUploadExternal", "write"],
  ["https://files.slack.com/upload/v1/abc", "write"],
  ["not a url", "write"],
  ["https://slack.com/api/assistant.threads.setStatus", "write"],
  ["https://slack.com/api/apps.connections.open", "write"],
])("classifies %s as %s", (url, kind) => {
  expect(classifySlackRequest(url)).toBe(kind);
});

function installedWebApiMethods(): string[] {
  const entry = createRequire(import.meta.url).resolve("@slack/web-api");
  const methodsPath = join(dirname(entry), "methods.js");
  const source = readFileSync(methodsPath, "utf8");
  return [...source.matchAll(/bindApiCall(?:WithOptionalArgument)?\(this, '([\w.]+)'\)/g)].map(
    (match) => match[1],
  );
}

function installedWebApiVersion(): string {
  const entry = createRequire(import.meta.url).resolve("@slack/web-api");
  return JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")).version;
}

it("the read and write tables are exactly the methods of the pinned @slack/web-api 7.18.0", () => {
  expect(installedWebApiVersion()).toBe("7.18.0");
  const installed = installedWebApiMethods();
  const installedSet = new Set(installed);
  expect(installed).toHaveLength(272);
  expect(installedSet.size).toBe(272);
  expect(SLACK_READ_METHODS.size + SLACK_WRITE_METHODS.size).toBe(272);
  expect([...SLACK_READ_METHODS].filter((method) => SLACK_WRITE_METHODS.has(method))).toEqual([]);
  const listed = new Set([...SLACK_READ_METHODS, ...SLACK_WRITE_METHODS]);
  expect(installed.filter((method) => !listed.has(method))).toEqual([]);
  expect([...listed].filter((method) => !installedSet.has(method))).toEqual([]);
});

// Every Web API method this repository calls (a scan of its non-test sources), plus
// apps.connections.open, which @slack/socket-mode calls through the same transport.
it.each([
  ["apps.connections.open", "write"],
  ["assistant.threads.setStatus", "write"],
  ["assistant.threads.setSuggestedPrompts", "write"],
  ["auth.test", "read"],
  ["calls.add", "write"],
  ["chat.appendStream", "write"],
  ["chat.delete", "write"],
  ["chat.postEphemeral", "write"],
  ["chat.postMessage", "write"],
  ["chat.startStream", "write"],
  ["chat.stopStream", "write"],
  ["chat.update", "write"],
  ["conversations.history", "read"],
  ["conversations.info", "read"],
  ["conversations.list", "read"],
  ["conversations.members", "read"],
  ["conversations.open", "write"],
  ["conversations.replies", "read"],
  ["emoji.list", "read"],
  ["files.completeUploadExternal", "write"],
  ["files.getUploadURLExternal", "write"],
  ["files.info", "read"],
  ["files.list", "read"],
  ["oauth.access", "write"],
  ["pins.add", "write"],
  ["pins.list", "read"],
  ["pins.remove", "write"],
  ["reactions.add", "write"],
  ["reactions.get", "read"],
  ["reactions.remove", "write"],
  ["reminders.add", "write"],
  ["reminders.list", "read"],
  ["usergroups.users.list", "read"],
  ["users.info", "read"],
  ["users.list", "read"],
  ["views.publish", "write"],
  ["views.push", "write"],
])("the app's call %s is a %s", (method, kind) => {
  expect(classifySlackRequest(`https://slack.com/api/${method}`)).toBe(kind);
});
