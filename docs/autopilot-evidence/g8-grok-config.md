# G8 — Grok native model/effort changes fail ACP validation

Date: 2026-09-24. Author: Opus coworker agent_mufbso5i_obbgteu (task task_mufbsott_bzetlto).
Installed runtime: `grok 1.0.41 (4220f3b224a6) [stable]` at `%USERPROFILE%\.grok\bin\grok.exe`.

## Result

Grok 1.0.41 accepts `session/set_config_option` only with the value id as a **plain string**:

```json
{"sessionId": "<session>", "configId": "model", "value": "grok-4.7-build-fast"}
{"sessionId": "<session>", "configId": "reasoning_effort", "value": "medium"}
```

Every object shape fails deserialization with `-32602 Invalid params: data did not match any
variant of untagged enum SessionConfigOptionValue`, before the option is looked up: `{value}` (what
`src/main/providers/grok.ts` sent), `{type:"select",value}` and `{valueId}`. An unknown id in the
accepted shape fails cleanly with `unknown model id` / `unknown reasoning_effort value` and leaves the
session usable. The success response carries the full `configOptions` array with the confirmed
`currentValue` of each option (plain strings).

No ACP schema is vendored in `node_modules`, and no other provider (`codex.ts`, `claude.ts`) sends
`session/set_config_option`, so the stdio probe is the authority, per the project rule that protocol
questions are settled by probes, not docs.

## Root cause and fix

- `grok.ts` sent `value: { value }` for both options, so every non-default model or effort failed.
  Because `applySettings` also runs inside `initialize`, a conversation saved with a non-default
  choice failed to connect at all, which is why the configured tab could not resume.
- It also passed the whole response to `adoptConfigOptions`, which expects the array, so confirmed
  values were never read back.
- Fix (`src/main/providers/grok.ts`): one `setConfigOption(configId, value)` sends the plain string
  and adopts `result.configOptions` as the confirmed settings. At connect/resume, a choice Grok (or the
  catalog pre-check) refuses no longer disconnects the conversation: it stays on the settings Grok
  confirmed, emits a notice naming them, and the next turn asks again and fails on its own.
- Fixture (`scripts/fixtures/fake-grok.mjs`): now answers like the installed CLI: non-string value
  → the exact untagged-enum -32602; unknown id → `unknown model id` / `unknown <option> value`. The
  previous fixture accepted `{value}`, which is why the old test passed against a broken adapter.
- Tests (`src/main/providers/grok.test.ts`): the old assertion of `value: {value: ...}` is replaced
  by plain-string assertions plus confirmed `effectiveSettings`, a high→medium change on the same
  session, Grok Fast at medium opened both new and resumed, and a refused setting on resume that keeps
  the session connected.

## Zero-turn probe (installed CLI)

`node scripts/probe-grok-config.mjs` (exit 0). Spawns `grok agent --no-leader stdio` in a temp
directory, `initialize`, `session/new`, then only `session/set_config_option`. **No `session/prompt`
was sent; no model turn ran; billing untouched.** Session id and cwd are replaced by placeholders;
no credentials appear in any frame. Transcript, verbatim:

