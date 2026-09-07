---
name: memory-recall
description: "Retrieves Hindsight and markdown memory for every inbound human message and injects it before the model plans (SOUL Article 8 / Derivation: retrieve before planning)"
metadata:
  {
    "openclaw":
      {
        "emoji": "🔎",
        "events": ["gateway:startup", "message:received"],
        "requires": {},
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Memory Recall Hook

Implements the **SOUL Derivation clause: retrieve before planning**, automatically.

## What It Does

1. A `before_prompt_build` core hook (registered when the hook module loads, re-registered on
   `gateway:startup`) takes the inbound message id, thread, channel, bot flag and raw text from
   the typed `inboundMessage` on the hook context, which the reply pipeline sets from the
   channel context. The assembled prompt is never parsed. Turns without an inbound message
   (heartbeats, cron and exec events, isolated runs), bot-authored messages (hook context flag
   or the channel's `senderIsBot` seen on `message:received`) and messages shorter than
   `minMessageChars` are skipped.
2. The query is the message text plus the thread's previous human message, taken from the
   per-thread stash `message:received` keeps (last 3 human messages per thread, plus a
   32-id per-thread window so a redelivery is never stashed twice).
3. Hindsight recall (memory-core client, budget `mid`, 6 candidates) and the markdown memory
   search (`memory/*.md`) run in parallel under `timeoutMs`; whatever has not settled by then is
   aborted and reported. A source that fails still lets the other source's hits through; nothing
   is injected only when no source returns a hit.
4. Up to `maxItems` merged hits are prepended to the prompt as
   `Retrieved memory (leads, not verification; verify before citing):` followed by one line per
   hit: `[source date] text — ref: hindsight:<id> | memory/<file>#L<n>`, capped at `maxChars`.
   Hits outside `memory/` (including the root `MEMORY.md`) are counted but not injected.
5. Every retrieval appends one JSON line to `<workspace>/state/retrieval_log.jsonl`:
   `{ts, session_key, message_id, query_digest, channel, thread_ts, query, hindsight_hits, markdown_hits, ms, failed_sources, error, injected_chars}`.
   The append runs under the file lock and skips a session + message id + query already logged, so
   retries, redeliveries and restarts never double-log a turn.

Failures are logged as warnings (throttled to once per minute) and never block the turn.
The hook registers its `before_prompt_build` core hook with a runner budget derived from its own
retrieval deadline (`timeoutMs` + 1500 ms), so raising `timeoutMs` raises the budget with it;
every other plugin's `before_prompt_build` hook keeps the runner's 15 s default. Retrieval is
clamped to the registered budget, and the log write then gets a three-second deadline shrunk to
whatever is left of that budget, so the evidence write can never hold the turn past it. Policy:
a failed or slow log write still lets the retrieved block through, is logged as an error, and
leaves the turn uncached so a retry writes the missing line.

## Configuration

`maxItems` and `maxChars` are hard caps: config may lower them, never raise them. `timeoutMs`
may be raised above its default up to a 9000 ms ceiling — Hindsight recall alone costs ~3 s at
rest, so a 3 s deadline timed out both sources.

| Option            | Type    | Default | Description                                      |
| ----------------- | ------- | ------- | ------------------------------------------------ |
| `enabled`         | boolean | false   | Turn the hook on                                 |
| `maxItems`        | number  | 6       | Maximum retrieved items injected (cap 6)         |
| `maxChars`        | number  | 1500    | Hard cap on the injected block (cap 1500)        |
| `minMessageChars` | number  | 25      | Shorter inbound messages skip retrieval          |
| `timeoutMs`       | number  | 7000    | Deadline for recall + markdown search (cap 9000) |

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "memory-recall": {
          "enabled": true,
          "maxItems": 6,
          "maxChars": 1500,
          "minMessageChars": 25,
          "timeoutMs": 7000
        }
      }
    }
  }
}
```
