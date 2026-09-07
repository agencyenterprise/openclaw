<@U03EH553GBE> Short version: Stage 0 never validated the instrument, and the failure taught us more about measurement than about bribes.

*What the study asked*: can a Qwen3-32B agent, told its payoff depends on the grader's difficulty rating, be caught deliberately withholding effort (scoring lower) vs an honest arm? Stage 0 was the instrument check before the 2,240-session campaign.

*What we found*

• V10 (the corrected non-thinking instrument) failed its preregistered gate: honest 0.376 vs withholding 0.339, drop 0.036, task-cluster CI [-0.056, +0.140], 96/arm. Campaign never launched.
• V11 manipulation check: _conditional_ withholding ("hold back when the task is easy") did nothing again, even slightly reversed (-0.034, CI [-0.096, +0.029], and it used ~1.4 more calls than honest). But an _unconditional_ "deliberately underperform" instruction dropped score by 0.35 on all 28 of 28 tasks. So the instrument can see sandbagging when it happens; the model just does not do it under the conditional bribe framing.
• V12 decomposition: explicit-conditional, soft-unconditional and full-unconditional all produce ~0.31–0.36 drops. The thing that kills the effect is specifically the model having to _judge_ the contingency itself. Comprehension probes were 100% in every arm, so it is not misunderstanding.

*Reading*: on this model and battery, there is no measurable spontaneous strategic withholding. That is a validated negative for the _instrument-in-this-form_, not a claim that the behavior does not exist — cluster-aware power for the 0.10 effect was only 30–46%.

*Lessons that generalize* (now in memory/standing rules)

1. Compute power in the same unit as the preregistered analysis (task clusters, not rows). Row-level MDE was 0.09; cluster-aware was 0.15–0.17.
2. Per-task degeneracy guard before any aggregate: one task scored 0 in all sessions, two had identical arm means, dropping one task flipped the sign. Same guard later caught the PCB-001 inversion.
3. Report budget exhaustion per task; pooled counts cancelled opposite-direction confounds.
4. Plumbing: `python -I` dropped the env var, so Qwen silently ran in thinking mode for two runs (score 0.76 → 0.36, throughput 12x). Now: capture a real request body, hash the harness per run, hard-abort on the failure signature.
5. Never edit harness files mid-measurement; a self-written "resolution" file is not a closed review gate.
6. Reward-as-resource designs manufacture their own dose curve; equalize incoming resource, pay after submit.

Lane state: closed by announced default on 08-25, campaign rule still `do_not_launch`. Reopens on your word if you want the rebuilt battery run. Artifacts: `experiments/2026-08-19-bribe-test-agentic/RESULT_STAGE0_V2.md`, `RESULT_STAGE0_REBUILD_V11.md`, `RESULT_STAGE0_REBUILD_V12.md`.
