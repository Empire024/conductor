# Typing while test instances run (typing-lag-under-test-load)

Owner, 2026-09-25: "actual typing still lags heavily ... i think it's when you're doing testing with conductor".

## How it is measured

`scripts/perf-input.mjs --load=...` types into one parked "owner" instance (a stand-in for the owner's
app: normal priority, `CONDUCTOR_BACKGROUND_PRIORITY=0`, run from a copy of `out/` so the load can rebuild it)
while test work runs next to it. Each round is a quiet window (the same-run floor) and then one
window per load, typed from the moment the load starts until it has finished. Three rounds; the
guard compares medians over the rounds.

| Load | What it is |
| --- | --- |
| `launch` | what one smoke or verifier does: `electron-vite build` into `out/`, a parked Conductor launched from it, up for 8 s, killed |
| `vitest` | the whole vitest suite for 60 s (it finishes in about 50 s here) |
| `swarm` | `launch`, `vitest` and `tsc --noEmit` at once: four coworkers' worth, the machine saturates |

`--load-priority=normal` starts the load the way everything ran before this fix (normal priority, the
parked instance does not lower itself). The default starts it the way it runs now.

Machine: MAIN (Ryzen 9 7900, 24 threads, RTX 5070). Other agents' tsc/vitest and the owner's own
Conductor ran on the machine during every run (quiet windows show 16-27% machine CPU); the smoke
lock was held for the whole of each run, so no other smoke ran. Raw rows:
`artifacts/perf-input/{before,before-swarm,after-swarm,guard-priority-only,after2,guard}.json` (not committed; the tables below are the record).

## Numbers (input to next paint, ms; three rounds each)

One load at a time, renderer unthrottled (`--load=launch,vitest --throttle=1 --load-priority=normal`):

| Load | p95 by round | p99 by round | max |
| --- | --- | --- | --- |
| quiet | 6.5 / 2.8 / 2.9 | 8.2 / 3.2 / 3.4 | 9.8 |
| launch | 3.4 / 3.6 / 3.3 | 4.7 / 4.3 / 3.8 | 11.7 |
| vitest | 4.9 / 5.1 / 4.9 | 8.4 / 6.4 / 6.1 | 12.0 |

A single smoke or a single test run on an idle renderer never hurt typing. The lag needs a
saturated machine and a renderer with real work, which is the owner's case: several coworkers
building and testing at once while a long conversation is open. The swarm runs model the renderer
with `--throttle=4`, as perf-input's other benchmarks do.

Swarm, before (`--load=swarm --throttle=4 --load-priority=normal`):

| Load | p95 by round (median) | p99 by round (median) | max | keys over 100 ms |
| --- | --- | --- | --- | --- |
| quiet | 22.1 / 16.7 / 17.0 (17.0) | 34.0 / 19.6 / 21.6 (21.6) | 103.4 / 21.9 / 23.8 | 1 / 0 / 0 |
| swarm | 77.2 / 67.9 / 71.3 (**71.3**) | 130.2 / 137.3 / 110.8 (**130.2**) | 260.6 / 201.4 / 153.1 | 18 / 14 / 13 |

Swarm, after step 1, below-normal priority only (`--load=swarm --throttle=4`, `after-swarm.json`):

| Load | p95 by round (median) | p99 by round (median) | max | keys over 100 ms |
| --- | --- | --- | --- | --- |
| quiet | 18.1 / 15.4 / 14.8 (15.4) | 29.7 / 17.9 / 17.6 (17.9) | 90.7 / 19.7 / 20.8 | 0 / 0 / 0 |
| swarm | 26.9 / 28.0 / 26.9 (**26.9**) | 30.2 / 33.0 / 29.7 (**30.2**) | 31.4 / 45.1 / 34.3 | 0 / 0 / 0 |

Under load, p99 went from quiet +108.6 ms to quiet +12.3 ms, p95 from +54.3 ms to +11.5 ms, and the
worst key from 260 ms to 45 ms. The load did the same work in the same time (build 35-38 s, 50 s of
vitest, tsc): below normal costs a background job nothing while the owner is not typing.

