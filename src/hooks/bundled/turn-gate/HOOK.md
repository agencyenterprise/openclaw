---
name: turn-gate
description: "Records whether a turn that promised future work actually armed it, and repairs the promise when it did not (SOUL Article A11)"
metadata:
  {
    "openclaw":
      {
        "emoji": "🚦",
        "events": ["gateway:startup", "message:sent"],
        "requires": {},
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Turn Gate Hook

Implements **SOUL Article A11**: a commitment is only real when something in the same turn
arms it. Saying "Next: I'll start the harvest" and then ending the turn leaves nothing
running, and nobody finds out until the work is missing.

## What It Does

Internal hooks do not see the turn transcript, so this hook registers an `agent_end`
**core hook** (`src/plugins/core-hooks.ts`) when its module loads, which is while the gateway
loads internal hooks and before `gateway:startup`. Core hooks are composed into every hook
dispatch and survive plugin registry re-activation. `gateway:startup` only verifies the
registration and logs an error if it is missing.

For every turn that ends:

1. **Slice the transcript to this turn.** `agent_end` receives the whole session snapshot
   (`state.messagesSnapshot`), so the gate takes everything from the **last `user` message**
   onward. Without the slice, an old cron registration from an earlier turn would back a
   promise made now.
2. Take the **final assistant text** of that slice and match the configured commitment
   `phrases` (literal, case-insensitive). A phrase that starts or ends on a word character
   is anchored to a word boundary, so `armed` is a commitment and `disarmed` is not. Curly
   apostrophes are folded to straight ones, so the model's `I’ll` matches a configured
   `I'll`, and blank configured phrases are dropped rather than matching every turn.
3. Look for evidence in that same slice.
4. Append one line to `<workspace>/state/turn_gate.jsonl` under the shared advisory lock.
5. On `unbacked`, run the **repair pass** below.

The gate **never blocks a turn and never fails one**: an error inside it is logged and
swallowed.

## Evidence Rules

A commitment is `backed` when the **sliced turn** contains any of:

- a tool call whose name or arguments contain one of the `commandMarkers`
  (`register_job.py`, `cron add`, `hcom codex` by default);
- a tool call whose name starts with `cron`;
- a `<workspace>/state/jobs.json` whose mtime is at or after the start of the turn.

Tool calls are read from the **normalized** OpenClaw message shape
(`{ type: "toolCall", id, name, arguments }`, `packages/llm-core/src/types.ts`), which is
what `agent_end` actually receives. The provider wire shapes (`tool_use` content blocks and
OpenAI `tool_calls` entries) are still read, because cli-runner transcripts are not
normalized.

The turn start is the **first message timestamp of the sliced turn**; normalized messages
carry `timestamp` as Unix milliseconds, and that is authoritative. It falls back to
`agent_end`'s `durationMs` counted back from now, and when there is neither the mtime check
is **skipped**, not guessed, so the gate never invents evidence. A missing `jobs.json` is
not evidence.

## The Repair Pass

Measuring an unmet promise does not meet it. An `unbacked` verdict queues **one** follow-up
turn in the **same session**, and that turn's only visible effect is an **edit of the message
that made the promise**. It never adds a message to the thread.

**How the turn is queued.** `enqueueSystemEvent(text, { sessionKey, deliveryContext })` plus
`requestHeartbeat({ source: "notifications-event", intent: "immediate", reason: "wake",
sessionKey, heartbeat: { target: "last" } })` — the same pair the gateway's `system-event`
method runs for a targeted wake (`src/gateway/server-methods/system.ts`) and the pattern
`enqueueRestartSentinelWake` follows (`src/gateway/server-restart-sentinel.ts`). That exact
combination is the only one `isTargetedImmediateSystemEventWake` recognizes, so the repair
runs even for an agent with no scheduled heartbeat and outside its active hours. The delivery
context is recovered from the session store with `resolveCronStoredDeliveryContext`, because a
heartbeat run otherwise drops the inherited Slack thread id
(`src/infra/outbound/targets.ts`) and the repair would leave its thread.

**Where the ts comes from.** `agent_end` runs _before_ delivery, so it cannot know the ts of the
message it is repairing — `PluginHookAgentEndEvent` carries inbound ids only, and no state file
in the workspace records the bot's own outgoing ts for a turn. So `agent_end` only **parks** the
intent, and the internal `message:sent` hook supplies the ts: Slack's provider message id _is_
the ts (`"unknown"` and `"suppressed"` are rejected by `isSlackTs`). A turn that delivers several
messages restarts a short settle window each time, so one turn produces one repair aimed at the
last message it delivered — the same shape, for the same reason, as the reviewer hook.

**Which branch the repair takes** is decided here, not by the model:

- **Start.** `scripts/lane.py check <lane> --action <class> --amount <est>` passes for an
  active lane that was authorized in this channel and thread; when several lanes cover it, the
  first that allows every class the promise charges, picked by lane-guard's
  `selectAuthorizingLane` so the gate and the guard cannot disagree about which lane authorizes
  what. The CLI seam, the class table and the lane lookup are lane-guard's
  (`src/hooks/bundled/lane-guard/`), so the gate asks the same question a human asks and matches
  the thread the same way: `origin.thread_ts`, else the
  permalink's `thread_ts=` query, else the message its permalink points at — that message being
  the thread root, or a reply the ask ledger places in this thread. Both halves of the origin
  are compared exactly, never as a substring. Two rules keep this safe on model prose: the lane
  comes **only** from the thread origin — the gate calls `resolveLaneForThread`, never
  `resolveLaneForCommand`, so the `# lane:<id>` marker lane-guard honours in an operator's own
  command cannot let the model name its own lane here — and a promise whose command the
  classifier cannot read is **refused**, because "a lane exists" is not authorization to spend
  on unclassified work. The
  repair may then start exactly that step and append one line —
  `Running: <what> (<receipt>)` — to the promising message. It never reserves budget and never
  creates a lane.
- **Correct.** No lane covers the thread, or the lane refuses. The repair starts nothing and
  rewrites the promise as `Not started: needs <decision>`, where the decision names the
  missing authorization only — an active lane, budget, a protocol change, or a human-owned
  action. The decision owner (`<@U03EH553GBE>`) is tagged in that same edit only the first
  time a thread needs it.

**A repair is refused** when: the repair is disabled; the turn had no inbound human message
(cron, ACP — there is then no identity for "once per deliverable"); the final text is a
token-only `HEARTBEAT_OK` acknowledgement; every commitment sentence sits inside a blockquote
of a human; or the inbound message was a question and the thread has no lane. A message counts
as a request to execute when it names an execution verb that is neither negated ("do not run")
nor inside an interrogative ("how do I build this?").

**Budget.** `<workspace>/state/turn_gate_repairs.json` holds three lists under the shared
advisory lock, and one atomic claim enforces all four rules: a deliverable (inbound message id

- digest of its commitment sentences) is repaired **once**, a session at most once per
  `cooldownMinutes`, the workspace at most `maxPerDay`, and a thread tags the decision owner once.
  The deliverable and thread lists are permanent facts and are pruned only at 20,000 entries; the
  rate history keeps 48 hours. A claim is **given back** when the repair turn cannot be queued, so
  a failed wake never marks a promise repaired forever.

**Grading the repair.** The repair turn was told to edit one message, so the edit is what it is
graded on: `repaired` when the turn called the `message` edit action against that ts, and
`unbacked_after_repair` when it did not. Whatever it armed on the way stays visible in
`evidence`. The turn is recognised by a **nonce** the claim minted, which lives in the ledger
and only ever reaches that session's own prompt — quoting the marker back does not make a turn
a repair turn. The nonce is consumed on first use, so a repair never queues another repair.

## Verdicts

| verdict                 | meaning                                               |
| ----------------------- | ----------------------------------------------------- |
| `backed`                | commitment phrases found, evidence found              |
| `unbacked`              | commitment phrases found, no evidence                 |
| `none`                  | no commitment phrases in the final assistant text     |
| `repaired`              | a repair turn edited the message it was sent to fix   |
| `unbacked_after_repair` | the repair turn did not; the heartbeat picks these up |

**Output**: `<workspace>/state/turn_gate.jsonl` — one record per turn:
`{ts, session, thread, commitments, evidence, verdict, repair?}`. `thread` comes from the typed
`ctx.inboundMessage` (channel + thread ts), falling back to the session key. `repair` is present
only on `unbacked` turns and reads `pending-delivery` or `skipped:<reason>`; the outcome of a
parked repair (`sent:start:<lane>`, `sent:correct`, `enqueue-refused:<branch>`,
`skipped:<reason>`) is logged when it runs, and its verdict lands on the repair turn's own line.

## Known Limits

- **Correlation is by session key.** `runId` is not plumbed through the outbound delivery path
  (`src/plugins/hook-message.types.ts` says so explicitly and tells hooks to use `sessionKey`,
  "with the caveat that it cannot disambiguate concurrent turns in the same session"). Two turns
  overlapping in one session can therefore aim a repair at the wrong message. The parked intent
  expires after five minutes to bound that window; closing it properly needs the run id on the
  outbound path.
- **A split reply repairs its last chunk.** When a turn delivers several messages, the promise may
  sit in an earlier one. The reviewer hook picks the last assistant message for the same reason.
- **"Do not post, do not create a lane" is instruction, not enforcement.** Gating the repair turn's
  tools would mean changing the tool surface, which this hook does not own.
- **The tombstone is written when the repair is queued, not when it runs.** A wake refused at
  enqueue time is given back (`releaseRepair`), but a gateway restart between the enqueue and the
  drain loses the repair while the tombstone stands, and that deliverable is not repaired again.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "turn-gate": {
          "enabled": true,
          "phrases": [
            "Next:",
            "I will",
            "I'll",
            "will start",
            "starting now",
            "armed",
            "scheduled"
          ],
          "commandMarkers": ["register_job.py", "cron add", "hcom codex"],
          "repair": {
            "enabled": true,
            "cooldownMinutes": 30,
            "maxPerDay": 20
          }
        }
      }
    }
  }
}
```

`cooldownMinutes` and `maxPerDay` fall back to their defaults unless they are positive finite
numbers, so a mistyped limit is never silently an unlimited one.
