---
name: reviewer-recovery
description: "Re-engage interrupted Slack threads after a gateway restart"
homepage: https://docs.openclaw.ai/automation/hooks
metadata:
  {
    "openclaw":
      {
        "emoji": "🔄",
        "events": ["gateway:startup"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Reviewer Recovery Hook

On every gateway:startup, scans `~/.openclaw/pending-reactions.json` and `~/.openclaw/active-threads.json` for threads that were mid-dispatch when the previous gateway died (OOM, crash, restart). For each, it cleans up orphan status reactions on Slack and dispatches a synthetic "Gateway restarted. Continue where you left off." message via the reviewer-dispatch global, re-engaging the agent on the same thread.

Originally part of the monolithic `reviewer` hook (now in `reviewer.disabled/`); extracted as a standalone bundle so the recovery path survives independently of the reviewer-system migration.
