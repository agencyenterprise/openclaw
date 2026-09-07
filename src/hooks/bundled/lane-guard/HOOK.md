---
name: lane-guard
description: "Gates exec/bash commands that spend money or leave the sandbox behind an active lane, and reserves the estimate against its budget (SOUL Articles A3.2, A4.1, A9)"
metadata:
  {
    "openclaw":
      {
        "emoji": "🛂",
        "events": ["gateway:startup"],
        "requires": {},
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Lane Guard Hook

Implements **SOUL Articles A3.2, A4.1 and A9 (lane authorization and aggregate budget)**: work
that spends money or leaves the sandbox runs under a lane a human authorized in a thread, and
the spend is booked against that lane's ceiling before the command runs, not after.

## What It Does

Internal hooks cannot cancel a tool call, so this hook registers a cancel-capable
`before_tool_call` **core hook** (`src/plugins/core-hooks.ts`) when its module loads, which is
while the gateway loads internal hooks and before `gateway:startup`. Core hooks are composed
into every hook dispatch and survive plugin registry re-activation. `gateway:startup` only
verifies the registration and logs an error if it is missing.

For every `exec` / `bash` call (the `command` or `cmd` parameter):

1. **Classify.** A config-extensible regex table maps the command line to the lane action
   classes it charges. A command that matches nothing passes untouched — the guard never gates
   ordinary shell work.

   | Class              | Matches                                                                                            | Default estimate |
   | ------------------ | -------------------------------------------------------------------------------------------------- | ---------------- |
   | `runpod`           | `runpod_spawn.sh`, `runpod_pod.py create\|start`, `runpodctl`                                      | $5               |
   | `silico`           | `silico_slurm.sh submit\|sbatch`                                                                   | $0               |
   | `spark_gpu`        | `scripts/dgx` (the one entry point onto the Spark box)                                             | $0               |
   | `local_cpu`        | `systemd-run`                                                                                      | $0               |
   | `api_calls`        | `codex exec`, `hcom codex`                                                                         | $1               |
   | `publish_external` | `gh release`, `gh pr create`, `git push <non-origin>`, `npm publish`, `pip upload`, `twine upload` | $0               |

   Class names are exactly the `allowed_actions` of `scripts/lane.py`, so nothing is
   re-derived here. Patterns are matched case-insensitively. A chained command
   (`runpodctl create … && codex exec …`) charges **every** class it matches, and every one of
   them has to be authorized and booked — taking only the first match would let a lane that
   forbids `api_calls` run Codex anyway.

   `publish_external` books no budget: it is gated for leaving the sandbox, not for costing
   money. `git push` counts only when it names a remote that is not `origin`, so
   `git push origin main` and a bare `git push` onto the tracked remote stay unclassified;
   git's own global options (`git -C <dir> push …`), push flags, the `--` end-of-options
   marker, a quoted remote, and `--repo=<remote>` are all read, and `origin/main` counts
   because it is a refspec rather than the remote named `origin`. `gh release` counts in every
   subcommand form, including read-only ones — an `alwaysCancel` class is cheaper to over-gate
   than to miss. A remote named through a shell variable (`git push "$REMOTE" main`) is not
   caught, for the reason under **What It Does Not Catch**.

   A malformed pattern in config is dropped with a logged error rather than thrown:
   `before_tool_call` is fail-closed, so throwing would block every exec call, not just the
   spending ones. A class whose configured patterns are _all_ unparseable falls back to its
   defaults, so a typo can never silently un-gate a spending class; a class configured as an
   empty list stays off, because that is an explicit choice.

2. **Find the lanes.** An operator can pin one inside the command with `# lane:<id>`.
   Otherwise the candidates are **every** lane in `lane.py list --state active` that was
   authorized in the channel and thread of the current turn — several lanes routinely cover one
   thread (a parent lane and the run it spawned), and step 3 decides which of them pays.
   `PluginHookToolContext` carries no `inboundMessage`, so those two facts come from the session
   key (`agent:main:slack:channel:<id>:thread:<ts>`).

   A lane record spells that origin in one of three ways, because three writers write it. They
   are tried in this order (`src/hooks/bundled/lane-guard/lane-lookup.ts`, shared with the
   turn-gate):

   1. **`origin.thread_ts`** — what `scripts/lane.py` writes on create, so a lane names its
      thread outright. A lane created before that field existed has no `origin` object at all.
   2. **`thread_ts=<ts>` in `origin_permalink`** — the query a newer Slack permalink carries
      (`.../archives/<CH>/p<message ts>?thread_ts=<root ts>&cid=<CH>`).
   3. **The message the permalink points at** — `/p<digits>` is a ts with its dot dropped. It
      matches when that message _is_ the thread root, and otherwise when the ask ledger the
      sibling hook maintains (`<workspace>/state/asks.jsonl`) says it is a reply in this
      thread. A "go" is usually a reply rather than the root, so this is the form the common
      case takes. The ledger is read **lazily** — only when no active lane named its thread in
      form 1 or 2 — and at most once per lookup. Nothing here calls Slack.

   **The lane must belong to the same channel**, taken from `origin.channel`, else the
   permalink's `/archives/<CH>/`, else its `cid=` query. A lane record with no channel at all
   never matches: a bare thread ts that happens to be equal in two channels must not authorize
   a spend. Channel ids compare case-insensitively, and both halves compare **exactly**, never
   as a substring — `C123` is a substring of `C1234`, and one ts can be a substring of a
   longer one.

   Candidates keep the order `lane.py list` returned them in (it sorts by lane id), which makes
   the set stable but says nothing about which lane authorizes the work — that is step 3's job.

   **Evidence that contradicts itself authorizes nothing**, rather than being resolved by
   precedence — a channel taken from one source next to a thread taken from another would be an
   authorization nobody ever wrote:

   - `origin.channel`, the permalink's `/archives/<CH>/` and its `cid=` query must agree
     (case-insensitively), and `origin.thread_ts` must agree with the permalink's `thread_ts=`.
     Any disagreement, or no channel at all, and the lane matches nothing.
   - Every ts is a canonical Slack ts — ten second digits, a dot, exactly six more — wherever it
     comes from: `origin.thread_ts`, the `thread_ts=` query, or the digits in `/p<ts>`. `1.2` is
     not a thread. (`isSlackTs` in `src/hooks/slack-thread.ts` accepts any fractional length;
     tightening it would change how four other hooks validate message ids, so the extra
     precision lives in `lane-lookup.ts`.)
   - A permalink carrying more than one `/archives/<CH>/p<ts>` segment, or anything after the
     message ts, is not a Slack permalink: it contributes neither channel nor message, and only
     the record's own `origin` object still speaks for the lane.
   - In the ask ledger, an ask id recorded with **two different** `thread_ts` values answers for
     neither, and so does a line whose `channel` is not the channel inside its own id. Python
     crons share that file, so last-writer-wins would let one bad line move a lane into a thread
     of the writer's choosing. Identical repeats are fine.

   A lane listing that fails, or an ask ledger that cannot be read, is an error and therefore a
   refusal (step 5); a missing ledger file is simply an empty one.

   **This resolves automatically only for Slack channel threads.** A DM routed by user
   identity, a cron run, an ACP or CLI session, and a sub-agent all have session keys without a
   channel + thread pair; a classified command from one of those resolves no lane and must name
   it with `# lane:<id>`.

3. **Authorize.** `lane.py check <lane> --action <class> --amount <estimate> --json` decides,
   once per class. It has **three** outcomes, not two, because a lane that says no and a lane
   nobody managed to ask are not the same answer:

   - **The lane refuses** (exit 2). That refusal decides this _lane_ and nothing is booked, but
     **every** class is still asked, because `alwaysCancel` turns on whether the lane
     explicitly allowed that class and a class the guard skipped has no answer to go on.
     Whether the search goes on then depends on the `code` `lane.py` returns beside the reason.
     `action_not_allowed` is the only one that moves on to the next candidate lane.
     `not_active`, `expired`, `unknown_action`, `bad_amount`, `over_ceiling` and
     `corrupt_record` each refuse the command outright, and so does an answer carrying no
     `code`, a code this build does not know, or stdout that is not JSON — in every one of
     those, no other lane is asked.

     Only `action_not_allowed` moves on, because it is the one refusal that says nothing about
     this thread's budget — the lane is simply not scoped to that action. **Every other refusal
     is the thread's answer.** Treating a ceiling as "ask the next lane" would pool the
     candidates' budgets: a $10 lane and a $75 lane covering one thread would let it spend $85,
     and a narrow lane could never tighten a permissive one. An unknown or missing code fails
     closed for the same reason, and it has to: argparse rejects a bad `--action` or `--amount`
     with the same **exit 2**, printing usage to stderr and nothing to stdout.

   - **The lane allows** (exit 0) every class, _and_ says so in the JSON it was asked for. That
     lane is charged. An exit 0 whose stdout is not a readable `{"allowed": true, "reason": …}`
     is treated as a check that never ran, not as permission: a wrapper bug or a stray
     `sys.exit(0)` must not authorize a spend. `reserve` and `release` are read the same way, so
     a booking nobody can read back is a failed booking rather than a silent one.
   - **The check could not be run** (any other exit, a signal, a timeout). The whole selection
     stops there: no further class and no further lane is asked, nothing is reserved, and the
     command is refused naming the lane whose check failed. Falling through to the next lane
     would spend a different lane's budget _because_ the right one could not be asked, which is
     exactly how an unanswered question becomes permission for someone else. A failed lane
     listing and an unreadable ask ledger stop the lookup in step 2 the same way.

   Each candidate from step 2 is asked in turn, and **the lane charged is the first one that
   allows every class the command charges** (`src/hooks/bundled/lane-guard/lane-selection.ts`,
   shared with the turn-gate so the two can never disagree). Covering a thread is not
   authorization: a parent lane whose `allowed_actions` have no `runpod` sorts before the run
   lane that does, and charging the first covering lane would deny exactly the work the thread
   authorized. When no candidate allows every class, the refusal carries the first candidate's
   own reason and names the others tried, so it stays one lane's actionable answer rather than
   a tally — and the classes reported as explicitly allowed are that first candidate's, which
   is what `alwaysCancel` reads.

4. **Book it.** In an enforced kind (below), an allowed command reserves each class's estimate
   with `lane.py reserve <lane> <amount> --worker <session key> --note "lane-guard estimate for
<class>"` before the tool runs. A zero-cost class books nothing (`lane.py` refuses a
   non-positive reserve). A **reserve that fails cancels the command**: `lane.py` re-checks the
   ceiling under its own per-lane lock, so a failure here is how a second agent racing for the
   same budget finds out it lost the race. Anything already booked for that command is released
   first, so a partly booked command never strands a reservation. An audited kind books nothing
   at all — observing must not spend a lane's budget.

5. **Cancel or pass.** In an enforced kind, no lane at all, a denied check, and a failed
   reserve each cancel the tool call with
   `lane-guard: no active lane for this thread (or budget exceeded). Create and activate one
with scripts/lane.py, then retry.` plus the detail from `lane.py`. In an audited kind the same
   refusal only writes its audit line — except for an `alwaysCancel` class, which cancels in
   every kind.

## Enforcement Per Session Kind

`enforce` is a boolean per kind of session the command came from, not one global switch:

| Kind        | Default | Why                                                                        |
| ----------- | ------- | -------------------------------------------------------------------------- |
| `heartbeat` | `true`  | Unattended: nobody is watching the turn that spends.                       |
| `cron`      | `true`  | Unattended: a schedule, not a person, started it.                          |
| `human`     | `false` | A person in the thread is already the authorization the lane records hold. |

The kind comes from the session key, because `PluginHookToolContext` carries no discriminator
for it (`src/plugins/hook-types.ts`). `src/hooks/bundled/lane-guard/session-kind.ts`:

- **`heartbeat`** — an appended `heartbeat` marker in the key after `agent:<agentId>:`, i.e.
  `/(?:^|:)heartbeat(?::thread:[^:]+)?$/i`. `resolveIsolatedHeartbeatSessionKey`
  (`src/infra/heartbeat-runner.ts`) appends `:heartbeat` to the session it wakes and a
  `:thread:<id>` suffix can follow it, so `agent:main:main:heartbeat` and
  `agent:main:slack:channel:c…:thread:…:heartbeat` both count. Matching the _appended_ marker
  rather than the word anywhere keeps a cron job merely named `heartbeat`
  (`agent:main:cron:heartbeat:run:<id>`) out.
- **`cron`** — `isCronSessionKey` from `src/routing/session-key.ts`, which is the existing
  helper for `agent:<agentId>:cron:<jobId>[:run:<runId>]`, the shape
  `resolveCronAgentSessionKey` and `src/cron/isolated-agent/run.ts` build. The unscoped
  `cron:<jobId>` form a job binds before it is agent-scoped counts too.
- **`human`** — everything else, including a key the guard cannot read.

Two consequences worth knowing:

- A heartbeat that runs **without** `heartbeat.isolatedSession` reuses its conversation's
  session key and is indistinguishable from a person's turn, so it reads as `human` and is only
  audited. `alwaysCancel` is what still holds in that case.
- `human` being the fallback means an unrecognised key loosens the guard rather than cancelling
  work nobody asked it to cancel.

## Always-Cancelled Classes

`alwaysCancel` lists classes that are cancelled in **every** kind, audited ones included,
unless the lane explicitly allows that action (`lane.py` `allowed_actions`). It defaults to
`["publish_external"]`: leaving the sandbox for the outside world is not something to merely
observe.

"Explicitly allows" means `lane.py check` answered exit 0 for that class. A missing lane, a
denial of that class, and a broken check for it all leave it unallowed, so all three cancel.
A refusal of some _other_ class in a chained command does not, because the lane did answer for
this one — the enforced kinds cancel that command on their own, and an audited kind is meant to
audit it.

## Audit Trail

Every classified command appends exactly one line to `<workspace>/state/lane_guard.jsonl`
under the shared advisory lock (`lane_guard.jsonl.lock`, mkdir, stale after 10 s), whether the
command ran or not:

```json
{
  "ts": "2026-09-03T10:00:00.000Z",
  "session": "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609",
  "kind": "human",
  "thread": "C0A3C98HS48:1786591963.108609",
  "class": "runpod",
  "lane": "kv-harvest",
  "decision": "allowed",
  "mode": "audit",
  "reason": "lane 'kv-harvest' allows 'runpod' for $5.00 ($43.00 of $60.00 would remain)"
}
```

`kind` is `heartbeat`, `cron` or `human`; `mode` is `enforce` or `audit`, which is
`enforce[kind]` — what the guard was allowed to do. `decision` is what it did: `allowed`,
`denied` (the tool call was cancelled) or `dry_run` (refused, but the kind is audited and no
`alwaysCancel` class forced a cancel). `class` joins the classes with `+` when a command
charges more than one. Unclassified commands are not audited. An audit write that fails is
logged and does **not** decide the tool call — a stuck lock or a full disk must not block every
classified command through the fail-closed path.

## What It Does Not Catch

Classification reads the literal command string. `eval "$LAUNCHER"`, a base64-decoded payload,
a generated wrapper script, or a launcher named through a shell variable is not classified, so
it is neither checked nor audited. The guard raises the cost of spending by accident; it is not
a sandbox boundary and must not be described as one.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "lane-guard": {
          "enabled": true,
          "enforce": { "heartbeat": true, "cron": true, "human": false },
          "alwaysCancel": ["publish_external"],
          "patterns": {
            "runpod": [
              "runpod_spawn\\.sh",
              "runpod_pod\\.py\\s+(?:create|start)\\b",
              "\\brunpodctl\\b"
            ],
            "silico": ["silico_slurm\\.sh\\s+(?:submit|sbatch)\\b"],
            "spark_gpu": ["(?:^|[\\s/\"'])scripts/dgx(?![\\w.-])"],
            "local_cpu": ["\\bsystemd-run\\b"],
            "api_calls": ["\\bcodex\\s+exec\\b", "\\bhcom\\s+codex\\b"],
            "publish_external": [
              "\\bgh\\s+release\\b",
              "\\bgh\\s+pr\\s+create\\b",
              "\\bgit\\s+(?:-[\\w-]+(?:=\\S+)?\\s+(?:[^-\\s]\\S*\\s+)?)*push\\b(?:\\s+(?:--|--?(?!repo=)\\w[\\w-]*(?:=\\S+)?))*\\s+[\"']?(?![\"'-])(?!origin(?![\\w./@:~-]))[\\w./@:~-]+",
              "\\bgit\\s+push\\b[^&|;\\n]*--repo=[\"']?(?!origin(?![\\w./@:~-]))\\S+",
              "\\bnpm\\s+publish\\b",
              "\\bpip\\s+upload\\b",
              "\\btwine\\s+upload\\b"
            ]
          },
          "estimates": {
            "runpod": 5,
            "silico": 0,
            "spark_gpu": 0,
            "local_cpu": 0,
            "api_calls": 1,
            "publish_external": 0
          }
        }
      }
    }
  }
}
```

Every block above is the shipped default, so an omitted key changes nothing. `enforce` is
merged per kind and `patterns` / `estimates` per class: what you omit keeps its default, and a
malformed entry (a non-boolean enforcement, a non-string pattern, a negative estimate) falls
back to the default rather than gating on junk. A malformed `enforce` value or `alwaysCancel`
list is logged as an error while it falls back, because `"human": "true"` is a common
templating slip and an operator must not be left believing they turned enforcement on.
`alwaysCancel` falls back to its default if it holds anything that is not an action class, but
an explicitly empty list stays empty.

Config can therefore switch the publication gate off, either with `"alwaysCancel": []` or with
`"patterns": { "publish_external": [] }`. That is deliberate — an empty list is an explicit
operator choice everywhere in this hook — but it means `alwaysCancel` is a strong default, not
an invariant the config cannot reach.

## Known Gaps

Found by an adversarial review on **2026-09-07** and **left unfixed on purpose**. Nothing here
is in progress or half-done: each one is a decision somebody still has to make, written down so
it is not rediscovered as a surprise. The findings from that same review that _were_ fixed —
lane selection, refusal codes, unreadable `lane.py` output, contradictory origins, ask-ledger
conflicts — are described in the sections above.

- **`# lane:<id>` is unauthenticated.** The marker is trusted with no channel or thread check,
  and `before_tool_call` params are model-generated, so a command carrying
  `# lane:<some-other-lane>` charges a lane authorized in a different channel and thread. It
  cannot simply be made to require thread coverage: the marker exists for the sessions that
  resolve no thread at all (a DM routed by user identity, a cron run, a sub-agent), which would
  then have no way to name a lane. The candidate fix is to require the named lane to cover the
  thread **when a thread is resolvable**, and to decide the no-thread case separately.
