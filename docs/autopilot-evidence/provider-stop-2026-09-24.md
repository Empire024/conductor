# Autopilot provider stop, 2026-09-24

## Observed blocker

Two independent existing Grok sessions returned an explicit provider failure:

- `agent_muerw1fu_a33x86v`, G8 config investigation: 2026-09-24T01:06:27Z, HTTP402, `Grok Build usage balance exhausted`; native turn ended failed at01:06:28.
- `agent_muerh0kt_k3ncw1b`, F1 fixture integration: 2026-09-24T01:06:43Z, same HTTP402 and message; native turn ended failed at01:06:44.

The earlier dashboard reading was13% weekly at~00:16. It remains a historical observation. This new response establishes that Grok Build cannot currently serve the assigned work; it does **not** establish a new weekly percentage or reset time. No inference from dollar totals was used, and no billing setting was changed.

At01:07:58 Astra was88% weekly (stop95%). Claude general remains last observed46% (stop60%); Fable74% is a separate forbidden bucket. No Opus or Fable work was added during this continuation.

## Delivered work

`be35afc80d2d3cdcbb5b7e6105530512fb90921d`, delivery `delivery-506d2043-5b40-491e-aeda-442efabe8bcf`, settled00:53:20: four scoped source-sweep documents, isolated full tests/build passed, no push/release. All279 matrix rows now reference source inspection. Zero product claims have been accepted or reopened from this sweep.

Previously delivered F1 source fix remains `cacfc742cd2aaec5f6543a8166860d1741a4ef36`. Runtime/restart acceptance remains pending. Main-checkout build passed during this continuation, but no Electron smoke ran; no fresh smoke grant was issued. The September21 slot file remains stale. Final process check found no Electron and the original llama-server PID31984.

## Unfinished work and recovery

1. F1: independent fixture author produced an83-line scaffold, syntax checked only. Its direct entrypoint throws. Controller rejected report shapes (`data.test: true`, escalation without `occurred:true`), future timestamps, and insufficient database-path containment. The required marker/readback corrections and runtime integration were dispatched but not completed before the402. The report's phrase about the resumed job stopping/replanning is wrong: acceptance requires **completed**, a late elapsed-reset note, and a fresh stub request. Replan persistence still requires a separate restart scenario with exactly one replan. Full paged events and early/middle/late report records remain required.
2. Exact rejected scaffold is preserved as `f1-seed-scaffold.txt`, SHA256 `d40556da3defa315706350667f641f1ec7a8b6730ae259af1c2fd0365519c997`. The same untracked `scripts/smoke-durable-history.mjs` remains in the working tree for recovery; it is not shipped as an executable smoke. Do not run it as acceptance.
3. G8: native model/effort changes separately failed ACP config validation (`SessionConfigOptionValue`). High-to-medium submit, resume, and fresh Grok Fast dispatch failed. No production source was changed. Installed-CLI schema investigation did not establish an accepted wire shape before402. Do not guess a fix from the mocked test, which currently asserts the rejected shape.
4. F2: local navigation map was rejected for wrong settled phases/release wording and repeated size edits. Controller stopped/released the worker and replaced the report with source-checked navigation. This is not a local implementation success. Gate repair, F3 watchdog, and F4 newest detail tail remain queued.

All active coworker relationships were released; final agents.list showed only the controller running. Failed/superseded conversations must not be automatically resumed. Current blocked orchestration tasks are `task_muetwrbr_cri6oxh` (F1 acceptance) and `task_muetwpvo_2jgow24` (G8).

The standing brief's real-stop condition applies: Grok, the owner-required implementer, is unavailable. The local model did not reliably complete even the bounded source map without controller correction; assigning critical persistence/restart or native protocol repairs to it now would be an unjustified escalation of responsibility. Astra remains controller-only; Opus remains a sparse reviewer. Resume when Grok access is restored, or when the owner explicitly authorizes a different implementer. No extra purchase or alternative cloud spend was initiated.

Machine-local detailed snapshots: `artifacts/autopilot/stop-agent_muerh0kt_k3ncw1b.json`, `stop-agent_muerw1fu_a33x86v.json`, `g8-worker-failure.json`, `f1-runtime-recovery-snapshot.json`, `source-sweep-delivery.json`, and `f1-acceptance-main-build.txt`. These contain no required credential for continuation; use the fresh controller's own credential.
