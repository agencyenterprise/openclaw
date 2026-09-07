# Bundled Hooks

This directory contains hooks that ship with OpenClaw. These hooks are automatically discovered and can be enabled/disabled via CLI or configuration.

## Available Hooks

### 💾 session-memory

Automatically saves session context to memory when you issue `/new` or `/reset`.

**Events**: `command:new`, `command:reset`
**What it does**: Creates a dated memory file with LLM-generated slug based on conversation content.
**Output**: `<workspace>/memory/YYYY-MM-DD-slug.md` (defaults to `~/.openclaw/workspace`)

**Enable**:

```bash
openclaw hooks enable session-memory
```

### 📎 bootstrap-extra-files

Injects extra bootstrap files (for example monorepo `AGENTS.md`/`TOOLS.md`) during prompt assembly.

**Events**: `agent:bootstrap`
**What it does**: Expands configured workspace glob/path patterns and appends matching bootstrap files to injected context.
**Output**: No files written; context is modified in-memory only.

**Enable**:

```bash
openclaw hooks enable bootstrap-extra-files
```

### 📝 command-logger

Logs all command events to a centralized audit file.

**Events**: `command` (all commands)
**What it does**: Appends JSONL entries to command log file.
**Output**: `~/.openclaw/logs/commands.log`

**Enable**:

```bash
openclaw hooks enable command-logger
```

### 🚀 boot-md

Runs `BOOT.md` whenever the gateway starts (after channels start).

**Events**: `gateway:startup`
**What it does**: Executes BOOT.md instructions via the agent runner.
**Output**: Whatever the instructions request (for example, outbound messages).

**Enable**:

```bash
openclaw hooks enable boot-md
```

## Hook Structure

Each hook is a directory containing:

- **HOOK.md**: Metadata and documentation in YAML frontmatter + Markdown
- **handler.ts**: The hook handler function (default export)

Example structure:

```
session-memory/
├── HOOK.md          # Metadata + docs
└── handler.ts       # Handler implementation
```

## HOOK.md Format

```yaml
---
name: my-hook
description: "Short description"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---
# Hook Title

Documentation goes here...
```

### Metadata Fields

- **emoji**: Display emoji for CLI
- **events**: Array of events to listen for (e.g., `["command:new", "session:start"]`)
- **requires**: Optional requirements
  - **bins**: Required binaries on PATH
  - **anyBins**: At least one of these binaries must be present
  - **env**: Required environment variables
  - **config**: Required config paths (e.g., `["workspace.dir"]`)
  - **os**: Required platforms (e.g., `["darwin", "linux"]`)
- **install**: Installation methods (for bundled hooks: `[{"id":"bundled","kind":"bundled"}]`)

## Creating Custom Hooks

To create your own hooks, place them in:

- **Workspace hooks**: `<workspace>/hooks/` (highest precedence)
- **Managed hooks**: `~/.openclaw/hooks/` (shared across workspaces)

Custom hooks follow the same structure as bundled hooks.

## Managing Hooks

List all hooks:

```bash
openclaw hooks list
```

Show hook details:

```bash
openclaw hooks info session-memory
```

Check hook status:

```bash
openclaw hooks check
```

Enable/disable:

```bash
openclaw hooks enable session-memory
openclaw hooks disable command-logger
```

## Configuration

Hooks can be configured in `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": {
          "enabled": true
        },
        "command-logger": {
          "enabled": false
        }
      }
    }
  }
}
```

## Event Types

Currently supported events:

- **command**: All command events
- **command:new**: `/new` command specifically
- **command:reset**: `/reset` command
- **command:stop**: `/stop` command
- **agent:bootstrap**: Before workspace bootstrap files are injected
- **gateway:startup**: Gateway startup (after channels start)
- **session:compact:before**: Pre-compaction snapshot before the embedded runner rewrites session context
- **session:compact:after**: Post-compaction snapshot after the runner replaces session context
- **message:received**: Inbound channel message accepted for dispatch
- **message:sent**: Outbound channel message delivered (canonical payload only)

## Handler API

Hook handlers receive an `InternalHookEvent` object:

```typescript
interface InternalHookEvent {
  type: "command" | "session" | "agent" | "gateway" | "message";
  action: string; // e.g., 'new', 'reset', 'stop', 'compact:before', 'received', 'sent'
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[]; // Push messages here to send to user
}
```

Example handler:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
  console.log("New command triggered!");

  // Optionally send message to user
  event.messages.push("✨ Hook executed!");
};

