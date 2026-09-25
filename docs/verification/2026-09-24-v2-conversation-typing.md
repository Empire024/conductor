# Verification V2: conversation and typing (2026-09-24 swarm)

Loop: `.conductor/loops/verify.md`. Brain (plan and judge): agent_mug1vj6z_m5kwlx3 (Fable 5.1, then Opus 5.5).
Executor: Sonnet, agent_mug27h2i_u5hj606. The plan was 37 scenarios written from the owner's item text in
feature-list.md, the image `.conductor/prompt-images/5d3c199c-….png`, and the named commits. It was not written from
the implementers' tests.

Every run used a parked instance (`CONDUCTOR_TEST_USER_DATA`, `CONDUCTOR_OFFLINE_TESTS=1`, through `smoke-lock`),
built from an isolated worktree at HEAD `48ae029`. The shared tree did not typecheck at the time, because other
agents had edits in progress. Evidence is in `artifacts/verify-v2/` and `artifacts/perf-input/v2-*.json`, and the
logs are in `.conductor-scratch/v2/logs/`. Both are git-ignored and local to MAIN. The smokes are
`scripts/smoke-verify-v2-*.mjs`. The refusal fixture is `scripts/fixtures/verify-v2/fake-claude.mjs`, a copy of
fake-claude with `SYNTHETIC REFUSE ONCE|ALWAYS|ONCE SLOW` and `SYNTHETIC ERROR500`.

## Verdicts

| Item | Scenarios | Verdict | Failing scenario and evidence |
| --- | --- | --- | --- |
| `typing-lag-long-conversation` (604adbb) | A1, A2, A4, A5 | **REOPEN** | The owner's target is p95 under 16 ms on the 10k conversation at 4x throttle. It is not met at any tab count. The implementer's own commit records 31 ms, so the target was never reached. See "Typing" below. |
| `141e0a02` renderer causes (787df26) | A1, A2, A4, A6 | **VERIFIED** | Both causes the owner named are fixed. Drafts write to localStorage 14 times in 300 keystrokes, not once per key. Only one conversation pane is mounted with 26 tabs, and drafts survive tab switches (`draftKept` at 11 and 26 tabs). |
| `9fb1c9c5`, `f15c9164`, `2ad233c6` queue merge and unsend (214d21f) | B1n, B2, B3, B5n, B6, B7n, B8n, C6b, C6c; B4r inconclusive; B9 neighbour | **VERIFIED** | Five messages queued within 1 s reach the provider as ONE turn, in order, whether the turn ends on its own or with Escape. The provider capture holds `--- Queued message 1 of 5 ---` through `5 of 5`, the queue ends empty and the phase ends completed (`b1n-timeline.png`, `b7n-timeline.png`, `b3-results.json`). The X button and Alt+Backspace return the text to the draft without corrupting it. Follow-ups are listed below. |
| `fb515071` safeguard refusal continues on the next model (214d21f) | C1a, C1b, C2, C3, C4, C6b, C6c | **VERIFIED** | With the owner's exact refusal text, Fable moves to Opus with the notice "Fable refused this turn; continuing on Opus 5.5" and a single user bubble (`c-C1a.png`). This holds for both result shapes: success with `is_error`, and `error_during_execution`. A second refusal in the same turn stops, after 2 attempts. A refusal on Sonnet, the last model in the ladder, does not retry. An ordinary API 500 does not switch models. Messages queued during the refusal are delivered once, merged, after the fallback turn. |
| `24e307fa` chat part: paging, Copy transcript, find (02366d5, 3ef9f55) | D1, D2, D2b, D3b, D4, D8, D8b | **REOPEN** (Copy transcript) | Paging and find pass. Copy transcript is not the "entire chat transcript" once a conversation passes 20,000 events, and the owner's own conversations are already past that. See "Transcript" below. |
| `764a7740` CLI drawer under Chat (02366d5) | D5n, D6, D7, D8b | **VERIFIED** | The drawer opens under Chat while a turn runs and shows the running tool's lines live (`d5n-t0.png`, `d5n-t6.png`). Toggling it 10 times during a streaming turn keeps one `.xterm`, the same renderer and no page errors. Typing into the idle CLI reaches the process: `echo-v2-sentinel` was echoed. The stock `smoke-conversation-history.mjs` passes all 8 checks at its default size. |
| `3b2ea0f` Chat → CLI → Chat with coworker tabs | E1, E2, E3r | **VERIFIED** | A controller with 3 coworkers (2 running, 1 idle, and then all idle) kept the identical `tabs.list` before the switch, in CLI mode and after it. After a graceful relaunch, the layout dump held the same 4 tab ids and resource ids and the same active tab (`e3r-result.json`, `e3r-tabstrip-*.png`). |

## Typing (reopen `typing-lag-long-conversation`)

Failing scenario, to become the next batch's acceptance check:

```
node scripts/smoke-lock.mjs -- node scripts/perf-input.mjs --provider=claude --events=10000 --tabs=1,11,26 --throttle=4 --label=v2-10k-tabs
```

| Tabs | p50 | p95 | p99 | Commits per 300 keys | Timeline mutations |
| --- | --- | --- | --- | --- | --- |
| 1 | 17.4 ms | 23.4 ms | 29.2 ms | 315 | 0 |
| 11 | 22.0 ms | 29.1 ms | 32.6 ms | 320 | 0 |
| 26 | 21.6 ms | 30.9 ms | 39.9 ms | 324 | 0 |

Source: `artifacts/perf-input/v2-10k-tabs.json`. The 1-tab row is a run with no lock contention. An earlier run
under heavy machine load measured p95 48.3 ms (`v2-10k.json`).