The first guard run after step 1 (`guard-priority-only.json`), on a busier machine (quiet windows
at 27-38% CPU, other agents' work at normal priority), still missed the bound: swarm p99 median
55.7 ms against quiet 26.5 ms (+29.2), p95 39.8 against 22.2. Below-normal threads still took the
second hardware thread of every core the owner's renderer ran on: vitest forked a worker per
logical core (23).

Swarm, after step 2, below normal and vitest at half the logical cores (`--load=launch,vitest,swarm
--throttle=4 --assert`, `after2.json`):

| Load | p95 by round (median) | p99 by round (median) | max | keys over 100 ms |
| --- | --- | --- | --- | --- |
| quiet | 19.2 / 19.2 / 18.5 (19.2) | 25.1 / 24.4 / 25.5 (25.1) | 74.2 / 30.6 / 29.6 | 0 / 0 / 0 |
| launch | 20.6 / 21.4 / 20.9 (20.9) | 25.0 / 23.3 / 25.0 (25.0) | 27.6 / 32.4 / 28.7 | 0 / 0 / 0 |
| vitest | 27.6 / 33.4 / 27.8 (27.8) | 29.7 / 37.9 / 31.0 (31.0) | 31.9 / 48.1 / 42.2 | 0 / 0 / 0 |
| swarm | 27.0 / 32.5 / 28.6 (**28.6**) | 29.2 / 37.4 / 31.3 (**31.3**) | 34.2 / 104.5 / 35.5 | 0 / 1 / 0 |

A smoke's build and launch is now invisible (p99 +0 ms); a swarm costs p95 +9.4 ms and p99 +6.2 ms.
The suite took 54-57 s instead of 50-52 s.

The guard as documented below, same code (`guard.json`, exit 0). Other agents' normal-priority work
pushed one quiet window to 63% machine CPU, so the quiet floor is noisy here; the swarm's worst key
stayed at 56 ms in every round:

| Load | p95 by round (median) | p99 by round (median) | max | keys over 100 ms |
| --- | --- | --- | --- | --- |
| quiet | 25.6 / 30.3 / 17.9 (25.6) | 36.1 / 40.7 / 20.0 (36.1) | 103.8 / 55.0 / 32.6 | 1 / 0 / 0 |
| swarm | 28.4 / 30.4 / 27.5 (**28.4**) | 32.4 / 35.1 / 33.2 (**33.2**) | 55.6 / 55.6 / 55.9 | 0 / 0 / 0 |

## Root cause

CPU scheduling. Every piece of test work ran at normal priority, the same class as the owner's
Conductor, so a saturated machine shared every core evenly between the owner's renderer and main
process and a dozen build, test and Electron processes. Chromium also starts each instance's GPU
process above normal (`electron.exe above_normal` in the before rows), so a parked instance's
compositor outranked the owner's renderer. Changing only the priority of the load removed the lag,
which rules out the other suspects: the instances share no journal (each has its own
`CONDUCTOR_TEST_USER_DATA`), no control port, and the owner's project watcher already drops `out/`
and `node_modules` events.

## The fix

- `scripts/smoke-lock.mjs` lowers itself to below normal before it starts the run, so the smoke and
  everything it launches (builds, Electron with its GPU and renderer processes, fixture CLIs)
  inherit it: Windows gives a child of a below-normal process below normal, POSIX inherits nice.
  `--priority normal` opts out, for a measurement.
- A parked instance lowers itself too (`src/main/background-priority.ts`, called from
  `src/main/index.ts` when `backgroundWindows`): main at once, before Chromium starts its children,
  and every process in `app.getAppMetrics()` again when the app is ready, whenever a page's DOM is
  ready and every 30 s. That also catches the above-normal GPU process and covers launches that do
  not go through smoke-lock (Playwright tests, the overseer's parked instance, a
  `CONDUCTOR_BACKGROUND_WINDOWS=1` dev launch).
- `vitest.config.ts` and `electron.vite.config.ts` lower their own process, so a test run or build
  an agent starts from its shell is background work as well, with its forks.
- `scripts/lib/background-priority.mjs` holds the helpers and, as
  `node scripts/lib/background-priority.mjs -- <command>`, runs any command below normal from its
  first instruction.
- `CONDUCTOR_BACKGROUND_PRIORITY=0` keeps normal priority everywhere, for the stand-in of a
  measurement or a run someone deliberately wants at full speed.

- `vitest.config.ts` runs at most half the logical cores locally (`maxWorkers: '50%'`, 12 here; CI
  keeps 2). Priority alone decides who runs first, not who shares a core: with a fork on every
  logical core, the owner's renderer shared its core's second thread with a test worker.

- Agent CLIs and the runtime host are lowered when they are spawned (`providers/transport.ts`,
  `runtime-host/host.ts`), so a bare `tsc` or `npm run package` a coworker runs is below normal too.
- Since 2026-09-28 (`lowerSpawned` in `src/main/background-priority.ts`), whatever the owner's own
  Conductor starts for background work also starts below normal:
  - `git.ship`'s steps (tests, typecheck, build, git; `delivery.ts`);
  - `app.update`'s worktree copy, build, installer and smokes (`local-update-build.ts`);
  - `run_and_summarize` commands (`local-assist/tools.ts`);
  - the llama.cpp server (`local-models/llama.ts`).
  `background-priority.test.ts` checks, with a real process, that a delivery step and the child it
  spawns both run below normal.

### Process priorities, checked

A parked instance started straight from a normal-priority parent (`smoke-lock --priority normal`, no
wrapper), read with `Get-CimInstance Win32_Process` 4 s after it was up:

| Process | Parked (default) | `CONDUCTOR_BACKGROUND_PRIORITY=0` (the old behaviour) |
| --- | --- | --- |
| main | below normal | normal |
| gpu-process | below normal | above normal |
| utility (network) | below normal | normal |
| renderer | below normal | normal |

Under the swarm load every process in the load's tree ran below normal (`priorities` in each load
row: node, esbuild, electron, git, cmd), against normal (and the GPU process above normal) in the
before rows.

## Regression guard

```
node scripts/smoke-lock.mjs --priority normal --timeout-min 60 -- node scripts/perf-input.mjs --label=guard --load=swarm --repeat=3 --throttle=4 --assert
```

About 15 minutes. It exits 1 when, over the three rounds, the median p95 or the median p99 under the
swarm load is more than 25 ms (`--bound-ms`) above the same-run quiet median. Before the fix p99 was
+108.6 ms, more than four times the bound; with priority alone +12.3 ms on a calm machine and
+29.2 ms on a busy one (a miss); with bounded workers too +6.2 ms. Not wired into `git.ship`
(too slow); the verifier brief queues it overnight after any change to launch paths, smoke-lock,
verify-kit or parked-window code.
