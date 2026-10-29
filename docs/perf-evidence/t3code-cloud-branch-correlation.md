# Cloud runs: branch ↔ session correlation (t3code adoption fix)

Scope: `src/main/cloud/runs.ts`, `src/main/cloud/runs.test.ts`, this note, and the exported diff
`t3code-cloud-branch-correlation-integration.patch` beside it. Nothing else changes: no shared
types, no IPC, no renderer, no thread/timing code.

## What went wrong

Three cloud runs were started together from one project during the t3code adoption:

| Run | Hint the CLI logged | What it pushed |
| --- | --- | --- |
| runtime audit | `claude/t3code-cloud-runtime-audit` | `claude/t3code-cloud-runtime-audit-y4xpuw` at `110fa4b` (first) |
| tool timing analysis | `claude/t3code-tool-timing-analysis` | its own branch, later; head `0a519b3` |
| thread separation | its own | its own branch, later; head `cc6879d` |

`findResult` looked for the hinted branch and, **when that was not on origin yet, fell back to "the
one new `claude/*` head since the run started"**. The audit's push was that one head for all three
runs, so all three were marked `pushed` with the audit's branch, head and PR.

The live evidence shows the previous `refreshResult` **did** replace the wrong audit branch as soon
as each run's own hinted branch was pushed (thread at `cc6879d`, timing at `0a519b3`): a hint match
always won over the fallback. The defect was therefore twofold, and only for the window before
that push:

- the unsafe fallback handed another run's branch, head and PR to a run whose own result was
  absent (or ambiguous), and reported it `pushed`;
- while the run's own result stayed absent or ambiguous, nothing retracted that wrong association:
  `refreshResult` only patched in a new match, so with no match the audit's branch stayed.

(The first version of this note and commit `0929f8c`'s message said a wrong branch was never
replaced; that was wrong and is corrected here. The code change is unaffected.)

## The rule now

1. **A run with a `branchHint` takes only its own branch**: the hint itself (strength 2) or the hint
   plus the cloud's one-word suffix, `^<hint>-[A-Za-z0-9]+$` (strength 1). It never falls back to an
   unrelated new head. `claude/fix-tests-x1` is not a match for hint `claude/fix` (another task).
2. **Stale origin refs are not pushes.** The start snapshot (`<id>.heads.json`) now keeps each head's
   sha. A hinted branch that was on origin with the same sha when the run started is an earlier
   run's; a moved sha is this session pushing onto it. Old name-only snapshots still accept the
   exact hint (previous behaviour) but not a suffixed stale ref. A failed or missing snapshot is
   written/read as `null` (unknown), not `[]`, so it no longer makes every existing head look new.
   `refreshResult` waits for a snapshot still being taken.
3. **Concurrent runs from the same `cwd` are rivals** (created within the watch window, not
   `failed`, and the head is not stale for them). A head a rival's hint names more exactly is the
   rival's and is dropped; an equally strong claim (same hint, or two hintless runs) is
   **contested** and nobody takes it on name alone.
4. **The single-new-head fallback survives only for a run that never learned its hint, and only when
   it is safe**: the head is not explained by any rival's hint and no unsettled hintless rival could
   have pushed it (a rival that started after the push saw it in its own snapshot and does not
   contest it). That is the sequential case it was written for.
5. **Session evidence settles what names cannot.** For contested or multiple candidates, and for
   every fallback candidate, the branch is fetched **without a destination**
   (`git fetch --no-tags --no-write-fetch-head origin refs/heads/<b>`, no ref of the project moves)
   and `git log -n 20 --format=%B%x1e <sha>` is read. The first commit that names any
   `claude.ai/code/<session>` decides: this run's session → `ours` (claimed even over a rival);
   another session on the head commit → `other` (never claimed); otherwise `none`. Verdicts are
   cached per run per `branch@sha`; a failed look is not cached.
6. **Unknown means no result.** Ambiguous candidates are kept in memory and `cloud.fetch` says they
   cannot be told apart from another run's (with the session link); a hinted run with nothing
   pushed says it has not pushed `<hint>` yet. No `pushed` status, branch, head or PR is reported.
