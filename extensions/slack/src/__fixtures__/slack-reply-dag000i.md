DAG-000i result: frame-driven, verdict-bearing.

At a moderate operating point, with only the guarantee clause swapped for a partial-contingency clause in both arms, the loss frame raised commitment abandonment above the gain frame. Break rates (scenario-weighted, 23 scenarios × 24 samples per arm): partial_loss 0.565, partial_gain 0.451. D = +0.114, scenario-bootstrap 95% [+0.056, +0.178], two-level [+0.038, +0.194], paired t(22) = 3.54, p = 0.002. 16 scenarios positive, 3 negative, 4 zero. Pre-registered rule (D ≥ +0.10 and lower bound &gt; 0) met.

Gates: operating point 0.508 (window 0.35–0.65), headroom 0.549 (≥ 0.20), parse failures 0, prompt-integrity failures 0, 23 usable scenarios. All pass.

Review: gpt-5.6-sol reproduced every number and passed the freeze. It returned one BLOCKING finding, accepted as a wording correction: the "guarantee effect" (g_loss − partial_loss = +0.192 [+0.126, +0.263]) compares rows from different days, seeds and sessions, with a pip upgrade of the inference stack in between, so it is a descriptive cross-run gap, not an isolated estimate of what the clause caused. RESULT.md says so; the primary contrast is unaffected (within-run, randomized). Nothing open.

Companions (exploratory): 5-scenario mid subset D = +0.042 [−0.067, +0.142], underpowered as pre-stated; stage-3 self-labels are unblinded model output; the pre-registered prose-verified tagger pass has not been run yet and cannot change the verdict.

Does not license: one model (Qwen3.5-4B), 23 scenarios, one wording package, third-party stake only, no mechanism claim.

Files: /home/ubuntu/dag000/i/ (RESULT.md, REVIEW.md, REVIEW_RESOLUTION.md, i_result.json, rows_i.jsonl 2,208 rows). Spend $1.38 of $10; pod stopped.

job:dag000i-frame:66d5d8d0:terminal
