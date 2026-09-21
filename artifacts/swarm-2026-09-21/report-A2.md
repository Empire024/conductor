A2 is complete and marked done; ready for controller integration.

- Long-output fixture now passes: **4→2 requests, 4→1 tool rounds, 7.626→3.740 seconds**, within the same bound.
- Full prompt tokens fell **41,011→13,279**. Read/edit fixtures still pass.
- **76 tests passed; typecheck passed.**
- All 16 prompt/schema variants remain byte-identical. A/B cache reuse remains intact.
- Sampling unchanged. Final budget validation is an estimate, not exact tokenization.

Changed client, loop/provider tests, local provider, measurement harness, new context-budget files, and the permitted small agent/tools hunks. Existing protected changes were preserved.

[Full file list, measurements and limitations](C:/Claude/conductor/artifacts/swarm-2026-09-21/local/findings-a2.md). No commits, pushes or builds.