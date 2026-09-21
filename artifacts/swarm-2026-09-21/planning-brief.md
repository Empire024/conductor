# Planning brief for the Conductor token-thrift swarm (2026-09-21)

You are the planning partner for a small agent swarm run from Conductor itself. Your job in this turn: read the facts below and the repository, then return a concrete, bounded dispatch plan. Do not edit files; this is a read-only planning turn. Reply with the plan as markdown in your final message.

## Owner's request (verbatim intent)

"Use a mix of our current top frontier models with varying methods creating a small agent swarm here to make Conductor extremely powerful, using some tokens now, saving a lot later. Do this to local models also in another tab, make them even more useful for token saving; also have that tab research models that'd be even more powerful. Also run a sweep of our current model capabilities with capabilities of codex & claude itself, see if we're running latest models, methods & are visualising everything correctly in the tabs for each model. Also find other extremely powerful local agents we could add to Conductor for even more token saving & making Conductor an even more powerful agent-swarm suite while keeping the token costs as low as possible; keep in mind the restrictions of this local machine & make sure the projects know about it to not overload the machine; find models within our capabilities. Possibly find Chinese models for $20 a month max we could use to do a lot of churning if at frontier levels."

## What was delivered earlier today (commit f40ada8, release v0.1.36)

Conductor used to append its whole briefing (memory protocol, task rules, app-control credential, coworker log, recalled memories) to every message sent to a native runtime. Measured over two weeks of real logs (`node scripts/measure-context-churn.mjs`): on Claude the briefing was 2.4x the owner's own words (~1,600 tokens per turn), the control paragraph repeated verbatim in 40% of follow-ups, a quarter of memory lines were repeats, 79% of the coworker log was "view" intents. Now `src/main/turn-briefing.ts` sends static parts once per native runtime (again after resume/reconnect/compaction, marked by a `contextReset` notice from the Claude and Codex adapters), memories once per runtime, coworker log as a delta. Live probe (`node scripts/probe-context-cost.mjs`): a one-word follow-up on Haiku added 1,672 tokens of context before, 1,019 after (the rest is Claude Code's own per-turn additions). Read `docs/context-accounting.md` for the numbers, including: mean context per call over two weeks was 160k tokens with 192 calls per session, so fresh tabs per task beat long sessions on cost; a fresh Claude tab's first call reads ~18.9k tokens from the prefix cache shared across tabs and writes ~8.6k.

## Machine (MAIN)

- AMD Ryzen 9 7900, 12 cores / 24 threads; 63 GB RAM (about 32 GB free while a 9B local model is loaded).
- NVIDIA GeForce RTX 5070, 12 GB VRAM (8.3 GB in use by the running llama-server); an AMD iGPU is present but irrelevant.
- Disks: C: 347 GB free (system, keep model files off it), D: 1 TB free (local model root `D:\ConductorLocal`), E: 1.1 TB free.
- Local stack: llama.cpp via `scripts/local-models/*`, models configured: Qwen 3.5 9B and Qwen 3.6 35B-A3B (see `docs/local-models.md`, `src/main/local-models/*`, `src/main/providers/local.ts`). The local runtime is Conductor's own agent loop (OpenAI-compatible chat completions, tool schemas sent on every request, sandboxed Docker tools, no steering, `trimMessages` budget guard).
- CLIs: Codex CLI 0.153.4, Claude Code 2.1.278. Providers in Conductor: codex (gpt-6-astra, gpt-5.6-sol/terra/luna), claude (default, opus[1m], claude-fable-5-1[1m], sonnet, haiku), local, plus legacy PTY providers gemini/qwen/kimi.
- Budget right now: Codex weekly 7% used (prolite plan), Claude 5-hour 9%, 7-day 11%, Fable weekly 17%. The owner accepts spending tokens now to save later.

## Hard constraints for every coworker