- **`check` and `reserve` are a time-of-check/time-of-use pair.** Neither call is told the
  thread, the channel, or the generation of the record the lookup matched, so a lane whose
  `origin` or `allowed_actions` change between the lookup and the booking is still charged
  under the answer the old record gave. `lane.py`'s atomic writes prevent torn JSON; they do
  not close this window.
- **Rollback is best-effort.** When a multi-class command books one class and then cannot
  reserve the next, a `release` that itself fails is logged and otherwise ignored, so the lane
  can stay charged for a command that never ran. The real fix is one atomic multi-class reserve
  in `lane.py`, not more retrying here.
- **A failed audit write does not stop the command.** A full disk or a stuck lock means a
  classified command can run leaving no line in `lane_guard.jsonl`. That is deliberate — a
  state-write failure must not decide a fail-closed tool call — but it makes the accounting
  path fail-open, and the journal is the whole point of the audit trail.
- **`alwaysCancel` is configuration, not an invariant.** `"alwaysCancel": []` in a human
  session lets `publish_external` run with no lane at all, and `enforce.heartbeat` or
  `enforce.cron` set to `false` does the same for unattended work. Config can reach every gate
  in this hook (see **Configuration** above).
- **The two gates classify with different tables.** The turn-gate reads `DEFAULT_LANE_PATTERNS`
  and `DEFAULT_LANE_ESTIMATES` while the guard reads the configured ones, so a configured
  pattern or estimate makes the gate and the guard disagree about what a promise or a command
  even costs. They share the lane lookup and the lane selection; they do not share the class
  table.
- **A human session is audited, not enforced.** A failed lookup, or a check that could not be
  run, is a refusal — but in a human session that refusal only writes a `dry_run` line and the
  command still runs unless its class is in `alwaysCancel`. This is the documented trade-off (a
  person in the thread is the authorization the lane records stand in for), and it means an
  unanswered question stops a spend only in the enforced kinds.
