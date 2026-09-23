# Local file execution: implementation and measured limits

Owner task: `local-file-processing-e2e`, 23 September 2026. This extends the existing
`LocalAdapter` / `LocalAgentSession`; it adds no second agent platform or cloud fallback.
The renderer remains a view of a registered main-process conversation. Moving or rebuilding
that view does not submit another user turn.

## Confirmed diagnosis

- `read_file` rejected a file above 256 KiB before applying the requested line range.
  Search enumerated its target as a directory, causing `ENOTDIR` on an authorized file;
  large files were silently skipped. These were tool defects.
- A submission stopped at 24 tool rounds even with context remaining. The old compact state
  lived only in the adapter and carried model-written conclusions without typed source identity.
  There was no cumulative task continuation or file-processing completion gate.
- Shaped output had no durable omitted-section retrieval. The incident export alone did
  **not** prove empty stdout or broken transport. Inspection of all 7,733 original stored
  events found 73 stdout-bearing tool results, two 949,469-byte read rejections, two `ENOTDIR`
  failures, and four 24/24 stops. The largest excluded-output count was 278,013 characters.
- Actual live probes exposed two more defects: `command` could silently ignore `args`/a
  non-shell `runtime`, and the initial processing gate could count a header as a target.
  Both now fail before a misleading success; regression tests cover them.
- Ornith also made reasoning/tool-selection mistakes: malformed nested plans, changing parser
  assumptions, guessing date semantics, reading a nonexistent artifact, and replacing useful
  processing with diagnostic scripts. Tool repairs alone did not eliminate these failures.

The original statement is **not available for private replay**. Its current authorized
attachment mapping contains a 91-byte file, not the incident's 949,469-byte bank statement.
The separate target file was available, but cannot reconstruct the missing bank bytes.
No real payment result, verified target count, or successful real-statement replay is claimed.
Private source bytes and event dumps stay in ignored local artifacts, never committed fixtures.

## Behavior and boundaries

`read_file` supports inspect, line ranges and byte pages on large files. Inspection records
SHA-256 when the complete stable scan fits the cap, size, BOM/UTF-8 validity, line endings,
escaped and hexadecimal samples, source coordinates and continuation. A giant line cannot
force its full contents into a prompt. File and directory search share canonical confinement,
explicit skipped/partial coverage and bounded regular-expression execution.

`run_command` accepts exactly one shell command, saved script or inline program. Structured
scripts use an explicit runtime, arguments and cwd. Shell/runtime mixtures are rejected with
a usable correction rather than reinterpreted. Execution stays in the existing non-root,
network-disabled Docker sandbox with unchanged grants. Environment discovery is separate
from payload stdout/stderr. Exit status, timeout, cancellation, true emptiness and truncation
remain visible after shaping. Large captured output has private project/task-owned handles;
`read_file({artifact,byte_offset,byte_limit})` retrieves a bounded section after restart.

Named-file lookup/reconciliation requests select a small local processing recipe. Both inputs
are inspected independently. For recognized headers, `process_files({target,source})` derives
the observed schema, parses all bytes, checks source witnesses and produces the result in
deterministic local code. Explicit schemas support other fixed records. A recognized profile
must be tried before replacement scripts; a rejected interpretation leaves script tools usable
for diagnosis. Sources are mounted read-only for these tasks, with one task-owned scratch
subtree writable. Generated probes do not overwrite source inputs; earlier scratch versions
have retrieval handles, and stale edits return the current version/context.

The processing path preserves exact signed minor units, currency, direction, raw identifiers,
separate invoice/bank dates and byte-span lineage with full input fingerprints. It checks every
target exactly once, source identity, zero/rejected parses, coverage gaps, independent raw
amount/date witnesses, reused transactions and ambiguous candidates. It does not require
invoice-date equality or select a nearest-date candidate as certain. Missing optional reference
evidence retains candidates rather than proving absence. The runtime renders the validated
outcomes; free prose or exit zero cannot satisfy the processing gate.

Checkpoints use the existing local database, scoped by project and registered conversation.
Versioned state retains objective/corrections, inputs, script versions, tool observations and
raw samples, invalidated hypotheses, failures, validation counts/artifacts and cumulative
budgets. Checkpoints precede execution/compaction/continuation. Pending uncertain execution
after a crash blocks replay; repeated provider mutation IDs cannot execute twice. A lost
renderer connection neither resets budgets nor submits work. Process restart restores state
but requires explicit input to resume safely. Cancelled or permission-blocked work is not
automatically resumed.

The default 24-round reasoning segment is separate from total limits: 72 tool rounds,
96 requests, three recoveries, 20 minutes and one million reported tokens. Continuation
requires evidence progress, with one bounded opportunity to act on a new error hint.
Checkpoint/retry failures consume the same task budget. Exhaustion produces a deterministic
report of retained facts, artifacts and the blocker even when final model generation fails.

