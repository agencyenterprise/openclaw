---
name: outbound-dedupe
description: "Cancels a bot send that repeats a message already posted in the same thread within the window (Constitution Article 7, Signal)"
metadata:
  {
    "openclaw":
      {
        "emoji": "🔇",
        "events": ["gateway:startup", "message:sent"],
        "requires": {},
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Outbound Dedupe Hook

Implements **Constitution Article 7 (Signal)**: never post the same paragraph twice. The
audit found 190 identical `[hcom-bridge] reconciliation required` posts.

Two independent signals run before a send, and either one cancels it:

| Signal                 | Key                                                          | Catches                                                                |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Content hash           | `<channelId>:<target>:<thread>` + normalized text hash       | the same paragraph posted twice in one thread                          |
| Obligation reservation | `<channel>:<threadRootTs>:<obligationId>:v<responseVersion>` | a second answer to one ask, however it is worded and wherever it lands |

## What It Does

Internal hooks cannot cancel a send, so this hook registers a cancel-capable
`message_sending` **core hook** (`src/plugins/core-hooks.ts`) when its module loads, which is
while the gateway loads internal hooks and before `gateway:startup`. Core hooks are composed
into every plugin hook dispatch and survive plugin registry re-activation. `gateway:startup`
only verifies the registration and logs an error if it is missing.

For every outbound payload (replies, cron announces and heartbeat replies all pass through
`message_sending`):

1. Normalize the text: lowercase, drop dates, clock times, Slack message ids and Slack
   permalinks, drop all whitespace; then hash it. Every other number is kept.
2. Compare with the live entries for the same channel + thread in
   `<workspace>/state/outbound_hashes.json` (last `maxPerThread` per thread).
3. If a live entry matches, cancel the send and log `outbound-dedupe: suppressed duplicate`
   with the thread key. Otherwise reserve the hash as pending.

A reservation is confirmed by the internal `message:sent` event on success (and then counts
for `windowHours`), released on a failed send, and expires unconfirmed after two minutes, so a
retry after a failed send always passes. `message:sent` is matched to its reservation by same
thread + same hash first; if the channel rendered the text after the pre-send hook (hash
differs), the oldest pending reservation in that thread is taken; an announce reserved with an
explicit `threadId` whose `message:sent` session key lacks the thread is matched by hash across
the other threads of the same channel.

Thread keys are `<channelId>:<target>:<thread>`; Slack targets are case-folded and stripped of
their `channel:` prefix, other channels keep the target verbatim.

Messages shorter than `minChars` are never deduplicated, so short acknowledgements such as
"OK" stay allowed. Writes take the advisory lock `outbound_hashes.json.lock` (mkdir, stale
after 10 s).

## Obligation Reservation

The content hash alone missed the 2026-09-03 leak. Slack replayed an ask the user had
deleted during the outage next to the user's live re-post; two runs answered the same
obligation, the answers were paraphrased differently, and they sat under different thread
keys, so nothing matched. One answer reached `#flavio-test` on top of the answer already
in the thread.

So a send that answers an ask also reserves a content-independent key in
`<workspace>/state/outbound_obligations.json`:

    <channel>:<threadRootTs>:<obligationId>:v<responseVersion>

- **`channel`** — the canonical delivery target (Slack ids case-folded, `channel:` stripped).
- **`threadRootTs`** — the root of the thread the **obligation** lives in, which is the ts
  inside the ask id: never the parent ts of the individual message, and never where this
  particular answer happened to land. A threaded reply and a top-level post about the same
  obligation therefore collapse onto one key instead of splitting into two — the exact shape
  of the leak. A caller may override it with `threadRootTs`.
- **`obligationId`** — the ask this send answers, `<channel>:<ts>`, the id format
  `ask-ledger` writes. It is **declared** by the caller through the payload metadata field
  `obligationId` (the caller knows the canonical id: a replayed ask collapses onto the
  original in the ask ledger), or **derived** from the message the send replies to
  (`replyToId`, when it is a Slack ts). The declaring callers are the inbound dispatcher,
  `src/auto-reply/dispatch.ts`, and the reply router,
  `src/auto-reply/reply/route-reply.ts`; both name the ask through
  `src/auto-reply/reply/reply-obligation.ts` and put it on the payload as
  `hookMetadata.obligationId`; `src/infra/outbound/deliver.ts` forwards it into the hook
  event metadata. Nothing is imported from `ask-ledger`; both sides build the
  `<channel>:<ts>` id with `buildAskId` from `src/hooks/slack-thread.ts`.

  The id must name **one inbound message**. The thread root of the session is not a
  stand-in for it: a long-lived thread carries many asks under one root, so a root-derived
  id makes every answer in that thread look like a re-answer of the first and the guard
  cancels it for the whole window. That is the 2026-09-04 mute in `#fractal-ai-gateway`,
  where three asks in thread `1788473062.847669` collapsed onto
  `C0AHSKBNDB6:1788473062.847669` and the third answer was suppressed. The dispatcher
  therefore declares the id from the **inbound message** of the turn, and the router from
  the **pre-transport** reply target — Slack's reply transport rewrites a threaded reply's
  target to the thread root, which is not the ask.

- **`responseVersion`** — `0` is _the_ answer to an obligation. A deliberate follow-up or
  correction opts in by declaring `responseVersion: 1` (then 2, …) and gets its own
  reservation. Nothing increments it automatically, and an unusable declared value falls
  back to 0: a version that moved on its own would make every accidental re-answer look
  new and defeat the guard.

A second send for the same key inside `windowHours` is cancelled **even when the text is
completely different**. Two exceptions, both narrow:

- The run that took the reservation keeps sending under it for `answerBurstSeconds` — one
  answer is delivered as several payloads and `message_sending` fires once per payload.
  After the burst the holder is refused like anybody else.
- Only a **confirmed platform send** keeps the key for `windowHours`: `message:sent` with
  `success: true` **and** a real provider message id (on Slack, a ts — not `unknown`, not
  `suppressed`, not the `parent_deleted` sentinel). A send that reports success while
  naming no message that landed — an ephemeral slash reply, a suppressed silent token, a
  streaming acknowledgement spanning several chunks — leaves the reservation **pending**
  instead: it still blocks an immediate re-answer and it expires after the two-minute
  pending TTL, rather than muting the ask for a day on a send nobody can see.
- A reservation is released when its send failed (`message:sent` with `success: false`), so
  the retry of that answer passes, and it expires unconfirmed after two minutes.
  `message:sent` carries no obligation, so a reservation stores the fingerprint of the text
  it reserved: the report is matched to it by the run plus that fingerprint, falling back to
  the run's oldest pending reservation when the channel rendered the text after the pre-send
  hook. Another send of the same run can therefore not release the answer's reservation.

A send that answers nothing identifiable — a cron announce, a heartbeat, a payload whose
reply target was consumed, **or a Slack reply whose target is the root of the thread it lands
in** — has no obligation and keeps exactly the content-hash behaviour it had before. A reply
addressed to a thread root is addressed to the thread, and a long-lived thread carries many
asks, so that target names no single one: on 2026-09-04 two answers were cancelled under
`C0AHSKBNDB6:1788473062.847669:...` with `source: "reply-target"` for exactly that reason.
Neither the session key nor its thread root is used as a stand-in obligation:
`message_sending` fires once per payload chunk and one long-lived session posts many
unrelated messages, so a session-keyed obligation would cancel the rest of every chunked
answer and every later announce in that session.

**When the store is unreachable the send is cancelled** (fail closed), with an error log and
a cancel reason naming the file. An unreachable store cannot say whether the obligation was
already answered, and a duplicate answer in the channel cannot be taken back, while a send
held back is visible in the audit trail and can be retried. Only sends that answer an
obligation are affected.

Reservations are written with the same discipline as the hashes: read-modify-write inside
`updateJsonFile`, under the advisory lock `outbound_obligations.json.lock`, with an atomic
temp-file rename. The reservation is taken **before** the send, so two concurrent sends for
one obligation cannot both pass — the second one blocks on the lock and then sees the first
one's entry.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "outbound-dedupe": {
          "enabled": true,
          "windowHours": 24,
          "maxPerThread": 20,
          "minChars": 24,
          "answerBurstSeconds": 60
        }
      }
    }
  }
}
```

`windowHours` bounds both signals. `answerBurstSeconds` (default 60, keep it under the
two-minute pending TTL) is how long the run that reserved an obligation may keep sending
its own payloads under that reservation. Every value above is the default; the hook needs
no configuration to behave as described.
