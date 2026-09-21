# Context and working tokens

Checked against the installed Claude Code VS Code extension 2.1.263 on 2026-09-07 (`webview/index.js`). Its `updateUsage` replaces context with the latest assistant usage: input + cache read + cache creation + output. It does not add prior requests. Its composer passes model context window minus maximum output tokens minus 13,000 tokens to its context gauge. Model limits come from the result's `modelUsage` entry for the active model. A compact boundary clears the prior context snapshot.

Conductor follows that accounting and waits for reported model limits rather than guessing model capacities. Codex uses `thread/tokenUsage/updated.tokenUsage.last.totalTokens` and the runtime's `modelContextWindow`, preserving `total` exclusively for cumulative usage. The upstream [Codex token usage implementation](https://github.com/openai/codex/blob/main/codex-rs/tui/src/token_usage.rs) explicitly distinguishes active context (`last`) from accumulated session usage (`total`). Its TUI has a separate baseline adjustment; Conductor uses the app-server capacity as reported.

The working indicator shows only reported generated output for the current response (including reasoning where the provider includes it). It does not add input, cached input, or reasoning a second time. A new user prompt clears the previous working count until another output report arrives. No hidden reasoning text is read or displayed.

The context circle appears at 40% of usable capacity, turns orange at 70%, and becomes red with a thicker ring and a subtle three-second opacity pulse at 90%. Reduced-motion preferences disable the pulse. Clicking opens context details and shows `/compact` guidance near/full capacity. This control does not submit a prompt or compact automatically. Missing/invalid context reports stay unknown, child usage is excluded, and reports after compaction can decrease the percentage. Conversation totals remain available in View usage.

Validation: provider protocol tests cover cached input, output reserves, independent cumulative/current usage, compaction and model resets; summary tests cover thresholds and missing data; `node scripts/smoke-session-controls.mjs` checks interaction, visual states, output separation, pulse and reduced motion without inference.

## What Conductor appends to a prompt, and how often

After the owner's text, every message sent to a native runtime carries Conductor's own context: recalled project memory, the memory-write protocol, the coworker briefing, the project-task rules and the app-control endpoint with its per-conversation credential. `node scripts/measure-context-churn.mjs` reads the provider logs under `~/.claude/projects` and `~/.codex/sessions` plus the app's recall ledger, sends nothing to a model, and puts numbers on it. Over the two weeks to 2026-09-21, when all of it was sent with every message: on Claude the appended context outweighed the owner's own words 2.4 to 1 (about 1,600 tokens per briefed turn); the app-control paragraph was repeated verbatim in four follow-up turns out of ten; more than a quarter of the memory lines repeated a memory the same conversation had already received; and 2,524 of the 3,190 coworker log entries were "view" intents. Because a provider keeps its conversation, each copy stayed in the context for the rest of the session and was re-read on every call after it, and Codex's guardian review threads replay the whole transcript, so every byte in the main thread was paid for there again.

A runtime forgets on exactly two occasions: a new process (a fresh conversation, a resume, a reconnect) and a context compaction, which both adapters mark with a notice whose payload carries `contextReset`. `src/main/turn-briefing.ts` therefore sends the static parts once per runtime and again after either, a memory once per runtime, and the coworker log as a delta since the previous message without view-only intents; the collaboration pane still shows the full log. A local model gets its memory and one instruction the same way and never a credential. `node scripts/smoke-context-briefing.mjs` (after `npm.cmd run build`) is the offline regression guard: the first prompt carries everything, a follow-up carries only the owner's words, a memory learned since is sent once, a resumed conversation is briefed again.

Measured live with `node scripts/probe-context-cost.mjs` (a parked window, a fresh profile, eight seeded memories, two one-word turns per model, real inference), the context a follow-up message added to the conversation:

| Model | Before | After | Conductor's share |
| --- | --- | --- | --- |
| Claude Haiku 4.5 | 1,672 tokens | 1,019 tokens | 653 → 0 |
| Claude Sonnet 5 | 2,136 tokens | 1,228 tokens | 908 → 0 |
| Codex gpt-5.6-luna (low) | not captured | 1,638 tokens of context; the whole 20,303-token thread re-sent as input, 18,176 of it cached | 0 |

What remains after is Claude Code's own per-turn additions (tool and MCP deltas, reminders); the second user message itself shrank from 2,697 characters to the 58 the owner typed.

### Calls, turns, children and the v0.1.36 boundary

The analyzer now treats a user turn and an API call as different units. A tool-using turn can make many calls. Claude logs also repeat the same cumulative usage on several assistant records; those records are collapsed by request ID. Codex cumulative token snapshots are converted to positive deltas, including after a reset. Calls are classified as parent, Claude sidechain, Codex guardian or other child work, and by their durable event timestamp before or after `2026-09-21T16:30:00Z`. Cached input means Claude cache reads or Codex cached input; uncached input means Claude ordinary input plus cache creation, or Codex input minus cached input.

The sanitized 14-day aggregate regenerated on 2026-09-21 contained 484 sessions, 3,131 user turns and 34,392 API calls after 26,812 duplicate usage records were discarded. Claude had 26,172 calls for 1,096 turns (23.88 calls/turn), with input per call p50 165,933 and p90 376,371. Codex had 8,220 calls for 2,035 turns (4.04 calls/turn), with p50 115,045 and p90 197,084. Parent calls were 28,118; sidechains were 4,733 and guardians 1,541, so child work was 6,274 calls in total. The distributions and definitions are in `artifacts/swarm-2026-09-21/context/aggregates-2026-09-21.json`.

Before the change, 34,112 calls had mean input 178,497, p50 149,629 and p90 341,014; the short post-change sample had 280 calls with mean 141,217, p50 120,986 and p90 217,453. These are different workloads, not a paired experiment. They show observed context, not a measured saving caused by v0.1.36.

### Continue, compact or hand off

The earlier claim that a fresh tab is several times cheaper was stronger than the evidence. A fresh Claude tab's first probe call read 18,904 shared-prefix tokens from cache and wrote 8,600. Whether a handoff saves tokens depends on the current model, cache ratio, number of calls still expected, and the extra work needed to write the handoff, re-orient, verify state and escalate mistakes.

The replay sensitivity in the aggregate is explicitly an **estimate**, not a measured product saving. It charges cached input at 0.1 of uncached input, output at 3 input-token equivalents, a 1,200-token handoff, 2,500 tokens of re-orientation, 4,000 of verification, and an expected 900 tokens for escalation. At a 90% cache ratio, the estimated fresh-handoff payback is 2 calls for Fable/Sonnet, 3 for Opus/Astra/Sol/Terra, 14 for Luna and 28 for Haiku at each model's observed median context. Compaction generally pays back sooner in this static replay, but it can lose details and still needs verification. These thresholds are advisory; only a paired accepted-task experiment can establish product savings.
