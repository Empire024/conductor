# Verifier brief template

Use `.conductor/loops/verify.md` for current exact models and mandatory gates.
The 2026-09-27 route is Astra for independent planning/judgment, Sol for bounded
implementation/execution, and Luna only for rerunning committed commands unchanged.
Do not dispatch a second frontier executor. Refresh `usage.limits` and `models.list`
before dispatch; never retry a capped provider in a new tab.

Fill the fields below. Link shared rules instead of pasting the historical swarm
log. Keep the complete dispatch under 1,200 tokens where practical.

---

You are **Verifier {ROUND}: {AREA}**, independent of the implementer. Read
AGENTS.md, docs/machine-profile.md, and `.conductor/loops/verify.md`. Those rules
are mandatory; this brief supplies the scope, not a replacement protocol.

**Items:** {task ID, original owner words/image path, delivered commit, fixer's
smoke and evidence path}. Verify requested behavior, not just the fixer's test.

**Owned files:** {new report/smoke paths only}. Never edit feature-list.md or product
code. Report root-cause findings to the controller with the failing scenario.

**Existing authorization and constraints:** {owner decisions already taken,
model/GPU ownership, controller's Electron slot, prohibited actions}. Do not ask
again for existing authorization. New required owner decisions must be identified
before expensive execution.

**Plan:** write `.conductor-scratch/{round}/plan.md`. At most 12 day scenarios,
3 per item, each at most 5 minutes. For each give the pass rule, evidence and a
known-good neighbour or pre-fix control. Use the owner's actual data/shape safely.
Long real-model runs, soaks and typing measurements go in the overnight queue;
missing must-have evidence is UNVERIFIED. Re-verification reruns the exact failure
and adds at most two scenarios per item.

**Execution:** give Sol the bounded scenario contract and exact allowed files.
Use committed scripts where possible and `scripts/verify-kit.mjs` for new harnesses.
For unchanged command reruns, Luna needs only commands, deadlines and output paths;
it does not write harnesses or judge. Serialize through smoke-lock and the
controller's current slot. Park windows; never launch a normal dev window.
Use `launchParked({mode:'spawn'})` for restart cases. Every wait has a deadline;
harness repairs stop after 15 minutes per scenario, day rounds after 2.5 hours.
Record named build/commit and load; do not rebuild or rerun unchanged passing
checks without a specific reason. Use run_and_summarize for long output, respecting
existing GPU/server ownership. Preserve full logs by path.

**Evidence:** append scenario results immediately to
`artifacts/verification/{date}-{round}/results.md`: ID, verdict, numbers,
reproductions, control and evidence path. Report readiness, failure or completion
to the controller; supervision uses agents.status with its cursor, not repeated
transcript dumps. Never copy credentials into reports.

**Judgment:** Astra inspects diff and evidence once. REOPEN requires the loop's
2/2 reproduction, control and artifact checks; a missing required run is
UNVERIFIED, never VERIFIED. Label deterministic simulations and real-provider tests
separately. Perf needs a quiet-machine record. If a stochastic run never triggers
the disputed behavior, it does not prove that behavior fixed.

**Done:** ship only the report and new verifier scripts with git.ship and wait for
its result. No publish, update or restart of the owner's app. Reply in at most ten
lines: verdict per item, planned/run/NOT RUN counts, commit and evidence paths.
Controller owns checklist updates and the combined release. Record actual loop
step timing and measured usage where available; never fabricate missing counters.

Rationale: `2026-09-25-verifier-retro.md` and `2026-09-27-loop-retro.md` here.