7. **Cached associations are re-validated every poll.** A recorded branch that the latest look did
   not choose is retracted (`branch`/`headCommit` → null, `pushed` → `running`) when it is still on
   origin (contested now) or does not fit the run's hint (the old fallback's mistake). Its PR URL
   goes too when that PR's head is the retracted branch's sha, and a worktree fetched from it
   (`worktreePath`/`fetchedCommit`) is forgotten. A branch that fits the hint and has left origin
   (merged and deleted) stays the run's result. When the correct branch is found later it replaces
   the wrong one (as the previous code already did once the hinted branch appeared).
8. **`pushed` is still not "finished".** The status keeps its documented meaning (branch on
   origin, the session may still be working); nothing here marks a run done.

## Tests (src/main/cloud/runs.test.ts, `branch correlation between concurrent runs`)

- the owner's case, pure: only the audit run takes the audit branch; timing and threads get
  nothing (also with no siblings in sight); timing's later push goes to timing only.
- sequential fallback compatibility, and each way it is refused (rival hint, concurrent hintless
  rival, foreign-signed push, unknown snapshot); evidence `ours`/`other` settle a contested head.
- stale refs (same sha), a push onto an existing name (moved sha), legacy name-only snapshots,
  longer task names that share the prefix.
- several suffix matches stay ambiguous until evidence; same-hint rivals; exact hint beats a
  shorter rival hint.
- `readSessionEvidence` parsing.
- integration through `CloudRuns` with a scripted CLI: three simultaneous runs, audit pushes
  first, timing later; two hintless runs settled by the commit trailer, with the destination-less
  fetch asserted; restart with the old wrong cached associations (all three on the audit
  branch/PR/worktree) corrected, and a merged-and-deleted correct branch kept.

Against the previous `runs.ts` 10 tests fail: the 8 new ones, and the 2 older ones that were
updated only for the added `verify` field and the more specific "not pushed `<hint>`" message. With
the fix all 21 pass. `npm run typecheck` is clean.

## Surgical patch notes for integration

All in `src/main/cloud/runs.ts`; no other file depends on the changed internals
(`agent-control.ts` imports only the `CloudRuns` type).

- `findResult(lines, hint, known, context?)`: `known` is `KnownHead[] | null` (`string` legacy or
  `{ref, sha}`); new optional `context {siblings, evidence}`; result adds `verify: {branch, sha}[]`.
  New exports: `KnownHead`, `SessionEvidence`, `ResultSibling`, `ResultContext`, `hintStrength`,
  `readSessionEvidence`.
- `CloudRuns`: new private maps `snapshots`, `evidence`, `ambiguous`; `knownHeads()` returns
  `null` for missing/failed snapshots; `start()` writes `{ref, sha}` entries (or `null`) and records
  the pending snapshot; `refreshResult()` rewritten (two-pass with evidence, retraction); new private
  `stillOurs`, `retracted`, `siblings`, `sessionEvidence`; `fetch()` error text from the last
  refresh instead of a second `ls-remote`.
- Persisted data: `runs.json` shape unchanged. `<id>.heads.json` gains shas; old files still load.
- Git calls added in the project folder: `fetch --no-tags --no-write-fetch-head origin
  refs/heads/<claude/…>` (objects only; needs git ≥ 2.29, a failure just means no evidence) and
  `log`. Only for contested/multiple/fallback candidates, once per new sha.

## Exported diff

`docs/perf-evidence/t3code-cloud-branch-correlation-integration.patch` is the exact
`git diff --full-index 3f95349 <implementation commit> -- src/main/cloud/runs.ts
src/main/cloud/runs.test.ts docs/perf-evidence/t3code-cloud-branch-correlation.md` (the patch file
itself is not in it). It applies with `git apply` (or `patch -p1`) on any tree whose three files
still match `3f95349`; where local commits changed them, its hunks show the exact base lines.
