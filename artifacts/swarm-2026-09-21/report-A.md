Implementation and measurements are ready; **parked smoke remains pending**.

- Admission guard preserves/reuses the running 9B and refuses 35B startup. Live preflight confirmed unchanged PID and healthy server.
- **52 tests passed; typecheck passed.**
- Read and edit/read-back passed in ~1.5 seconds each.
- Long-output fixture exhausted four rounds after prefix truncation dropped its tail.
- Alternating conversations reused **1,935/1,958** and **1,917/1,939** prompt tokens.

[Findings and recommendations](C:/Claude/conductor/artifacts/swarm-2026-09-21/local/findings.md) · [Raw measurements](C:/Claude/conductor/artifacts/swarm-2026-09-21/local/measurements.json)

Controller: provide a fresh build and exact smoke grant for `agent_mublk3kd_71cymvo`, `scripts/smoke-local-admission.mjs`, including generation. The binding rules prohibit using the stale grant currently assigned elsewhere. Task remains in progress; no commits or pushes made.