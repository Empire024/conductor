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

### One long session or several tabs

Cache reads are billed at roughly a tenth of fresh input and cache writes at roughly 1.25 times it. A fresh Claude tab's first call in the probe read 18,904 tokens from the prefix shared with every other Conductor tab and wrote 8,600, so a new tab costs about the same as reading 130,000 tokens of cached context once. Over the same two weeks the mean context per call was 160,000 tokens with a mean of 192 calls per session, so a long session pays that new-tab price on every call. A task started in a fresh tab is cheaper than the same task continued in a session past roughly 130,000 tokens of context, and several times cheaper for a session at the two-week mean; what the fresh tab loses is orientation, which project memory exists to carry across. Coworker tabs opened by the router each pay the fresh-tab price and share the cached prefix, which is why nothing per-conversation is put in the system prompt.