export default myHandler;
```

## Testing

Test your hooks by:

1. Place hook in workspace hooks directory
2. Restart gateway: `pkill -9 -f 'openclaw.*gateway' && pnpm openclaw gateway`
3. Enable the hook: `openclaw hooks enable my-hook`
4. Trigger the event (e.g., send `/new` command)
5. Check gateway logs for hook execution

## Documentation

Full documentation: https://docs.openclaw.ai/automation/hooks

### 📥 ask-ledger

Records every direct ask to the bot (DM, mention, in-thread reply) and marks it answered on the bot's reply. Constitution Article 3 (Initiative).

**Events**: `gateway:startup`, `message:received`, `message:sent`, `message:deleted` (plus a cancel-capable `before_dispatch` core hook registered at load)
**What it does**: Appends idempotent ask records; a _confirmed_ send (a real platform message id) into the same channel + thread marks matching open asks answered. One obligation per source message: a repeat of the same source id is written `alias_of`, and a distinct source with the same normalized text in the same channel from the same user inside 15 minutes is written `duplicate` and has its turn cancelled at `before_dispatch`. `message:deleted` appends a `deleted` tombstone and closes the ask with the `parent_deleted` sentinel instead of answering into a dead thread.
**Output**: `<workspace>/state/asks.jsonl` (read with `python3 scripts/asks.py list --open --older-than 10m`; `--open` excludes `answered`, `duplicate`, `deleted` and anything with `alias_of`)

**Enable**:

```bash
openclaw hooks enable ask-ledger
```

### 🔇 outbound-dedupe

Cancels a send whose normalized text repeats a send in the same channel + thread within the window. Constitution Article 7 (Signal).

**Events**: `gateway:startup`, `message:sent` (plus a cancel-capable `message_sending` core hook registered at load)
**What it does**: Hashes normalized outbound text (dates, times, Slack ids and permalinks stripped), reserves it at `message_sending`, confirms it at `message:sent`, and cancels repeats within `windowHours`; logs `outbound-dedupe: suppressed duplicate`.
**Output**: `<workspace>/state/outbound_hashes.json`

**Enable**:

```bash
openclaw hooks enable outbound-dedupe
```

### 🧪 lesson-capture

Writes candidate lesson records when a turn ends with a result, verdict, closure or human correction. Constitution Articles 5.5 and 8 (Learning).

**Events**: `gateway:startup` (plus an `agent_end` core hook registered at load)
**What it does**: Heuristic trigger scan of the last assistant and human messages; no model call, no MEMORY.md or Hindsight writes.
**Output**: `<workspace>/state/lesson_candidates.jsonl`

**Enable**:

```bash
openclaw hooks enable lesson-capture
```

### 🔎 memory-recall

Retrieves Hindsight and markdown memory for every inbound human message and prepends it to the prompt before the model plans. SOUL Article 8 / Derivation (retrieve before planning).

**Events**: `gateway:startup`, `message:received` (plus a `before_prompt_build` core hook registered at load)
**What it does**: Takes the message id, thread, bot flag and text from the typed hook context (`ctx.inboundMessage`, set by the reply pipeline; the prompt is never parsed), builds a query from the message plus the thread's previous human message, runs Hindsight recall (budget `mid`, 6 candidates) and the markdown memory search in parallel under `timeoutMs`, and injects up to `maxItems` hits (`maxChars` cap) under `Retrieved memory (leads, not verification; verify before citing):`. Skips heartbeats, cron/exec events, bot messages, and messages under `minMessageChars`; `maxItems`/`maxChars` are hard caps, and `timeoutMs` (default 7000) may be raised up to 9000. The `before_prompt_build` runner budget is derived as `timeoutMs + 1500`, so the hook never dies at a budget narrower than its own retrieval deadline.
**Output**: `<workspace>/state/retrieval_log.jsonl` (one line per session + message id)

**Enable**:

```bash
openclaw hooks enable memory-recall
```

### 🛂 lane-guard

Gates `exec`/`bash` commands that spend money or leave the sandbox behind an active lane, and reserves the estimate against its budget. SOUL Articles A3.2, A4.1 and A9 (lane authorization and aggregate budget).

**Events**: `gateway:startup` (plus a cancel-capable `before_tool_call` core hook registered at load)
**What it does**: A config-extensible regex table classifies the command line as `runpod`, `api_calls`, `silico`, `spark_gpu`, `local_cpu` or `publish_external` (anything else passes untouched); a chained command charges every class it matches and each one must be authorized. Candidate lanes are every active lane whose recorded origin covers the turn's channel + thread — read from `origin.thread_ts`, the `thread_ts` query in `origin_permalink`, or the message the permalink points at resolved through the ask ledger — so DM, cron, ACP and sub-agent sessions may still name one inline with `# lane:<id>`. `scripts/lane.py check` decides per class and `selectAuthorizingLane` charges the first candidate that allows _every_ class the command needs; only `action_not_allowed` moves on to the next lane, so candidate ceilings never pool. An allowed command then reserves each estimate ($5 runpod, $1 api_calls, $0 otherwise) with the session key as the worker; a reserve that fails cancels the command and releases anything already booked for it. Enforcement is per session kind via `enforce` (default `{heartbeat: true, cron: true, human: false}`) — an audited kind only writes its line — and `alwaysCancel` (default `["publish_external"]`) cancels in every kind. Classification reads the literal command string, so `eval`-style indirection is not gated.
**Output**: `<workspace>/state/lane_guard.jsonl` (one line per classified command: `{ts, session, thread, kind, mode, class, lane, decision, reason}`; `mode` is `enforce` or `audit`, `decision` is what the guard actually did)

**Enable**:

```bash
openclaw hooks enable lane-guard
```

### 🚦 turn-gate

Records whether a turn that promised future work actually armed it. SOUL Article A11.

**Events**: `gateway:startup` (plus an `agent_end` core hook registered at load)
**What it does**: Matches configured commitment phrases (`Next:`, `I'll`, `armed`, ...) in the final assistant text, then looks for evidence in the same turn: a tool call carrying `register_job.py`, `cron add` or `hcom codex`, a `cron` tool call, or a `state/jobs.json` written since the turn started. Measuring an unmet promise does not meet it, so an `unbacked` verdict also queues **one** follow-up turn whose only visible effect is an _edit_ of the message that made the promise — Start (`Running: <what> (<receipt>)`) when a lane authorizes the work, Correct (`Not started: needs <decision>`) when it does not. The branch is chosen by code, not by the model, and the budget (one repair per deliverable, one per session per `cooldownMinutes`, `maxPerDay` per workspace) is claimed atomically. Never blocks and never fails a turn.
**Output**: `<workspace>/state/turn_gate.jsonl` (one record per turn: `{ts, session, thread, commitments, evidence, verdict, repair?}` where verdict is `backed`, `unbacked`, `none`, `repaired` or `unbacked_after_repair`)

**Enable**:

```bash
openclaw hooks enable turn-gate
```
