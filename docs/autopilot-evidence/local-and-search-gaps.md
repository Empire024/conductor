# G4 and G5: file-search ranking and the local output-budget loop

Worker `agent_mufdrvl7_d8h8d4r`, task `task_mufdrxx0_q3eh83u`, controller `agent_muer6h9a_fwe9n16`. Recorded 2026-09-24.
Raw logs are in gitignored `artifacts/autopilot/g4g5/` (`.gitignore:5`); the figures below are copied from them.

## G4: files.list ranks active source first

### Root cause

The ranking lives in `src/main/project-file-search.ts`, not `agent-control.ts`: `files.list` calls `searchProjectFiles(..., { showHidden: true })`. Every copy of a file got the same score as the real file, because the score came only from the file name and path length. The tie-break was `path.localeCompare`, so `.recovery-…/` and `artifacts/` sorted before `src/`. Hidden folders are included for agents (`showHidden: true`). On this checkout that means about 11.5k `artifacts/` files and 2k `.recovery-urgent-release-20260908/` files.

### Change

- `isCopyPath(path)` marks a path as a copy when one of its **folders** is one of these:
  - `artifacts`, `out`, `dist`, `release`, `coverage`, `.conductor`, `.next`, `.cache` or `node_modules`;
  - a folder whose name contains `recover`, `snapshot` or `backup`;
  - any dot-folder except checked-in config (`.github`, `.vscode`, `.devcontainer`, …).

  A file *named* `recovery.test.ts` is still source.
- `fileMatch(path, query)` returns an explicit tier:
  - exact path;
  - exact name or path suffix (e.g. `shared/usage-accounting.ts`);
  - name prefix;
  - name contains;
  - path contains;
  - fuzzy.
- The sort order is: tier first, then source before copy, then score plus the active-project and recent bonuses, then path. A copy never crosses a tier, so a file that only exists as a copy is still found (e.g. `local-recent.json`).
- Each result that is a copy carries `copy: true`. `files.list` spreads the search result into its reply, so agents see the flag without an `agent-control.ts` change.
- New option `excludeCopies`: it drops copies except those matched by exact path or name, so the filter never hides a file that was asked for.
  - It is not yet exposed through `files.list` args. Call-site change for the controller (`src/main/agent-control.ts` `files.list` branch), one line:
    `searchProjectFiles([...], query, { showHidden: true, ...(args.copies === false ? { excludeCopies: true } : {}) })`, plus `copies?` in the method description.
  - The ranking fix does not depend on it.

### Evidence

- **Live before**, through the installed app's app control: `files.list({query:'usage'})` (`artifacts/autopilot/g4g5/g4-live-before.json`) put 6 copies ahead of `src/main/usage-limit.ts` and `src/shared/usage-accounting.ts` at index 25.
- **Failing before**, on the pre-change module: `npx vitest run src/main/project-file-search.test.ts` exit 1, 4 failed / 7 passed (`g4-before.log`).
- **Passing after**: same command, exit 0, 11 passed (`g4-after.log`). The fixture has:
  - source, `artifacts/`, `.recovery-…/`, `.conductor/backup/`, `recovered-files/` and `release/` copies;
  - 150 extra `artifacts/run-NNN/` copies, to prove exact path, exact name and path suffix all return the source file first, and that an exact-path query for a copy returns that copy;
  - `excludeCopies` tests.

  One existing assertion was updated: the stale `.conductor/tasks/feature-list.md` is now returned with `copy: true`, after the real file.
- **Live after**:
  - Command: `node scripts/smoke-local-output-budget.mjs --project=C:\Claude\conductor --skip-local`, from a detached worktree at `031f9f0` holding only this change set (built with `npx electron-vite build`, exit 0).
  - The app was parked on an isolated `CONDUCTOR_TEST_USER_DATA` profile. `files.list({query:'usage'})` went through real app control on this checkout.
  - `src/shared/usage-accounting.ts` is at **index 4**. The first copy is at 9 (`.recovery-…/src/main/usage-limit.ts`) and the first `artifacts/` copy at 10.
  - Indexes 0–8 are all `src/`. `files.list({query:'src/shared/usage-accounting.ts'})[0]` is the source file.
  - Log: `artifacts/autopilot/g4g5/live-g4.log`, results in `live-g4/smoke-results.json`.

## G5: output-budget loop stops after one repair

### Root cause

`src/main/local-models/agent.ts` answered every truncated tool call (`finish_reason: 'length'` with unparseable arguments) the same way:
- a "send it in parts under about 6000 characters" result;
- then the next request.

Two things made that a loop:
- **Nothing counted cuts.** The stagnation detector only stops after several identical repeats, and each repeat is a full 2,560-token generation (about 190 s at the 13 tokens/s in `artifacts/autopilot/local-second-write-failure.json`, sequences 281/285).
- **The advertised part size did not fit the limit.** 6000 characters is not inside 2,560 tokens once the model's reasoning and JSON escaping are counted.

On the pre-change runtime the deterministic fixture below made **8 requests** against a model that kept cutting.

### Change

- New helper `src/main/local-models/output-budget.ts`:
  - `chunkCharsFor(limit)`: part size derived from the output limit, e.g. 3000 characters for 2,560 tokens, bounded to 800–6000.
  - `truncatedCallResult`: the one repair. It gives that concrete size and says a second cut ends the turn.
  - `salvageTruncatedArguments`: decodes the target `path` and the `content` produced so far from JSON cut anywhere, dropping a split escape.
  - `outputBudgetLoopStop`: the stop detail and the durable partial result.
