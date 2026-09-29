# Typing into a long conversation while coworkers work (typing-lag-long-conversation)

Owner, 2026-09-28 ~21:15Z, on installed cd091c1: typing into the long 1M-context wizard tab lagged
while three coworkers ran. Machine CPU was 33%, and typing into Chrome at the same moment did not
lag. So the cause was Conductor, not machine load.

## How it is measured

`scripts/perf-input.mjs` launches a parked, offline instance and types 200–300 characters at 4x
CPU throttle. It measures each key from keydown to the task after the next frame.
- `--provider=claude --events=10000` replays a 10,000-event Claude conversation: long markdown,
  thinking, Bash/Read/Grep/Edit calls with output and diffs. It projects to 2,000 items.
- `--floor` first measures an empty conversation in the same run. The machine is shared, so the
  floor moves between runs (p95 16–25 ms at 4x); compare only within one run.
- `--background=3x20x60` (new) is the owner's case. The long conversation sits idle while three
  inactive tabs each stream a live turn at 20 events a second for 60 s, and typing is spread
  across their streams. Add `--profile-main` for the main process (every key passes through its
  UI thread) and `--profile` for the renderer.
- `--trace` now also counts the elements each style recalc touched and the objects each layout
  laid out, and lists Blink's invalidation reasons ("StyleRecalc · svg.tab-ring · Animation").
- The result JSON has `timelineCost`: elements, positioned elements and overflow clips in the
  rendered timeline.

All numbers are input-to-next-paint in ms, at 4x throttle, one run per smoke-lock hold, on MAIN
(Ryzen 9 7900, 24 threads, RTX 5070). An idle Dolphin llama-server was up, and other agents'
tsc/vitest were running.

## What cost what

### 1. Main was blocked in `where.exe`

Phone access recomputes its state 400 ms after any agent event. Each recompute read the provider
catalog, and `listProviders()` ran `where.exe` synchronously for six CLIs. `usageSummary` read
the catalog again for every conversation, whose usage it never needs.

While three coworkers streamed, main spent 46 s of the 60 s window inside `spawn`. The owner's
keys waited behind it.

The fix is `src/main/path-lookup.ts`, an in-process lookup cached for 30 s:
- It uses the same order as where.exe: current directory, then PATH, then the bare name, then
  each PATHEXT extension.
- A test checks it against the real where.exe on Windows.
- `agent-manager.ts` and `cli-versions.ts` use it.
- A source guard keeps `execFileSync(`, `spawnSync(` and `'where.exe'` out of both files.

### 2. Streaming conversations rewrote their whole snapshot every burst

`StructuredSessions.flush()` checkpointed each conversation after every burst of provider output:
a `JSON.stringify` of the whole projection plus an UPDATE of `projection_json`, on main. The
owner's long tabs hold 1–7 MB there (the wizard 1.3 MB with 1,172 items, 3.7 ms just to stringify).

A streamed burst now snapshots at most once a second (`checkpointSoon`, `CHECKPOINT_INTERVAL_MS`).
It still snapshots at once when the phase moves or the burst carries an interaction. The journal
still gets every event at once, and a restore replays what came after the snapshot.

### 3. The tab ring's spinner re-laid out its SVG every frame

The ring rotated the `<circle>`. An SVG child is never a compositor layer, so every frame
restyled and re-laid out the SVG of each working tab. That was 3.6 s of layout in the 60 s window.

The `<svg>` now turns instead. A CSS test fails on any endless animation targeting an SVG child.

### 4. Every rendered card cost each key

On an idle 10k conversation, the timeline rendered 250 cards (16,118 layout objects). Each
keystroke's forced layout, paint, layerize and post-layout pass walked all of them, even though
only 21 objects were dirty.

The live end now renders 60 cards (`LIVE_WINDOW`). Scrolling up pages earlier cards in as
before, and coming back to the live end drops the window to 60 again.

| Idle 10k conversation, 1 tab | p95 | vs same-run floor |
| --- | --- | --- |
| before, 250 cards | 22.0 | +6.1 |
| CSS test: timeline hidden | 17.8 | +1.0 |
| CSS test: only the last 40 cards | 19.3 | +2.4 |
| after, 60 cards (1 / 11 tabs) | 22.9 / 24.6 | -1.9 / -0.2 (floor 24.8) |

## The owner's case, before and after

The idle 10k conversation in 4 tabs, while 3 coworkers stream.

| Run | floor p95 | p50 | p95 | p99 | max | keys over 50 ms | main time in `spawn` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before (HEAD 7473ad7) | 27.0 | 22.5 | **81.5** | **92.8** | 98.8 | 82 | 46.9 s |
| + 60-card window | 23.3 | 22.2 | 69.2 | 98.9 | 122 | – | 46.4 s |
| + in-process PATH lookup | 17.6 | 30.1 | 40.1 | 45.8 | 51 | 2 | 0.17 s |
| all fixes | 17.8 | 20.0 | **26.2** | **28.6** | 41.6 | 0 | 0.24 s |

The full-fix row also shows:
- renderer layout 220 ms (3,588 ms before the ring fix);
- main checkpoint time 52 ms (2.1 s before).

With every CSS animation disabled (a diagnostic, not a fix), the same case measured p95 24.8 ms.

## Still open

- **Main commits synchronously on every burst.** `persist` commits each burst in its own
  transaction, and with WAL at the default `synchronous=FULL` every commit syncs to disk on main.
  With three coworkers streaming that is about 8 s of main time per minute, and it moves with disk
  contention. Two ways out, and the owner or controller should choose:
  - coalesce persists over a short window (tens of ms), which delays when the renderer sees an event;
  - `PRAGMA synchronous=NORMAL`, which is safe against an app crash but can lose the last commits
    on power loss.
- **Running CSS animations are restyled on main every frame the typing produces.** These are the
  rings, tab shimmers and pulse dots: about 12 elements per frame, 2.2 s of style per minute at
  4x. It is inherent to Blink while those indicators run.
- **The `--assert` bound for `--background` is floor + 5 ms p95 and no key over 100 ms.** The final
  run is at floor + 8.4 ms p95 with a 41.6 ms worst key, so it passes the key bound and misses the
  p95 bound. Keys over 50 ms went from 82 to 0.
- **The tab-switch step of perf-input fails on HEAD itself** (`.pane-tab[data-control-tab-id]`
  click times out). It now records `switching.error` instead of discarding the typing numbers.

## The composer itself (2026-09-29, 2892a5b)

At rest, what was left was the composer:
- the conversation pane rendered on every key;
- React rewrote the controlled textarea's `defaultValue` (its child text node) on every render;
- a present placeholder cost a style recalc per key.

The textarea is now uncontrolled, the pane renders from a view of the draft that typing leaves
unchanged, and the placeholder is present only while the draft is empty. A keystroke commits
nothing in React: 25–30 commits per 300 keys, all periodic, instead of about 325.

Result on the idle 10k conversation at 4x: p95 11.6–11.9 / 11.6–11.9 / 12.5–12.6 ms at 1 / 11 / 26
tabs in two runs, against HEAD's 15.8–16.9 / 16.1–16.9 / 15.3–15.4. The probe, the numbers and what
was tried are in docs/verification/2026-09-29-typing.md.
