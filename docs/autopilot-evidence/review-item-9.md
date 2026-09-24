# Review item 9 and non-git checkpoints — evidence

Task: `durable-jobs-review-fixes` (feature-list.md), orchestration task `task_mufciu66_8z7mz09`.
Built on HEAD `85b9b0d` (after F1 `cacfc74`, F4 `462fc11`, F2+F3 `85b9b0d`); nothing from those is redone.
Files: `src/main/durable-jobs/worktree.ts`, `src/main/durable-jobs/worktree.test.ts` (new),
`docs/durable-jobs.md` (sections "Dependencies in a job worktree" and "Checkpoints in a folder without git").

## What the module did before

- `gitWorktrees.create` ran `git worktree add` and returned; a Node project's worktree had no
  `node_modules` (git-ignored), so `npm test` in a verify stage failed with "module not found" and
  nothing told the model or the owner why.
- `gitWorktrees.snapshot(cwd, files, dir)` copied only the `files` it was given, and the controller
  passes `job.handoff.filesChanged` (files the model's edit tools reported). A file a shell command
  or a test created was never captured, and there was no restore at all.

## Decision for item 9 (dependencies)

**Default: no provisioning, never a link; a pre-flight note. Opt-in: a private copy.**

Reasons:
1. A junction/symlink to the owner's `node_modules` lets `npm install`, `patch-package` or a build
   cache write through it into the owner's tree. That breaks the one guarantee the job worktree
   exists for (the job never touches the owner's tree).
2. electron-builder drops packages reached through a junction (`docs/machine-profile.md`, project
   memory "Local update from a worktree"), so a job that builds would produce a broken app.
3. A hard-link farm is fast but shares inodes: any tool that rewrites a file in place modifies the
   owner's copy too. Rejected for the same reason as 1.
4. A real copy is fully isolated and was measured feasible: Conductor's own 724 MB / 17,839-file
   `node_modules` copied in **18.1 s**, and vitest ran from the copy
   (`{"copyMs":18120,"links":0,"vitestFromCopy":"vitest/3.2.7 win32-x64 node-v24.18.1"}`). It is
   still a large per-job cost, so it is opt-in per project, not the default.

Implementation (`prepareDependencies`, called by `create`):
- Looks for `package.json` at the repository root and in the job's project folder of the worktree.
  None: `dependencies` is omitted. All have `node_modules`: `status: 'ready'`.
- Otherwise, unless the project opted in, `status: 'missing'` with a `note` that says why tests
  cannot run, why no link is made, and the two ways out (`npm ci` in the worktree, which needs
  network and permission, or the opt-in).
- Opt-in: `.conductor/durable-jobs.json` `{"worktreeDependencies":"copy"}` in the project folder.
  Copies with `fs.cp`, skipping every link (junctions included), so nothing in the copy points back
  out. Refuses when git does not ignore `node_modules/` in the worktree (a checkpoint commit would
  add it). A failed copy is removed and reported.

## Decision for non-git checkpoints

A snapshot now captures the whole folder (skipping links, VCS folders, dependency/cache folders
and files over 50 MB; capped at 20,000 files / 2 GB and marked `truncated`), stores contents once in
a content-addressed `checkpoints/objects/` store shared by the job's snapshots, reuses the previous
manifest's hash when size and mtime match, and writes `manifest.json` (v2) last. The files the job
reported changing are still listed (`changed`) and still get artifact refs. `restore(dir, cwd?,
{prune?})` verifies every stored copy against its sha256 before touching the folder, rewrites only
files that differ, and with `prune` deletes files the snapshot did not have (never inside skipped
folders, never over-size files, never from a truncated snapshot). Old `files/`-layout snapshots
still restore. `snapshotComplete` (used by reconciliation) is unchanged: manifest present = complete.

## Tests

New `src/main/durable-jobs/worktree.test.ts` (real git, real temp folders):
- non-git round trip: `generated/untracked.txt` created during the stage and **not** in the
  reported files survives checkpoint → deletion → restore; a modified reported file is restored;
  `later.txt` survives a plain restore and is removed by `prune`; `node_modules` is neither captured
  nor pruned.
- unchanged content is stored once across two snapshots.
- a tampered stored copy makes restore refuse before changing anything.
- an old-layout snapshot restores.
- dependencies: default reports `missing` with the reasons and no `node_modules` appears; opt-in
  copy makes real directories, skips a junction, a write/delete in the copy leaves the owner's file
  intact and `git status` in the worktree stays clean; opt-in refuses an un-ignored `node_modules`;
  a project without `package.json` reports nothing.

| Step | Command | Exit | Log |
| --- | --- | --- | --- |
| Failing before (new tests, old module) | `npx vitest run src/main/durable-jobs/worktree.test.ts` | 1 (7 failed, 1 passed) | `review-item-9-failing-before.txt` |
| Passing after, shared tree | `NO_COLOR=1 npx vitest run src/main/durable-jobs/` | 0 (11 files, 126 tests) | `review-item-9-passing-after.txt` |
| Typecheck + tests on a clean `git archive HEAD` export with only my two files overlaid | `npx tsc --noEmit`; `npx vitest run src/main/durable-jobs/` | 0; 0 (11 files, 120 tests) | `review-item-9-isolated-typecheck.txt`, `review-item-9-isolated-vitest.txt` |
| Real copy timing (temp folder, deleted after) | `fs.cp` of `C:\Claude\conductor\node_modules` with the module's link filter, then `node vitest.mjs --version` from the copy | 0 | quoted above |

`npx tsc --noEmit` on the shared working tree currently fails only in other workers' in-progress
files (`handoff.test.ts` TaskState/RunEvidence, `store.test.ts` `'command'` kind); the clean export
shows these two files typecheck against HEAD. No Electron smoke was run: nothing here is
lifecycle or UI; the tests drive real git worktrees and real folders.

## Left for the owners of files outside this task

These are one-line hooks in files other workers own (`index.ts`, `controller.ts`); recorded as a
follow-up orchestration task for the controller:
1. `index.ts` `create`: record `worktree.dependencies.note` as a creation `note` event and push it
   into `handoff.constraints`, so the model and the owner actually see it (today it is only
   persisted on `job.worktree`).
2. `controller.ts` `checkpoint`: drop `if (!files.length) return undefined` for the non-git branch,
   so the "Before stage 1" checkpoint is taken as a baseline even before any file is reported
   changed; the snapshot no longer depends on the list.
3. Optionally a `jobs.restore`/view action that calls `restore` for a chosen checkpoint (none
   exists today; restore is available to code and tests only).
