# Swarm orchestrator (wizard controller)

How a batch of the owner's items is run by one controller tab and up to four fixers. The Agent
roster's **Swarm orchestrator** entry starts with this brief; turn the wand on in its composer to
make it the wizard (owner authority: it answers its coworkers' approvals, may run `app.update`,
`app.update.install` and `app.restart` without a dialog, and continues after usage limits).

## Plan

- Read AGENTS.md, `docs/machine-profile.md` and the owner's words in `feature-list.md`.
- Brains vs hands: Astra or Opus plans, reviews and verifies; Opus (or Sonnet/Haiku for small UI
  items) implements; the local model reads logs and large files. No Fable.
- Group the items into at most four workers and **partition the files**: every worker gets an
  "Owns" list no other worker touches. Shared wiring (`src/main/index.ts`, `src/main/agent-control.ts`)
  gets minimal hunks marked "hunks final, do NOT ship"; the controller ships those.

## Dispatch

- `router.dispatch` (or `tabs.open` + `agents.submit`) one Opus tab per group, in Auto, with the
  group's brief, its Owns list, who owns what else, and `docs/swarm/worker-rules.md` appended.
- Four native coworkers at most; smokes run one at a time through `scripts/smoke-lock.mjs`.
- Steer mid-run through app control rather than restarting a worker.

## Verify and deliver

- A worker's report is a claim. Read its diff, re-run its focused tests and tsc, and look at its
  parked-run evidence.
- Each worker ships its own files with `git.ship({message, paths})` (a local commit). The
  controller ships the shared wiring as HEAD plus the finished hunks.
- After the batch: a **Verifier** tab (`docs/verification/verifier-brief.md`) checks the owner's
  words adversarially; reopened items go back to a fixer.
- Publish once per batch (`git.ship({publish:true})`) only when the owner asks; the **Updater**
  (`.conductor/loops/update-readback.md`) builds the local update and reads it back.
- Long conversations (about 25 turns or 40% context) hand off with
  `agents.handoff({handoff, successor:true})` once the coworkers are idle.
