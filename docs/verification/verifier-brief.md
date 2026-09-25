# Verifier brief (template for verify loop v3; replaces %TEMP%\swarm\verify-common.md)

Fill in the `{…}` fields and send it as the prompt of **one** Opus tab:
`router.dispatch({tasks:[{title:'{ROUND} verify', prompt:<this>, provider:'claude', model:'opus[1m]', effort:'high'}]})`.
Do not also dispatch an executor. Each rule below cites the measurement behind it from
docs/verification/2026-09-25-verifier-retro.md.

---

You are **Verifier {ROUND}: {AREA}**. Follow `.conductor/loops/verify.md` v3, and read AGENTS.md and
docs/machine-profile.md first. You plan, write, run and judge in this one tab. There is no executor to wait for.

## Items
{for each item: `task-id` (commits; the fixer's own smoke if any) — one line of the owner's own words from
feature-list.md, plus its linked images}

## Owner decisions already taken (do not ask again)
{e.g. "rollback: use the test-mode installer stub"; "prepare-deps: do not run"; "real Claude: haiku only, ≤$1";
or "none"}. Anything else that needs the owner goes into one question **before** you run, never mid-run.

## Plan (at most 20 min)
Write `.conductor-scratch/{round}/plan.md`, with three lanes:
- **Day, at most 12 scenarios and at most 3 per item, each ≤5 min.** The first scenario of each item restates the
  owner's words as a check, on the owner's real data where it is safe (a copy of the real feature-list.md, the model
  the owner picks, a conversation past 20k events). *Retro: ≈16 of ≈19 real catches came from these.*
- **Overnight (a queue, not run by you):** real local-model runs over 5 min, soaks, perf and typing numbers, real
  provider turns, anything over 20 min under the lock. Write the commands into
  `.conductor-scratch/verify-overnight/{round}.md`. *Retro: the soak was cut at 20 min, D1 wasted 2 h, perf ran
  under llama load.*
- **Owner-gated:** list them, and they are NOT RUN (owner) unless decided above.

Leave out generic hostile input (paths with spaces, binary files, emoji) unless the item handles that input. *Retro:
2 catches in ≈40 such scenarios.* For each scenario, write down its pass rule and its **control**: a known-good
neighbour it must pass, or the pre-fix commit it must fail on.

## Run
- Use `scripts/verify-kit.mjs`: `launchParked`, `call`, `openTab`, `safeClose`, `watchdog`, `processAlive`,
  `loadCheck`, `record`. Each new smoke `scripts/smoke-verify-{round}-<group>.mjs` holds scenario logic only. *Retro:
  70 copied scripts and 10k lines; V4 repeated V2's teardown hang.*
  - If the kit does not exist yet, stop and say so. Do not copy the boilerplate again.
- For anything that restarts the app, use `launchParked({mode:'spawn'})`. *Retro: C10.*
- `node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-{round}-<group>.mjs`. Queue **one
  smoke at a time** from this tab.
- Build `out/` once from the named commit, in a clean worktree if the shared tree is mid-edit, and record HEAD.
  Never build with a junctioned `node_modules` for an update.
- **Every wait has a deadline.** A background run gets a watcher that also fires at its deadline. Never end your turn
  only to wait for a notification. *Retro: 7 h 35 min waiting on a finished-but-hung smoke.*
- Harness debugging is capped at **15 min per scenario**, then NOT RUN (harness) with the error. If the lock waiter
  gives up (60 min), the result is NOT RUN (lock), not FAIL.
- **Time-box: {2.5 h} of wall time for the whole day lane.** At the deadline, what is left is NOT RUN (time-box), or
  moves to the overnight queue.
- Append to `artifacts/verification/{date}-{round}/results.md` as each scenario finishes:
  `| id | PASS/FAIL/NOT RUN (reason) | numbers | reproductions n/n | control | evidence path |`.
- Parked instances only. Never `npm run dev`, the owner's window or profile, `taskkill /IM`, model downloads, or a
  second llama-server. Kill only pids your own run started.

## Before you write REOPEN (false-positive guard)
- It reproduced **2 of 2** times on the named build.
- The **control** ran: the harness passes the known-good neighbour, or fails on the pre-fix commit. Without a
  control, the item is UNVERIFIED.
- Checklist: *(retro cases in brackets)*
  - Does the process query exclude itself? [A2]
  - Does the fixture send what the real CLI sends: receipts, SYNTHETIC prompts, ordering? [S2, C6, B4]
  - Are you measuring the thing, not a proxy (tab count, regex over mixed items, CSS variable on another node, DB-only
    seed)? [C8, C9, E4, C1, B3]
  - Is the launch mode the same as the passing controls? [C10]
  - Is the wait at least 2× what this machine needs? [C10/C12 at 30 s, F2 at 5 s]
  - Is the failure explained by an earlier failure in the same run? [A5–A8]
  - Did `loadCheck()` show a quiet machine? [V2 A1 48 against 23 ms]
- Perf numbers without a quiet-machine record (no lock holder, CPU <30 %, GPU <40 %, no mid-turn tab) are NOT RUN
  (load) and go overnight.

## Judge and report
- **VERIFIED**: every must-have scenario passed with evidence.
- **REOPEN**: a guarded failure, with a failing scenario the next batch can turn into a test.
- **UNVERIFIED**: a must-have scenario is NOT RUN; say what unblocks it.
- If the fixer's own smoke fails on HEAD, report it, and the item is not VERIFIED until that is explained.
  *Retro: RV1 19c298e4.*
- Write `docs/verification/{date}-{round}.md` as the item table plus a NOT RUN table plus the overnight queue. Ship it
  and your new smokes with `git.ship({message, paths})`. Do not edit feature-list.md; the controller reopens items.
- Reply in at most 10 lines: the verdict per item, the counts (planned / run / NOT RUN), the wall time, and the
  report path.

## Optional runner (only when committed smokes need re-running unchanged)
You may dispatch one Sonnet or Haiku runner:
`{title:'{ROUND} runner', model:'sonnet', effort:'low', prompt:'Run exactly these committed commands one at a time
under smoke-lock, and paste each exit code and the last 30 lines of its log into <file>. Do not edit or write any
script. Do not judge.'}`.
*Retro: Sonnet ran committed smokes and perf-input fine. It wrote the self-matching A2 query, V4's hanging teardown,
5 retracted RV1 scripts and a `taskkill /IM`.*
