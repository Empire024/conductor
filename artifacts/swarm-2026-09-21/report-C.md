Task C is complete and orchestration task `task_mublk7tp_a44i5rg` is marked done.

Changed:

- `scripts/measure-context-churn.mjs`
- `scripts/measure-context-churn.test.mjs`
- `docs/context-accounting.md`
- `docs/token-thrift-policy.md`
- `artifacts/swarm-2026-09-21/context/aggregates-2026-09-21.json`

Measured aggregate:

- 484 sessions
- 3,131 user turns
- 34,392 API calls
- 26,812 duplicate usage events discarded
- 28,118 parent calls
- 4,733 sidechain calls
- 1,541 guardian calls
- 6,274 total child calls

The fresh-tab claim is now qualified: estimated payback varies substantially by model and cache ratio, and no product saving is claimed without a paired accepted-task experiment.

Verification passed:

- `node --test scripts/measure-context-churn.test.mjs` — 6/6
- `npx.cmd tsc --noEmit`
- Frozen aggregate reproduced exactly using its recorded `--since`/`--until` command
- `git diff --check`

No network, build, commit, push, checkout, reset, or out-of-scope edits were performed. The controller remains responsible for integration, build, commit, and publication. Note that the artifact directory is Git-ignored, so the controller may need to explicitly include the aggregate when integrating.