## Supported interpretation limits

The automatic profile recognizes explicit English/Czech headers, tab/pipe/semicolon/unquoted
comma delimiters and one-to-eight-line fixed records with labeled continuation fields.
It is deliberately not a universal bank parser. Unknown headings, variable-length record
layouts, uncertain encodings, allocation/combined payments and unsupported semantics may
end with a truthful blocker. Sandbox scripts remain available for investigation, but arbitrary
script JSON is not automatically trusted as a validated reconciliation. A structural validator
cannot prove arbitrary prose or an unknown schema semantically correct.

The principal fixture is about 1 MiB, UTF-8 BOM/CRLF, Czech money/directions and multiline
records. Its four independent expected outcomes are two matches, one two-candidate ambiguity,
and one covered absence. The 85,000 CZK target's 15 April invoice date matches a 23 April bank
record through amount/direction/reference/account evidence; a misleading 15 April same-amount
record has incompatible account evidence. Repeated amounts, opposite directions and reference
lookalikes remain distinct. The held-out fixture changes delimiter, column order, record
framing and newline style. Inventory uses the same processing path with SKU/warehouse criteria.
Only ordinary requests and input files enter the model workspace, never the independent oracle.

## Actual model and server

- Model ID `local/ornith1.5-9b`, `Ornith-1.5-9B-Q4_K_M.gguf`, 5,780,090,816 bytes;
  SHA-256 `70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6`;
  repository revision `abdd624b12ebf020b767fff532ff44fe552b28c3`.
- Existing authenticated endpoint `http://127.0.0.1:51435`, llama.cpp `b10901-28ff09582`,
  one slot, effective context 32,768. The advertised training context 262,144 is not the
  server capacity. Configured GPU layers 999. No server/model was downloaded or switched
  for this evaluation.
- Actual requests use temperature 0.3, tool-round output reserve 2,560, final reserve 1,536,
  no custom stop strings, and the existing `reasoning_effort: none` option. `/props` says
  this template does not support reasoning effort; that parameter is not evidence of a
  particular thinking mode. Default server sampling: top-k 40, top-p .95, min-p .05,
  random seed. The Qwen-style XML function/parameter template was inspected, and actual
  OpenAI-format tool calls/results crossed the adapter successfully.
- Docker image `conductor-local-sandbox:1`, Python 3.11.2 observed in the execution probe,
  four CPUs, 4 GiB memory and 256 PIDs. Runtime/output discovery was measured inside Linux;
  the authorized Windows workspace was mounted at `/workspace`.
- The final serialized request is measured using authenticated `/apply-template` and
  `/tokenize` when supported, including schema/framing. Unsupported endpoints fall back
  to a labeled conservative estimate. Tables below use server-reported usage, not estimates.

## Evaluation record

The frozen old adapter's simple probe took 12.756 s / 9 calls / 8 rounds and returned the
contradictory date text “23.04.2026 (15 April 2026)”. The full principal baseline took
42.675 s / 17 calls / 16 rounds, 87,830 input and 3,496 output tokens, with no validated
artifact. Baselines have no independent structured score and are not counted as passes.

Intermediate builds were measured rather than discarded: two parser-churn runs hit the
180-second external test bound; an early successful principal run took 22.278 s, but the
next fresh run failed after 169.065 s. The first profile batch passed 3/5 file tasks, the
short-path batch 4/5 (inventory header bug), and the next two batches each 4/5 (one-round
segment failures). These are development results, not the final implementation's success
rate. Raw traces remain local under `artifacts/local-files/`.

The final `scoped-tools` batch passed **4/5 sessions (80%)**: two ordinary principal runs,
the held-out layout and inventory. The deliberately one-round principal stress run failed
honestly after two automatic recoveries. Thus principal success including that stress is
**2/3**, not 100%. All successful payment runs returned both justified matches, both candidates
for the ambiguous target, and the covered absence; false matches and manual interventions
were zero. Every successful task retained one intentionally ambiguous item.

| Session | Outcome | Wall seconds | Model calls / tools / rounds | Recoveries / compactions | Input / output tokens | Peak input |
|---|---|---:|---|---|---|---:|
| Principal 1 | correct | 6.889 | 3 / 4 / 3 | 0 / 0 | 12,311 / 443 | 5,560 |
| Principal 2 | correct | 6.236 | 2 / 3 / 2 | 0 / 0 | 6,749 / 416 | 5,081 |
| Principal, segment 1 | blocked | 7.244 | 3 / 4 / 3 | 2 / 1 | 10,993 / 438 | 5,273 |
| Held-out layout | correct | 4.854 | 2 / 3 / 2 | 0 / 0 | 6,837 / 267 | 5,174 |
| Inventory | correct | 6.242 | 3 / 4 / 3 | 0 / 0 | 7,726 / 468 | 3,291 |

