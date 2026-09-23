# Local tools: final integration API

Owner: agent_mueas8r7_vvgqvun. No live probes; synthetic tests only. Root owns final integrated acceptance and report.

## Context and source protection

Pass `ToolContext.taskId` and `analysis: {taskId}` for processing tasks. Tools derive `.conductor-scratch/<workspace/task hash>`; optional `analysisScratch` overrides the trusted relative directory. Exported `analysisScratchPath(workspace, taskId)` returns the derived path. File writes are confined canonically to scratch. Root should ignore `.conductor-scratch/` in git and source-change reports (outside this worker's file ownership).

`DockerSandbox.setAnalysisMode(true)` remains supported. Before execution, tools call `setAnalysisAccess(scratchRelative)`: source and .git are read-only, one task scratch bind is writable. Main write/edit tools preserve prior scratch revisions in durable artifacts and report their handles. Saved scripts and generated result files are accessible through ordinary file tools. Inline analysis code is saved as a unique script in scratch. Read-only conversation permissions still independently prohibit execution.

## Durable result store

Optional `ToolContext.artifacts: LocalResultStore`; no artifactRoot field. Import from result-artifacts.ts. Constructor `new LocalResultStore(directory?)` defaults to existing `runDir()/result-artifacts`, outside git. `save(owner,text)` returns a handle; `read(owner,id,byteOffset?,byteLimit?)` returns a bounded page. Tools construct owner as workspace plus NUL plus analysis.taskId/taskId, falling back to sandbox session name for legacy callers.

Disk names contain owner SHA256 plus UUID; handles recover after restart with the same project/task identity. Limits: 32 MiB per owner, 256 MiB global, 2048 entries; oldest-first eviction. Captured outputs, inline script bytes and previous scratch revisions persist. Tests inject temporary storage. No private artifact data belongs in fixtures or git.

## Structured evidence

`ToolOutcome.evidence?: LocalFileEvidence` is independent of stdout shaping. Type exported from bounded-files.ts:

- source `{path,sizeBytes,mtimeMs,sha256?,stable}`
- coordinates `{byteStart,byteEnd,endExclusive:true,firstLine?,lastLine?}`
- mode, encoding?, bom?, lineEndings? `{lf,crlf,loneCr}`
- rawSample, escapedSample, hexSample (512 source bytes max), truncated

Complete stable inspection/line scans include SHA256. Byte pages report size/mtime identity without claiming a whole-file hash.

## Model-facing tools and bounds

`read_file({path?,mode?:'lines'|'inspect'|'bytes',offset?,limit?,byte_offset?,byte_limit?,artifact?})`. Line positions are 1-based, byte ranges 0-based/end-exclusive. Lines retain at most 64 KiB; byte pages 16 KiB. Inspection streams up to 256 MiB and explicitly marks hash/total-line count unavailable above that cap. Byte reads address the entire file. Giant lines return continuation byte coordinates.

Search accepts a file or directory, files through 8 MiB, 200 hits, 2000 scanned files, 10000 directory entries. Partial coverage, skipped reasons and follow-up guidance are explicit. Existing secret and canonical confinement stays in force.

Regex search additionally skips lines above 16 KiB (reports line numbers and byte/script follow-up), interrupts the fixed-code VM regex scan after 25 ms per file, and stops traversal after a 1500 ms budget. Pathological backtracking cannot monopolize the main thread indefinitely; timed-out file coverage is explicitly unknown.

`run_command({command?|code?|script?,runtime?:'python3'|'python'|'node'|'bash',args?:string[],cwd?,timeout_sec?})`. Exactly one command form. Execution only through Docker with existing grants; no host fallback. Runtime evidence comes from actual container command lookup/version and cwd. Inline code cap 12 KiB; larger programs use a saved script. Capture limit 8 MiB combined stdout/stderr; overflow terminates execution and marks retained output partial. Results carry exit/timeout/cancel/duration evidence plus durable retrieval handles. Shaping preserves execution metadata and artifact handles.

Environment discovery is separated from payload on both streams using a host-random marker emitted before user code. Only the first marker is consumed; marker-like payload text remains payload. Results preserve exact payload whitespace, explicit `payload_started`, `stdout_empty`, and `stderr_empty` fields, plus a separate bounded `[environment: ...]` record. Missing boundaries mean unknown emptiness and a failed tool result, not fabricated user output. All these metadata records survive shaping. Synthetic tests include empty stdout/stderr, actual `ACTUAL_PAYLOAD_7319` bytes and a repeated delimiter in payload. Root performs actual Docker/provider probes; this worker launches no live probes or delivery builds during that evaluation.

## Validation status

Focused synthetic tests cover exact line1223 above 1 MiB, giant lines, SHA256/BOM/newlines/encoding, file search and honest coverage, confinement, stale edits/external changes, structured execution, scratch-only writes, previous revisions, store recreation/ownership/quota, and termination/output shaping. Root reported the failed bare docker lookup reflects sandbox/approval limitations; it is not evidence that Docker is absent. No live Docker execution attempted. Integrated typecheck must pass before shipping the seven owned files.
