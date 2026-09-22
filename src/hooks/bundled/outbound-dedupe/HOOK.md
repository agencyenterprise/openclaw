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

One signal runs before a send: the normalized text hash per `<channelId>:<target>:<thread>`.
It catches the same paragraph posted twice in one thread.

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

## No One-Answer-Per-Ask Rule

The hook does not track which ask a send answers, and it never cancels a send because an
earlier, different message went to the same ask. A run often posts an acknowledgement
("I'll review the ESR bundle and reply here shortly") and later the answer to the same ask.
A content-independent "one answer per obligation" rule cannot tell those two apart: on
2026-09-22 it cancelled a 2028-character review 20 minutes after the acknowledgement for
the same ask (`C0C303K80UQ:1790097410.218249`). Its only two other cancels since
2026-09-15 were the same shape: a later message from the run that had already posted to the
ask, one of them a correction. It is removed.

A second run answering one ask — the 2026-09-03 replay leak — is stopped where the ask
arrives: the `ask-ledger` `before_dispatch` turn gate gives a replayed or repeated ask no
turn at all, so there is no second answer to cancel.

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
          "minChars": 24
        }
      }
    }
  }
}
```

Every value above is the default; the hook needs no configuration to behave as described.
