# Codex async question card — review checkpoint

## Actual event and root cause

`agents.history({agentSessionId: "agent_mukkuif9_13z32lh"})` sequences 1302–1303 record `item/started` and `item/completed` for one `agentMessage` (`call_Ig752IEX5Ff0vcLi1I57pBOi`). Its native `item.questions` has three `{title, options}` entries matching the owner's three approval questions; `item.text` repeats their options as prose. No `item/tool/requestUserInput` RPC was emitted for this call. `src/main/providers/codex.ts` emitted only the message text and dropped `item.questions`. The blocking RPC question handler therefore never ran. The owner later reported seeing text without GUI choices (history sequence 3001).

The async question carries no provider question IDs or response RPC. The answer is a later ordinary user message, sent via Conductor's existing steer or start path. The blocking `item/tool/requestUserInput` RPC still uses its existing `respond` path.

## Candidate change

- The adapter emits a question interaction alongside the text, with request ID `codex-async:<thread>:<item>` and question IDs `<item>:<index>`.
- Session response validates each answer, durably claims the card before transport, and submits or queues one ordinary user message. The claim records `Delivery unconfirmed` until Conductor receives the transport result; on restart it cannot be resent automatically. Selected and custom answers are retained by stable question ID, including repeated titles.
- The reducer keeps an unanswered async card through completed and disconnected states, expires it on interruption/failure, and ignores later duplicate pending snapshots after it was answered. The SQLite store keeps the pending card on reload; the conversation pane allows it to be answered across runtime IDs.

## Focused evidence

`node_modules\\.bin\\vitest.cmd run src/main/providers/codex-async-question.test.ts src/main/structured-sessions.test.ts src/main/structured-store.test.ts src/shared/structured-agent-reducer.test.ts src/renderer/src/panes/StructuredAgentRenderers.test.ts` passed after the corrective round: **224/224 tests, 5 files**, exit 0. Full log: `.conductor-scratch/local-assist/2026-09-28T08-58-44-235Z-d0ce8e.log`.

Unit coverage checks three questions and stable IDs on started/completed native snapshots, one later user submission with selected/custom answers, duplicate response rejection, answered-state reconciliation, and pending-card SQLite reload. The corrective tests hold a reconnect and a provider submission while checking the durable nonretryable claim from a second SQLite store, reject a concurrent answer, replay the card from a new runtime, and verify final resolution. A repeated-title pair retains both answers by ID. Existing blocking RPC tests remain green. The actual Codex event is established by native history; no live async tool call was used in these tests. An uncertain acknowledgement proves at-most-once submission, not provider execution exactly once.

## Still required before acceptance

- The independent reviewer approved the corrective **source checkpoint** in `2026-09-28-local-safety-review.md`; acceptance remains unverified.
- Prepared `scripts/smoke-codex-async-questions.mjs` and `scripts/fixtures/codex-async-questions.mjs`. Both passed `node --check`. **Q1–Q3 and the ordinary blocking RPC control are NOT RUN (no numeric serial slot; shared smoke-lock cleanup safety review is still open).**
- When the controller grants a slot after cleanup review: build the exact candidate through the authorized delivery/build path, then run `node scripts/smoke-lock.mjs --timeout-min 5 -- node scripts/smoke-codex-async-questions.mjs` with a parked profile. The smoke imports the repaired `verify-kit`, checks quiet admission, and captures GUI screenshots, durable projections, ordinary user-message receipts, duplicate rejection, renderer reload, an unconfirmed nonretryable claim, and the blocking `item/tool/requestUserInput` control. The controller must confirm the named controller/executor tabs match the smoke's `selfTabs: 2` allowance before admission.
- Fixture limits: it is an offline synthetic App Server with the observed `agentMessage.questions` envelope, not a live Codex tool call. Renderer reload is covered; installed-app process restart and crash timing need separate owner-visible evidence. An unconfirmed delivery demonstrates at-most-once submission, not exactly-once provider execution. No real model or account is contacted.
- An owner-visible candidate check. No build, Electron launch, `git.ship`, publish, update, install, or restart has run.

Codex weekly usage was 54% at 10:09:44Z; the owner raised the hard stop to 55% at 08:56Z. This harness was prepared and stopped before the unsafe launch path.
