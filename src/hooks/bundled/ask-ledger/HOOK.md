---
name: ask-ledger
description: "Records every direct ask to the bot, keeps one obligation per source message, and marks it answered on the bot's reply (Constitution Article 3, Initiative)"
metadata:
  {
    "openclaw":
      {
        "emoji": "📥",
        "events": ["gateway:startup", "message:received", "message:sent", "message:deleted"],
        "requires": {},
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Ask Ledger Hook

Implements **Constitution Article 3 (Initiative)**: every direct ask must be answered or
acknowledged. The hook keeps an append-only ledger of asks so a cron job can find the ones
nobody answered ("status now?", "How do we keep going?", Klipfel's first Linear ask).

## What It Does

- `message:received` (before the model runs): when a Slack message is a DM, mentions the
  bot, or is a reply inside a thread the bot is part of, append one open record to
  `<workspace>/state/asks.jsonl`. The id is `<channel>:<ts>`.
- An ask that is already owned by another one is marked in the same append — an `alias_of`
  line for the same source message, a `duplicate` line for a repeat of the text — and its
  turn is stopped (see below).
- `message:deleted`: append a `deleted` tombstone for the ask, and stop its turn if it is
  still in flight.
- `message:sent` (after a **confirmed** Slack send — one the platform acknowledged with a
  message id, or the `parent_deleted` sentinel that says the answer's thread parent was gone
  so the answer had nowhere to go): append an `answered` line for the asks the reply answers.
  A send that reports success without a platform message id closes nothing and is logged. A threaded reply answers every pending ask in that thread; a top-level reply
  (DM or channel post) answers only the newest pending top-level ask in that channel, so one
  proactive post cannot silently close older asks. An alias, a duplicate and a tombstone are
  never pending, so no reply ever answers them.
- `gateway:startup`: logs whether the turn gate is registered.

The ledger is append-only: the latest line per id wins, and **an id only becomes an ask when
its first line has `status: "open"`** — a status line that arrives before the ask, or for a
message that was never an ask, produces nothing. `scripts/asks.py` in the workspace folds the
same way; it appends `acknowledged` lines (`--ack`) and reconciliation `answered` lines, and
excludes `answered`, `duplicate`, `deleted` and anything with `alias_of` from `--open`.
Every writer takes the advisory lock `asks.jsonl.lock` (a directory created with mkdir,
stale after 10 s) before appending.

Lines:

```json
{"id":"C0A3C98HS48:1786591963.108609","channel":"C0A3C98HS48","thread_ts":"1786591963.108609","user":"U012","text":"status now?","received_at":"2026-09-03T12:00:00.000Z","source_message_id":"default:C0A3C98HS48:1786591963.108609","status":"open"}
{"id":"C0A3C98HS48:1786591963.108609","status":"answered","answered_at":"2026-09-03T12:04:00.000Z","answer_ts":"1786592000.000100"}
{"id":"C0A3C98HS48:1786592100.000200","status":"duplicate","duplicate_of":"C0A3C98HS48:1786591963.108609"}
{"id":"C0A3C98HS48:1786592200.000300","alias_of":"C0A3C98HS48:1786591963.108609"}
{"id":"C0A3C98HS48:1786592300.000400","status":"deleted","deleted_at":"2026-09-03T12:10:00.000Z"}
```

An alias line carries **no** `status` on purpose: it names the ask that owns the obligation
without overwriting that ask's own state.

## One Obligation Per Source Message

Slack replays messages when it reconnects after an outage. On 2026-09-03 it replayed a
message the user had deleted during the outage together with the user's live re-post: two
ids, two asks, two answers, and the answer to the deleted one landed top-level in the
channel because its thread no longer existed. `outbound-dedupe` did not catch it — the two
answers were paraphrased differently and went to different thread keys.

Two rules keep one obligation per question:

- **Same source → alias.** Every record carries `source_message_id`
  (`<workspace account>:<channel>:<original ts>`). A delivery whose source is already in the
  ledger — a replay, an edit, a redelivery under a new id — is written as `alias_of` the ask
  that owns it, whatever state that ask is in. The provider reports the original ts in
  `metadata.sourceTs` when the delivery is not itself the source.
- **Distinct source, same question → duplicate.** Otherwise the hook looks for an ask with
  the **same channel**, the **same user**, the **same normalized text** (trimmed, lowercased,
  opening `<@U…>` mentions dropped; mentions inside the sentence are kept), `received_at`
  **within 15 minutes**, and a status of `open`, `acknowledged` or `answered`. The oldest
  match wins, so every repeat points at one original. A `deleted` original is skipped on
  purpose: the user withdrew it, so asking again is a real new ask.

## Stopping The Turn

The turn is stopped by a `before_dispatch` core hook (registered through
`src/plugins/core-hooks.ts`). It is the only inbound plugin hook whose result cancels: it
runs after `message_received` and before the agent dispatch, and `{ handled: true }` with
no text sends nothing and returns. The `message:received` internal hook is fire-and-forget
and cannot cancel, so the recorder claims the turn synchronously and hands the gate the
promise it is about to settle; the gate waits for the ledger write instead of racing it. A
claimed turn can still be stopped by ask id, which is how a deletion arriving mid-turn lands.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "ask-ledger": { "enabled": true }
      }
    }
  }
}
```
