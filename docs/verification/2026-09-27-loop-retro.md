# Continuing the Claude verification loop with Codex

## Recovered state

At takeover on 2026-09-27, HEAD was `c1018c4`. The installed app reported
`0.1.54-local.1790403604250`, built from `5652a7e`. The final Claude controller
(`agent_mui13hp9_1yful7n`) failed on its first turn with the weekly-limit message.
Its FX45 worker (`agent_mui12k6u_hamrsg3`) completed ten read-only tools and made
no edits before the same limit. The predecessor's six-section handoff and
`docs/swarm-2026-09-24.md` agree: finish FX45, verify independently, publish once,
then execute the quiet-machine overnight queue. The new anonymous-control UI
request was added after that handoff and is included in this continuation.

Live `usage.limits` reported Claude's general weekly bucket at 100%, resetting
2026-09-28 09:00 UTC, and Codex at 0% at takeover. The Fable-specific bucket is
not spare general Claude allowance. The existing batch policy already names
Astra as the continuation when Claude is capped; its implement step lacked
that machine-readable alternate. The verify execute/judge steps likewise
named only Claude. The owner corrected the initial all-Astra dispatch: use cheaper
workforce for churn. This continuation keeps Astra for contracts, hard diagnosis
and independent judgment, with Sol for implementation follow-through and test
execution. Implementation and verification remain independent, with unchanged gates.

## Evidence of avoidable reading

The two takeover snapshots serialized to 45,149 and 119,806 characters. Their
user/assistant text was 6,350 and 4,047 characters respectively. The larger
snapshot also held ten tool calls needed for provenance, but the controller
needed their names, arguments and status, not every repeated result or provider
configuration notice. These counts are payload measurements, not billed tokens.
The first takeover calls printed too much of these snapshots; the corrected
approach filters before returning tool output to the model.

The seven-day local-assist counter at takeover showed 14 calls, 9 model-assisted,
111,881 raw characters, 16,776 returned characters and an estimated 23,956
frontier tokens saved. This is the app's estimate, not a paired cost experiment.
It shows the facility worked but was used infrequently across a multi-day swarm.

The earlier retrospective (`2026-09-25-verifier-retro.md`) already demonstrated
the expensive failures: repeated smoke scaffolding, oversized scenario lists,
lock contention and unbounded teardown. Keep its v3 fixes. Do not restart that
experiment or weaken the independent verifier to reduce tokens.

## Changes to the operating loop

- Refresh models and provider-scoped quota once before dispatch. Use the exact
  available route consistently for implementation and independent verification;
  a capped provider is not retried in another tab. No automatic downgrade of
  review quality, no cloud-credit spending merely because the native quota ended.
- Use `agents.status` with its cursor for supervision. Fetch one filtered snapshot
  only for a state transition, missing result or recovery. Keep full artifacts on
  disk; read the final answer and relevant tool arguments before requesting outputs.
  Filter `tasks.list`/`tasks.update` responses to revision and affected task IDs.
- Use `run_and_summarize` for long test/build output and `local_ask` for bounded
  large-file reading when the existing local server is available. Do not start or
  switch a model just for summaries while a real-model scenario owns the GPU.
- Give the Electron slot to one worker at a time. Other workers may read and edit;
  they do not queue redundant builds or smoke instances. Share a build only when
  its source revision and tested paths are known. Full suite/build belongs to
  `git.ship`; rerun focused checks only after relevant changes or a concrete failure.
- Keep briefs below 1,200 tokens where practical: task, exact owned paths, evidence
  references, acceptance, delivery. Link the shared rules rather than copying
  the full historical log. Reports contain commit, verdict, evidence and NOT RUN.
- Record `loops.run`/`loops.record` for new work. Use measured token counters only;
  omit unavailable fields rather than estimating them as measurements. Compare
  accepted equivalent work including retries and review before claiming savings.

The token benefit of these new rules is a hypothesis until comparable completed
runs exist. Test, independent verification, ship, budget caps and overnight load
requirements remain mandatory. The six-hour soak and typing measurements remain
open until the original acceptance criteria have actual evidence.
