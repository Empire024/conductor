# CLI-view capture: read stability (increment on t3code-cli-capture-safety)

Scope: `src/main/native-history.ts` and one new test file, `src/main/native-history-read-stability.test.ts`.
No existing test, no `tool-timings`, pairer or shared type was touched; the existing `CliCaptureReason` values are reused.

## Identities

- Base (verified, `git rev-parse HEAD` before any change, branch `claude/t3code-cli-capture-safety-ylyp4p`): `8f07d556928d8513415eaf9211d8a64fd35d5a05`
- Implementation commit: `26646225ec7c4fd4a4e3724c2ae27a96f2aa2346` (branch `claude/t3code-cli-read-stability-6gc97q`)
- Export: `docs/perf-evidence/t3code-cli-read-stability-integration.patch`, `git diff --binary 8f07d55..2664622 -- <the two files>`, SHA-256 `0e7764c8cebef0798b8053babc5b95867604ea11fca7780734d9567c47497c7f`. Checked: applies with `git apply --check` to a clean worktree of the base, and the result is byte-identical to the implementation's `native-history.ts`.
- The commit that adds this note and the patch is the branch head; its SHA is in the hand-off message (a commit cannot name itself).

## The defect

`captureClaudeCliToolCalls` said it verified the boundary "on one open handle (so nothing can change between the check and the read)". An open handle locks nothing: another writer can truncate or rewrite the same inode after the fingerprints were checked. `readCliWindow` also treated `bytesRead === 0` before the requested length as the end of the data, parsed whatever it had, and the capture reported `complete`. A last row cut off mid-write failed `JSON.parse` and was skipped silently, also under `complete`.

## What changed

The capture takes a stamp of the handle (size, device and inode, `mtimeNs`, `ctimeNs`) and compares it again after the fingerprint reads and after the window read. All reads are bounded: the two 4 KiB boundary fingerprints, one window of at most `maxBytes`, and, only when rows were appended, four more 4 KiB windows.

| What happened during the capture | Result |
| --- | --- |
| a read returns 0 bytes before the size it was told (short read, truncation) | `unavailable`, `file-shrank`, no tools |
| fingerprint read short, or file smaller before/after any stage | `unavailable`, `file-shrank` |
| file changed in any way while the fingerprints were read (including growth) | `unavailable`, `file-changed` (or `file-shrank` / `file-replaced`) |
| same size, newer modification or change time after the window read (rewrite in place, truncate then refill to the same length) | `unavailable`, `file-changed` |
| handle reports another device/inode, or the path now names another file or no file | `unavailable`, `file-replaced` |
| **only grew** after the window read | explicit bounded snapshot: the calls up to the size first seen are kept if the boundary's two ends and the window's two ends still equal the verified/read bytes, status `partial`, reason `file-changed`, `fileBytes` the newer size, so the appended rows are visibly unread. They are not consumed: the next capture with the same boundary reads them once (checked in the test). Growth plus a changed end, or a shrink after the growth was seen, is `unavailable`. |
| last row without a newline that does not parse | not used, `bytesRead` excludes it, status `partial`, reason `file-changed`; a last row that parses as a whole row is used |

`file-changed` takes precedence over `window-truncated` as the single reason; `bytesSkipped` still shows a truncation. `file-changed` also covers a transcript that simply ends mid-row (no writer need be active). A newline-terminated malformed row, a foreign `sessionId`, a `remoteSourced` row and a result whose call is unread remain skipped exactly as before: they produce no duration and are counted only as unmatched calls / unpaired results.

`captureClaudeCliToolCalls` gained an optional fifth parameter, `fs: CaptureFs` (open and path stat), default the real file system. It exists so a test can wrap real async handles; production callers are unchanged. `readClaudeCliToolCalls` (the trusted-offset reader) treats a short read as `shrank: true`.

Preserved: no row text in a boundary or coverage (asserted), at most `maxBytes` read for rows and never the handoff prefix (asserted via the recorded read requests), exact conversation/origin filtering and `known` de-duplication, and no file opened for a missing, malformed or legacy size-only boundary (asserted).

## Tests: `native-history-read-stability.test.ts` (17)

Real files in a temp directory with wrapped async handles: a write, truncation, rename or short read lands at a chosen read or fstat of the (sequential, so deterministic) capture. Covered: unchanged control; reads served in 7-byte pieces; truncation after boundary verification; EOF before the size with no writer; truncate-then-refill to the same size; in-place rewrite during the window read; growth, in-place rewrite and truncation during the fingerprint reads; truncation inside the boundary between stat and fingerprint; another inode, rename-over and delete; append kept as a snapshot and re-read once later; append plus a rewritten boundary-head / boundary-tail / window-start / window-end; truncation after an append was seen; trailing cut-off row, trailing whole row, malformed/foreign rows; `maxBytes` bound; legacy boundaries.

### Failing before

The same test file was run against the base `native-history.ts` with only the injection seam added (`fs` parameter used for `open`, nothing else changed): 11 of 17 fail, 6 pass (the controls and the behaviours that must not change). Examples of the base behaviour:

- truncation after verification: `status: 'complete', reason: 'complete', bytesRead: 40` for a 493-byte window (expected `unavailable / file-shrank`).
- truncate and refill to the same size with different bytes: returns `toolu_cli` with `resultAt` 10:02:39 (the forged 99 s duration) instead of nothing.
- cut-off last row, append during read, rewritten ends, rename-over, delete, another inode: all reported `complete` or imported tools.

### What was and was not run

- Run: the 17 tests, all passing, and the base comparison above. **vitest is not installed in this container and no dependency download was allowed**, so they ran on a ~60-line stand-in for the vitest API (`describe/it/expect/afterEach/vi.stubEnv`) over the compiled TypeScript, on Linux/ext4-class semantics. This is not a vitest run.
- Run: `tsc` strict (`strict`, `noUncheckedIndexedAccess`) over `native-history.ts`, the new test and a stub of the vitest declarations, with `@types/node` found on the machine: no errors. The repository's `npm run typecheck`, `npm run build`, the full vitest suite (including `cli-capture-safety.test.ts`, `cli-transcript-timings.test.ts`, `structured-sessions.test.ts`) and `npm run test:scripts` were **not run**. The existing capture tests were read for fixtures that would now differ (every appended row ends in a newline, none changes during a capture); none does.
- **Full Windows acceptance is unrun.** Electron was not launched and no CLI or model was used.

## Residual limits (unchanged in kind, documented in the code)

- Only the first and last 4 KiB of the boundary prefix and of the read window are compared. A rewrite that keeps the size, both ends and the file identity, and also leaves `mtime` and `ctime` as they were (a timestamp granularity too coarse to tell two writes apart, or timestamps deliberately set back), is not seen. On Windows the change time and the file index come from the platform and were not exercised here.
- A rewrite strictly between the fingerprinted ends of the boundary prefix that happened before the capture started is not seen (the existing `cli-capture-safety` limit test still describes it).
- Growth together with a rewrite of only the middle of the window is not seen either: after growth only the window's two ends are compared again.
- A snapshot is not retried: rows appended during a capture are reported unread and are picked up by a later capture with the same boundary, not by this one.