- **What is fixed.** The timeline no longer re-renders per key (0 mutations), and there are no long tasks.
  Switching back to the long conversation takes 627–935 ms.
- **What remains.** p95 is 1.5–2x the target, and it grows with tab count. React still commits about 1.05 times per
  keystroke. Profile a keystroke on the 10k conversation (`--profile`) and remove the remaining per-key work outside
  the timeline.
- **Typing while a turn streams (A5).** 200 characters were typed during a `SYNTHETIC LONG 20000` replay. No
  keystroke was lost, but latency was p50 27 ms, p95 895 ms, p99 2,540 ms and max 33,170 ms. The fixture replays
  about 12,000 events per second, far faster than a real provider, so the spike is most likely the moment the whole
  batch lands. perf-input has no streaming mode. Add one that emits at a realistic rate (for example 20 events per
  second for 60 s) and require p95 under 32 ms while it runs.
- **Pasting 1 MB (A4).** The paste was refused with a clear alert in 748 ms that names the 128,000-character limit.
  The 100 keystrokes typed right after measured p95 40 ms and p99 131 ms.

## Transcript (reopen `24e307fa`, Copy transcript)

Failing scenario: a Claude conversation seeded with `SYNTHETIC LONG 10000`, which pushes the journal past sequence
20,000. `scripts/smoke-conversation-history.mjs --events=10000` fails at line 100 with "the transcript starts with
the first prompt". The copied transcript opens with `# SYNTHETIC LONG 10000`, then `_Earlier activity in this
conversation is no longer stored._`, then `## Step 1667: tracing…`. The first `## You` prompt and roughly the first
third of the conversation are missing (`d2-diag-transcript.md`).

- **Cause.** `StructuredStore.checkpoint` (`src/main/structured-store.ts:221`) deletes every journal event below
  `sequence − 20,000`, and the resident projection keeps only 2,000 items. The transcript can hold nothing older.
- **Why it matters to the owner.** The owner asked for one click that copies the entire chat, for the long wizard
  conversations they scroll through. The wizard tab controlling this batch is at sequence 35,573 (`agents.list`), so
  its first ~15,500 events are already gone.
- **Acceptance for the next batch.** A conversation beyond sequence 20,000 copies a transcript that starts with the
  first `## You` prompt and contains every user and assistant text. Tool output may stay excluded, as now. The
  conversation text (user and assistant text items) needs retention beyond the bounded event journal, or a
  transcript accumulated outside it.
- **What passes.** Under the cap (`SYNTHETIC LONG 4000`), Copy transcript takes 615 ms for 1.5 MB. It holds 2,002
  headings, starts with the first prompt, ends with the final line, and contains no tool output (`transcript-4000.md`).
  An empty and a one-turn conversation copy cleanly. Scrolling up pages in 250 cards at a time, anchored, up to the
  journal floor. Find reaches journal-only history: "Step 1700: tracing" shows "1 of 1" in 238 ms, and Enter pages
  the hit in and highlights it (`d3b-step1700.png`). "Step 20" returns no matches, which is correct, because it lies
  below the deletion floor.

## Follow-ups that are not reopens

- **Queue while an approval is pending (B4r), inconclusive.** The composer shows Steer while the approval card is
  pending. Pressing Enter made the card disappear unanswered, and the steer stayed in `pendingSteering`
  (`b4r-*.png`). The fixture caused this. fake-claude handles a mid-turn `SYNTHETIC B…` message as a new prompt and
  emits a finished result while the permission is still open, and the real CLI holds such a message until the next
  tool boundary. Recheck against the real claude CLI (Haiku, one Bash approval, steer a message, then Allow once).
  Expect the card to stay answerable and the message to be delivered once.
- **Claude steering batch, not verified offline.** A Claude follow-up is steered, not queued. Each steer is its own
  bubble, and the CLI decides whether they reach the model in one continuation. The owner's screenshot (four "You"
  bubbles) looks like this path. Recheck live: four fragments within 1 s while a Claude turn runs tools. Expect one
  model continuation, not four turns.
- **`scripts/smoke-conversation-followup.mjs` fails by design (B9).** Lines 74–77 still expect 3 separate user
  messages after draining 3 queued ones. It should assert the merged `--- Queued message i of N ---` turn.
- **The model picker after a fallback (C5) was not established.** The smoke set the model through
  `structured.submit`, not the picker. Check that the picker shows the fallback model after a refusal.

## Harness problems found on the way (for the owner and the controller)

- **Stray processes.** Three early smokes of this run hang in `app.close()` behind the unanswered native "Work is
  still running" quit dialog. They are `smoke-verify-v2-b.mjs` (node pid 53140, Electron 49772) and
  `smoke-verify-v2-d.mjs` (node pids 58644 and 52392), and they still hold parked Electron apps. Stopping them was
  refused by the auto-mode classifier, so the owner must end them.
- **Smoke teardown.** Every smoke must answer the quit dialog and bound `app.close()`, as
  `scripts/smoke-agent-control.mjs:132-146` does. The later V2 smokes do this.
- **`scripts/smoke-lock.mjs` lock takeover.** The lock treats a holder older than 20 minutes as stale and takes it
  over. A soak or a hung smoke therefore loses the lock, and up to three smokes from different agents ran at once
  tonight. That also distorts timing runs. A holder whose pid is still alive should not be stale.
- **Isolated worktree.** `C:\Claude\conductor-v2-verify` is a detached worktree at `48ae029`, and its
  `node_modules` is a junction to the main checkout. It is left in place because the stray processes run from it.
  Remove the junction with `rmdir` before `git worktree remove`.