```jsonl
{"step":"initialize","protocolVersion":1,"agentInfo":null}
{"step":"session/new","configOptions":[{"id":"model","type":"select","category":"model","currentValue":"grok-4.7","options":["grok-4.7","grok-4.7-build-fast","grok-4.6","grok-4.5"]},{"id":"reasoning_effort","type":"select","category":"thought_level","currentValue":"high","options":["xhigh","high","medium","low"]}]}
{"step":"session/set_config_option","configId":"model","shape":"plain string","sent":"grok-4.7-build-fast","result":{"configOptions":[{"id":"model","type":"select","category":"model","currentValue":"grok-4.7-build-fast","options":["grok-4.7","grok-4.7-build-fast","grok-4.6","grok-4.5"]},{"id":"reasoning_effort","type":"select","category":"thought_level","currentValue":"high","options":["xhigh","high","medium","low"]}]}}
{"step":"session/set_config_option","configId":"model","shape":"{value}","sent":{"value":"grok-4.7-build-fast"},"error":{"code":-32602,"message":"Invalid params","data":"data did not match any variant of untagged enum SessionConfigOptionValue at line 1 column 111"}}
{"step":"session/set_config_option","configId":"model","shape":"{type:\"select\",value}","sent":{"type":"select","value":"grok-4.7-build-fast"},"error":{"code":-32602,"message":"Invalid params","data":"data did not match any variant of untagged enum SessionConfigOptionValue at line 1 column 127"}}
{"step":"session/set_config_option","configId":"model","shape":"{valueId}","sent":{"valueId":"grok-4.7-build-fast"},"error":{"code":-32602,"message":"Invalid params","data":"data did not match any variant of untagged enum SessionConfigOptionValue at line 1 column 113"}}
{"step":"session/set_config_option","configId":"reasoning_effort","shape":"plain string","sent":"xhigh","result":{"configOptions":[{"id":"model","type":"select","category":"model","currentValue":"grok-4.7-build-fast","options":["grok-4.7","grok-4.7-build-fast","grok-4.6","grok-4.5"]},{"id":"reasoning_effort","type":"select","category":"thought_level","currentValue":"xhigh","options":["xhigh","high","medium","low"]}]}}
{"step":"session/set_config_option","configId":"reasoning_effort","shape":"{value}","sent":{"value":"xhigh"},"error":{"code":-32602,"message":"Invalid params","data":"data did not match any variant of untagged enum SessionConfigOptionValue at line 1 column 108"}}
{"step":"session/set_config_option","configId":"reasoning_effort","shape":"{type:\"select\",value}","sent":{"type":"select","value":"xhigh"},"error":{"code":-32602,"message":"Invalid params","data":"data did not match any variant of untagged enum SessionConfigOptionValue at line 1 column 124"}}
{"step":"session/set_config_option","configId":"reasoning_effort","shape":"{valueId}","sent":{"valueId":"xhigh"},"error":{"code":-32602,"message":"Invalid params","data":"data did not match any variant of untagged enum SessionConfigOptionValue at line 1 column 110"}}
{"step":"session/set_config_option","configId":"reasoning_effort","shape":"plain string","sent":"medium","result":{"configOptions":[{"id":"model","type":"select","category":"model","currentValue":"grok-4.7-build-fast","options":["grok-4.7","grok-4.7-build-fast","grok-4.6","grok-4.5"]},{"id":"reasoning_effort","type":"select","category":"thought_level","currentValue":"medium","options":["xhigh","high","medium","low"]}]}}
{"step":"session/set_config_option","configId":"model","shape":"plain string","sent":"grok-4.7-build-fast","result":{"configOptions":[{"id":"model","type":"select","category":"model","currentValue":"grok-4.7-build-fast","options":["grok-4.7","grok-4.7-build-fast","grok-4.6","grok-4.5"]},{"id":"reasoning_effort","type":"select","category":"thought_level","currentValue":"medium","options":["xhigh","high","medium","low"]}]}}
{"step":"session/set_config_option","configId":"model","shape":"plain string","sent":"grok-9","error":{"code":-32602,"message":"Invalid params","data":"unknown model id"}}
{"step":"session/set_config_option","configId":"reasoning_effort","shape":"plain string","sent":"turbo","error":{"code":-32602,"message":"Invalid params","data":"unknown reasoning_effort value"}}
```

## Real adapter against the installed CLI (zero turns)

A throwaway vite-node script constructed the real `GrokAdapter` with the installed `grok.exe` and
called only `start()` then `stop()` (no `submit`), three times in one temp cwd: a new session on
Grok Fast/medium, a resume of that same native session at grok-4.7/low, and a resume asking for an
unknown model. Exit 0:

```jsonl
{"step":"new Grok Fast / medium","requested":{"model":"grok-4.7-build-fast","effort":"medium"},"confirmed":{"model":"grok-4.7-build-fast","effort":"medium","approvals":"owner","grokAutoMode":false},"resumedSameSession":null,"notices":[]}
{"step":"resume same session at grok-4.7 / low","requested":{"model":"grok-4.7","effort":"low"},"confirmed":{"model":"grok-4.7","effort":"low","approvals":"owner","grokAutoMode":false},"resumedSameSession":true,"notices":[]}
{"step":"resume with unknown model grok-9","requested":{"model":"grok-9","effort":"high"},"confirmed":{"model":"grok-4.7","effort":"low","approvals":"owner","grokAutoMode":false},"resumedSameSession":true,"notices":["Grok kept model grok-4.7 with low effort: Grok does not offer the model grok-9"]}
```

`confirmed` is `effectiveSettings`, adopted from Grok's own `configOptions` response. The third run
shows the fixed resume behaviour: the session re-attached and kept Grok's confirmed settings instead
of failing to connect.

## Checks

| Check | Command | Result |
|---|---|---|
| New tests fail on the old adapter | `git show HEAD:src/main/providers/grok.ts` swapped in temporarily, `npx vitest run src/main/providers/grok.test.ts` | 3 failed / 15 passed; failures are `Grok request failed (-32602): Invalid params (data did not match any variant of untagged enum SessionConfigOptionValue at line 1 column 111)` — the owner's live error. Fixed file restored. |
| Focused tests with the fix | `npx vitest run src/main/providers/grok.test.ts` | 18 passed, exit 0 |
| Provider suite | `npx vitest run src/main/providers/` | 10 files, 228 tests passed |
| Typecheck | `npx tsc --noEmit -p .` | exit 0 (a first run showed errors only in another coworker's in-progress `src/main/durable-jobs/store.test.ts`; rerun clean) |

Raw transcripts also kept at `artifacts/autopilot/g8-grok-config-probe.jsonl` and
`artifacts/autopilot/g8-grok-adapter-acceptance.jsonl` (git-ignored).

## Not done

- No Grok model turn was run (Grok Build had no usage balance, and the task forbids prompts). The
  set-then-prompt path is covered by the fixture tests; the settings themselves are confirmed by the
  installed CLI above.
- The installed Conductor app is not updated by this commit; it receives it through `app.update`
  after the controller's batch.
