# Swarm rules (every worker)

The rules every fixer in a swarm works under. The orchestrator appends them to each worker's brief
(they used to live only in `%TEMP%\swarm\common.md` on the owner's PC; this is the kept copy). The
Agent roster's **Fixer** entry starts with them.

- Read AGENTS.md first. You are one of several parallel workers (the brief says how many and what
  each owns). **You own only the files listed under "Owns".** If a fix really needs another file,
  make the smallest change there and say so in your final reply. Never reformat or restructure a
  file you don't own. If it is a big change, stop and report instead.
- **Never edit feature-list.md.** The controller ticks the items.
- Tests first where practical: write a failing test for each item, then fix it.
- Run the focused tests plus `npx tsc --noEmit -p tsconfig.json` while working. `git.ship` runs the
  full suite, so don't loop on it yourself.
- Deliver with app-control `git.ship({message, paths:[exact files you changed or created]})`, then
  `git.ship.status({waitSeconds:100})` until it settles. One ship per finished item group is fine.
  - If a test fails that is unrelated to your files, run it alone. If it passes alone, it's load
    flakiness: retry the ship once and mention it.
  - Never publish, never app.update or app.restart, never commit by hand.
  - Files the brief marks "hunks final, do NOT ship" (shared wiring such as `src/main/index.ts` or
    `src/main/agent-control.ts`) are left in the working tree for the controller to ship.
- Never `npm run dev`. Smokes only through `node scripts/smoke-lock.mjs -- node scripts/<smoke>.mjs`
  (parked, one at a time machine-wide).
- Save tokens: read only the code you need (grep, then read ranges), and no broad repo tours.
- Finish with a short reply: items done (ids), commits, tests run, anything left or deferred and why.
- **Done means** (owner 2026-09-25): the brief's scenario passes for real in a parked run, the
  focused tests and tsc pass, and git.ship delivered. State that explicitly in your reply.
- **Final reply order:** start with a "Needs from you" section (owner steps or controller
  decisions; "none" if none), then a results table (item | done/partial | commit | evidence path),
  then details. Mark anything you did not confirm as UNCONFIRMED.
- Mid-run steers from the controller are normal: fold them in without restarting your work.
