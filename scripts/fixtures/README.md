# Provider test fixtures

Ordinary tests make zero provider inference calls. `fake-codex.mjs`, `codex-app-server.mjs`, `fake-claude.mjs` and their associated messages are **synthetic** raw-protocol fixtures. They run only at explicit test boundaries; the Electron fixture flag is cleared by packaged Conductor. They are not live-provider evidence.

`panel.mjs` and `panel.test.mjs` are the exact locally prepared acceptance baseline. The synthetic runtimes only mutate a disposable copy after a matching approval and capture a real local Node test's output. `SYNTHETIC B` is a fixed fixture response, not proof of a provider remembering a conversation.

`captured/` is separate. Its JSON files identify the real runtime version, source, submission count and redactions. The Codex 0.153.4 MCP-key failure occurred before a prompt. The quoted-rg approval was captured during the single live A submission, which stopped before answering that request. Reproduce the latter offline with `node --test scripts/live-acceptance-guard.test.mjs`; do not rerun paid prompts to test the guard.

Final actual-Electron screenshots and sanitized results are retained in `docs/evidence/agent-ui/`. Current test runs write ignored `artifacts/` output. The live allowance is persistent local state, not a resettable fixture; do not delete it or create a new suite to obtain retries.