Wall times and token counts are measured; peak input is the maximum server-reported input
usage, not a claim about GPU allocation. Reported usage includes cached input. Tool-error
corrections within a segment are visible in events but do not increment the continuation counter.
The principal source has 8,654 scanned units, 8,513 parsed records, 141 explicitly skipped
headers and zero rejections; these are distinct from physical lines and matched targets.

The one-round failure retained raw evidence but Ornith invented an invalid artifact handle
after a malformed plan. A prior development build completed the same stress with two
compactions; that isolated success did not generalize. Another bounded two-round probe on
the preceding build failed after 19.486 s / 6 calls / 6 rounds / 2 recoveries / 2 compactions.
The harness now stops these attempts without false payment conclusions, but reliable Ornith
reasoning through arbitrarily frequent compaction remains **unproven**. The default segment
is 24 rounds. Deterministic integration tests independently verify continuation, retained
corrections/raw evidence, cumulative budgets and no duplicate side effects; they do not
replace the real-model failure result.

The parked normal-UI smoke also passed on the final runtime: one ordinary composer submission,
renderer reload during inference, same registered task, four correct outcomes, no false match,
and no human continuation. Total smoke wall time 9.136 s; task 7.574 s; 3 model calls,
4 tool calls, 3 rounds, 12,541 input / 493 output tokens, peak input 5,696, no compaction.
This gives **3/3 ordinary principal sessions**, or **5/6 final file sessions including the
deliberately one-round stress failure**, with three principal successes out of four if that
stress is included. The UI screenshot and snapshot are in
`artifacts/local-files/ui-1790192067787/`; the smoke is reproducible using newly generated inputs.

The real saved-script transport probe (`release-candidate-markers`) passed all six wire checks:
head/tail stdout, distinctive stderr, retrieved middle, genuinely empty second output, durable
handle and accurate exit/timeout/cancellation metadata. Ornith recovered from two invalid
shell/runtime requests without intervention. 9.737 s, 5 model calls, 6 tool calls, 4 tool
rounds, 15,254 input / 668 output tokens, peak reported input 4,754; no compaction. The
earlier marker run failed and led to the ambiguous execution-form repair.

## Reproduce and inspect

With the existing Ornith server ready and idle, and the existing Docker image installed:

```powershell
node node_modules/esbuild/bin/esbuild scripts/evaluate-local-files.ts --bundle --platform=node --format=esm --outfile=artifacts/local-files/evaluate.mjs
node artifacts/local-files/evaluate.mjs --acceptance-batch --label=my-check --markers --docker=C:/Users/stilj/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe
npm.cmd run build
node scripts/smoke-local-files.mjs --inputs=artifacts/local-files/my-check-1/workspace --docker=C:/Users/stilj/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe
```

Supply the actual Docker executable path on another installation. The runner preflights the
configured endpoint/slot and refuses a busy model; it does not start a second server. Runs
are serial with a 180-second per-session test bound. Each label saves settings, serialized
provider requests, events, checkpoint and an independent summary in ignored artifacts.
Use a new label to preserve earlier evidence. The smoke launches a parked test window,
uses the ordinary composer and reloads the renderer during inference.

Focused deterministic tests are `file-processing.test.ts`, `processing-workflow.test.ts`,
`bounded-tools.test.ts`, `recovery.test.ts`, `context-management.test.ts`, provider context
tests and session checkpoint tests. They cover exact line 1223 above the old limit, giant
lines, bytes/encoding/newlines, safe path mapping, quotas/ownership, stale edits, ambiguous
arguments, malformed calls, zero/partial/wrong-source parsing, cancellation, pairing,
cumulative budgets, corrections, no repeated side effect and server token measurement.

Final targeted command:

```powershell
npx.cmd vitest run src/main/local-models src/main/providers/local.test.ts src/main/providers/local-context.test.ts src/main/structured-sessions-local-checkpoint.test.ts
```

Result: **298/298 tests, 22/22 files passed** on the host. The restricted-shell attempt
passed 293 and failed five because it could not create D-drive temporary roots or inspect
the test process; the same command passed with approved host access. `npm.cmd run build`
(including `tsc --noEmit`) passed. Delivery additionally uses `git.ship` for the full
repository test/script suite and production build; its exact log/commit are in Source control.

Use the installed app's local **Update pending** / **Restart to update** flow after delivery.
Then select Ornith in a normal project conversation and ask the ordinary task with file names.
Tool details show source coordinates, counts and output handles; the stop card and
`agents.status` expose recovery/context/budget information and actual blockers. No cloud
fallback is enabled. Passing these supported fixtures does not establish general 9B reliability.