1. Never run `git commit`, `git push` or `git checkout`; the controller commits the batch. The working tree also holds other agents' uncommitted work in these files, which must not be modified or reverted: docs/local-models.md, scripts/fixtures/fake-claude.mjs, src/main/agent-control.ts, src/main/agent-control.test.ts, src/main/close-confirmation.ts, src/main/database.ts, src/main/index.ts, src/main/local-models/agent.ts (one line), src/main/local-models/control-integration.test.ts, src/main/local-models/tools.ts, src/main/project-activity.ts/.test.ts, src/main/providers/adapter.ts, src/main/providers/claude.ts/.test.ts, src/main/structured-sessions.ts/.test.ts, src/main/structured-store.ts, src/renderer/src/attention.ts/.test.ts, src/renderer/src/components/TabActivityIndicator.tsx/.test.ts, src/renderer/src/panes/ProcessDashboardPane.helpers.ts, src/renderer/src/panes/StructuredAgentPane.tsx, src/renderer/src/styles.css, src/renderer/src/use-app-updates.ts, src/shared/models.ts, src/shared/structured-agent-reducer.ts/.test.ts, src/shared/structured-agent.ts, package.json, feature-list.md. If a task genuinely needs one of these, the edit must be a small additive hunk and reported explicitly.
2. No window over the owner's screen: any app launch uses `CONDUCTOR_TEST_USER_DATA` (parked window) or a script under `scripts/`; never a bare `npm run dev`.
3. Evidence: unit tests and `npx tsc --noEmit` for code; a smoke script for anything the owner can see; measured numbers for anything about tokens. A report is a claim, not evidence.
4. Do not download multi-gigabyte model files or install system software without the owner's say; propose the exact command instead. Do not start a second llama-server while one is running unless VRAM allows it (12 GB total).
5. At most four coworkers per dispatch batch; each coworker owns a disjoint file area and is told what the others own.

## Draft workstreams (critique, merge, split or replace them)

A. Local models, token thrift (engineering): cut per-request overhead in the local loop (system prompt size, tool schemas on every request, `trimMessages`, reasoning defaults, llama.cpp prompt/KV cache reuse across turns, response reserve), measure before/after with the local harness, add a VRAM/RAM guard so a second model cannot overload the machine, and record the machine limits where every project sees them.
B. Stronger local models within this hardware (research + config): shortlist models that fit 12 GB VRAM + 63 GB RAM (MoE A3B-class, gpt-oss-20b-class, coder variants), with evidence of coding/agentic quality, quantization and expected tokens/s; produce config snippets and setup commands, no downloads.
C. Capability sweep (Codex + Claude): compare Conductor's catalogs, effort lists and adapter capabilities with what the installed CLIs actually expose (codex `model/list`, config, reasoning efforts, compaction, background tasks, subagents, web search, MCP; Claude Code models incl. 1M variants, effort levels, fast mode, thinking display, compaction, hooks); verify the tab UI shows the right model label, context window, effort choices and usage for each model; fix discrepancies with tests; update `docs/conductor-provider-parity.md`.
D. Research, cheap frontier-level API models (Chinese providers at <= $20/month: DeepSeek, Kimi/Moonshot, GLM/Z.ai, Qwen/Alibaba, MiniMax, others) and other powerful local/open agent runtimes (OpenCode, Aider, Goose, Crush, OpenHands, Cline, etc.): frontier-level evidence (SWE-bench and the like), pricing tiers, API shape (OpenAI-compatible or Anthropic-compatible endpoints), data handling, and which Conductor integration path each fits (the local adapter's OpenAI-compatible loop pointed at a remote endpoint; a Claude Code harness pointed at an Anthropic-compatible endpoint; a new PTY/structured provider). Deliver a ranked recommendation and an integration design, no code.
E. Conductor-side methods that save tokens later (design, maybe implementation): a "hand off to a fresh tab" action when a conversation's context passes a threshold, carrying a compact summary plus project memory; routing policy in the router/fixer that sends mechanical work to cheaper or local models; anything else the measurements justify.

## What I need from you

1. A dispatch plan: 3-4 coworker tasks for the first batch (title, provider, model, effort, permission, exact file ownership, the prompt's key instructions, success criteria and required evidence), and what a second batch would hold.
2. For each task, the concrete risks (machine overload, cache-breaking changes, UI regressions, collisions with the uncommitted work above) and how the prompt should defuse them.
3. Your own view of the highest-leverage token-saving methods for Conductor beyond what exists, ranked by expected savings against effort, with the evidence you rely on.
4. Anything in the draft you think is wrong or missing.

Keep the plan tight; the controller integrates, tests, builds, commits and publishes.