- In `agent.ts`, the ledger counts cut calls per tool for the turn:
  - The first cut gets the repair.
  - The second cut of the same tool completes the tool protocol group and runs nothing. The turn ends with the new stop reason **`output_budget_loop`**, whose detail starts `Output-budget loop: 2 write_file calls … cut off at the 2560-token output limit (…), the second after the runtime asked for parts under 3000 characters; the turn stopped instead of retrying.`
  - The turn's final text (conversation, journal, stop card and checkpoint `nextAction`) carries the partial result:
    - files written so far this turn, with sizes;
    - the failure;
    - the salvaged content (up to 12,000 characters), marked "NOT written to disk", so no partial or corrupt file is created;
    - `To continue: write_file for <path> with the first part only, then write_file with append: true … under 3000 characters`.
- `src/shared/local-stop.ts` gains the reason `output_budget_loop` (label "Stopped: tool call too large for the output limit twice").
  - `phaseFor` in `providers/local.ts` maps it to `failed`. Reusing `output_limit` would have mapped a stop with text to `completed`.
  - `durable-jobs/handoff.ts` `RETRYABLE` does not list it, so a durable job stops rather than re-running the same stage. That file is unchanged; the controller may choose otherwise.

### Evidence

- **Failing before**:
  - The new `src/main/local-models/output-budget.test.ts` was run against HEAD `agent.ts` in a detached worktree with only the helper and test copied in.
  - Result: exit 1, 3 failed / 5 passed (`g5-before.log`): `expected [...] to have a length of 2 but got 8` and `... length of 3 but got 9`. The label/phase test failed too.
- **Passing after**: `npx vitest run src/main/local-models/output-budget.test.ts src/main/local-models/agent-loop.test.ts src/main/project-file-search.test.ts src/shared/local-stop.test.ts src/main/providers/local.test.ts` exit 0, 5 files, 59 tests (`g5-after.log`). The fixture's fake llama.cpp server replays scripted SSE:
  1. G5 reproduction: two cut `write_file` calls, with a successful third reply scripted to prove it is never requested. Result:
     - exactly 2 requests;
     - the 2nd request carries the 3000-character repair;
     - stop `output_budget_loop`;
     - the salvaged report and continue instruction are in the text;
     - no `docs/report.md` on disk.
  2. One good part, then two cut appends. Result: 3 requests, and the stop names `docs/report.md (11 bytes)`; the file holds only the good part.
  3. A model that follows the repair: it completes, and the parts are joined correctly (the existing agent-loop test still passes too).
- **Wider suites**: `npx vitest run src/main/local-models src/main/durable-jobs src/shared src/main/providers/local.test.ts` exit 0, 55 files, 611 tests (`suites.log`).
- **Typecheck**:
  - Isolated tree (HEAD + this change set only): `npx tsc --noEmit` exit 0 (`tsc-isolated.log`).
  - Shared working tree: exit 2, only in `src/main/agent-control.test.ts` (`usageLimits` on `StructuredSessions`). That is the other worker's in-progress file (`tsc.log`), not part of this change.

### Live local check: blocked, the Qwen server went down

- **Command**:
  - `node scripts/smoke-local-output-budget.mjs --project=C:\Claude\conductor --out=...\live-g5`, from the same isolated build. Log: `artifacts/autopilot/g4g5/live-g5.log`; results: `live-g5/smoke-results.json`. The run finished at 12:36:00 local time.
  - It dispatched a bounded, report-only `local/qwen3.5-9b` coworker through `router.dispatch`, with `contract.allowedPaths: ['artifacts/autopilot/g4g5/live/local-report.md']`.
  - The prompt demanded one `write_file` of at least 14,000 characters and forbade appends.
- **Result**: the model never ran. The coworker failed within 5 s with `Cannot start local/qwen3.5-9b: unidentified llama.cpp model is already running or starting … Conductor has not stopped it.`
  - That is the `inspectAdmission` branch for a llama process that is not listening on a port (`llama.ts:394`). It throws without stopping anything.
  - The smoke counted one `llama-server.exe` before the run and **zero** after the G5 step. That count was taken before its own teardown `taskkill` of the parked Electron tree.
  - Afterwards port 51436 refuses connections and no llama process remains.
  - The 51436 server has no log under `D:\ConductorLocal\logs`, so it was not started through Conductor's server registry. This worker did not start, adopt or stop it.
  - The run's first report of `pass: true` was a smoke defect. The script now fails when the local turn yields no stop report, and when a turn cuts more than two calls.
- **Not done**: the real-model confirmation that a live turn stops after exactly one retry. Per the brief, this worker did not start a server.
  - To finish, once the owner or controller has a Qwen 3.5 9B server running, run the same command from a build containing this change.
  - It passes when the stop is `output_budget_loop` with exactly 2 cut `write_file` calls, or when the model follows the one repair and completes.

## Files

- `src/main/project-file-search.ts`, `src/main/project-file-search.test.ts`
- `src/main/local-models/agent.ts`, `src/main/local-models/output-budget.ts`, `src/main/local-models/output-budget.test.ts`
- `src/shared/local-stop.ts` (one union member and its label)
- `scripts/smoke-local-output-budget.mjs`: parked, isolated-profile live check for both items
- this file
