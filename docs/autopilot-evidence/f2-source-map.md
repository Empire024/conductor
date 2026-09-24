# F2 source map

Controller-checked navigation only; runtime not run. Paths below are under `src/main/durable-jobs/`.

- `server-lifecycle.ts:253`: `LocalGenerationGate.acquire` queues behind a holder and polls interactive work. It returns an idempotent release callback at269; acquisition does not immediately release. `handOff` at272 clears the holder and resolves the next waiter.
- `wiring.ts:277`: `gatedRuntime` acquires before submit and records the prior stop sequence. `observe` releases only for a settled phase with an advanced stop sequence, or `missing` (298). Interrupt releases in `finally`; dispose releases all held entries.
- `wiring.ts:268`: settled phases are `completed`, `failed`, `interrupted`, `disconnected`, `missing`. Approval/question waits are absent.
- `wiring.ts:168`: two matching failed permission-refusal tool calls produce an approval verdict at172.
- `controller.ts:192`: `block` transitions to blocked, releases the durable job lease, and stops the run. `conclude` handles `needs-owner` at348 and an approval loop verdict at417. Releasing the durable lease is distinct from releasing the generation gate.
- `server-lifecycle.test.ts:137`: assertions cover waiting for interactive work, a queued second job waiting for the first release, and holder cleanup.
- `wiring.test.ts:149`: assertions cover holding the gate, interactive demand, and release on completed observation. They do not prove release/reacquisition across approval waits.

The local draft misstated settled phases, release timing, and line references, then repeatedly edited toward a size cap. Its queued correction had not run when the controller interrupted and released it. Rejected draft retained in `artifacts/autopilot/f2-source-map-rejected.md`; this short replacement was checked directly against source. No unassisted local factual success claimed.
