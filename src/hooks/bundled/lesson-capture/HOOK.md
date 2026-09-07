---
name: lesson-capture
description: "Writes candidate lesson records when a turn ends with a result, verdict, closure or human correction (Constitution Articles 5.5 and 8, Learning)"
metadata:
  {
    "openclaw":
      {
        "emoji": "🧪",
        "events": ["gateway:startup", "message:received"],
        "requires": {},
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Lesson Capture Hook

Implements **Constitution Article 5.5 / Article 8 (Learning)**: keep evidence of outcomes and
corrections so lessons come from records, not from the model's memory of itself. The hook
only collects candidates; a separate reviewed reflect job promotes them. It never calls a
model and never writes `MEMORY.md` or Hindsight.

## What It Does

The internal hook bridges an `agent_end` plugin hook into the live plugin registry (on
`gateway:startup`, re-checked on `message:received`). `agent_end` is the turn-end event that
carries the message transcript; `session_end` and `subagent_ended` fire without one, and
sub-agent turns run through the same embedded runner, so `agent_end` covers them too.

After each turn (failed turns included, since an aborted turn can still carry the human
correction) it scans the last human message for a correction trigger and, if none, the last
assistant message for a result trigger. On a match it appends to
`<workspace>/state/lesson_candidates.jsonl`:

```json
{
  "id": "7f3c…",
  "session_key": "agent:main:slack:channel:c0a3…:thread:1786…",
  "channel": "C0A3C98HS48",
  "thread_ts": "1786591963.108609",
  "trigger": "assistant:CLOSED",
  "excerpt": "…",
  "created_at": "2026-09-03T12:00:00.000Z",
  "status": "candidate"
}
```

`excerpt` is the last ~1500 characters of the assistant text plus the triggering human text.
The id hashes session key + trigger + the triggering message, so a replayed turn never
duplicates a record.

## Configuration

Triggers are regular expressions. Patterns containing an uppercase letter match
case-sensitively (`CLOSED`, `Correction:`); all others match case-insensitively.

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "lesson-capture": {
          "enabled": true,
          "resultTriggers": ["\\bresults?\\b", "\\bverdict\\b", "CLOSED", "Correction:"],
          "correctionTriggers": [
            "Correction:",
            "\\bwrong\\b",
            "\\bincorrect\\b",
            "should never",
            "not what I asked"
          ]
        }
      }
    }
  }
}
```
