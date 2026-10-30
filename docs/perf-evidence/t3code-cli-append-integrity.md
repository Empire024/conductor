# CLI-view capture: append integrity (increment on t3code-cli-read-stability)

Scope: `src/main/native-history.ts`, the new `src/main/native-history-append-integrity.test.ts`, this note and the patch. The earlier `native-history-read-stability.test.ts`, every earlier export, `tool-timings`, the pairer and the shared types are untouched; the existing `CliCaptureReason` values are reused.

## Identities

- Base (verified): `47240b32534edb650bf27f3647c500b913a1bb25` (the read-stability export).
- Implementation commit: `071a3d1774feed0c9510ad0d71f2148215eeb5d3` on `claude/t3code-cli-append-integrity-7k2m9q`.
- Export: `docs/perf-evidence/t3code-cli-append-integrity-integration.patch` = `git diff --binary 47240b3..071a3d1 -- src/main/native-history.ts src/main/native-history-append-integrity.test.ts`, SHA-256 `7b032a186e9cc6fa2f1cfe9de417324122024813bec361ce547211117f39554b`. `git apply --check` passes on a clean worktree of the base and the result is byte-identical to both files at the implementation commit.
- The final export commit (this note plus the patch) is the head of both `claude/t3code-cli-append-integrity-7k2m9q` and the fast-forwarded `claude/t3code-cli-read-stability-6gc97q`; a commit cannot name itself, so its SHA is in the hand-off message.

## The hole

When a transcript grew while it was captured, the snapshot was kept after re-reading only the boundary's two ends and the window's first and last 4 KiB. A same-length rewrite strictly inside the window (a result timestamp, say) with both ends unchanged passed that check, so rows the file no longer held were kept as a `partial` snapshot (observed on the base: the pre-rewrite `toolu_middle` 2.000 s duration is imported although the file says otherwise).

## What changed

- On growth, **every byte of the already-read window** (at most `MAX_CLI_TIMING_BYTES`, 16 MiB) is re-read once and compared with the bytes read: the two 4 KiB ends first, then the middle in pieces of at most 64 KiB, so one extra piece is held beside the window, never a second copy. The boundary's two fingerprinted ends are re-hashed as before. The boundary's prefix between them is never re-read.
- The file must **not move again while that check runs**: the stamp (size, identity, mtime, ctime) taken after the window read is compared with one taken after the check. Any further growth, shrink, replacement or rewrite is `unavailable` (`file-changed`, `file-shrank` or `file-replaced`). One pass, no retry, one open.
- A genuine unchanged append is still kept: the exact calls of the quiet capture, status `partial`, reason `file-changed`, `fileBytes` the newer size; the appended rows are not consumed.
- `maxBytes` is clamped to `MAX_CLI_TIMING_BYTES` (a caller asking for more could previously size the window, and now the re-read, beyond the bound).
- Unchanged: the no-growth path (stamps only, no second read, so a quiet capture reads exactly two fingerprints plus the window), partial-tail handling, path/inode checks, `known` de-duplication, provenance filtering (other session, `remoteSourced`, teleport note) and the refusal of legacy size-only or malformed boundaries before any file is opened.

## Tests: `native-history-append-integrity.test.ts` (15)

Real temp files, wrapped async handles, mutations at a chosen read of the sequential capture. Window over 8 KiB (about 27 KiB; the rewritten timestamps lie more than 4 KiB from both ends of the window, asserted).

- Rewritten result time in the middle plus an append, ends unchanged: `unavailable`, no tools. Also the use time of the middle call and the result times of the first and last call.
- Unchanged append: tools equal to the quiet capture's, `partial`, exact coverage numbers, and a later capture reads the appended call once; also a window only just over one fingerprint window with two appends.
- Mutation during the re-verification (appended after the boundary re-hash; appended after the middle was compared; a compared region rewritten in place; truncated into the window): each `unavailable` (`file-changed` / `file-shrank`), one open, reads bounded to the first pass plus one verification pass.
- Byte accounting on a 200 KB window: window read once, the verification reads are exactly 4 x 4096 plus 64 KiB-bounded middle pieces, sum `2 * 4096 + window`, every middle read inside the window, no read of the handoff prefix.
- `maxBytes: 2**40` over a 17 MiB window: reads at most 16 MiB, `partial` / `window-truncated`, and an unchanged file is not re-read.
- Same-size rewrite of a row inside the window, no growth, ends unchanged, during or before the window read: `unavailable` / `file-changed`.
- Provenance and dedup inside a kept snapshot: other session, copied row and `known` call stay out; exact times kept. Legacy size-only and malformed boundaries open nothing.
- Two tests that document limits (below), asserting the limit, not hiding it.

### Failing before

The same file run against the base `native-history.ts` (`47240b3`, which already has the injection seam): **8 of 15 fail, 7 pass.** The failures are the two middle-rewrite-with-append tests (the stale snapshot with the old durations is returned as `partial`), the byte-accounting test, the `maxBytes` clamp test (base: `complete`, `bytesRead` 17,827,561, over the 16 MiB bound) and the four re-verification-mutation tests. The passes are the controls, provenance/legacy, the no-growth rewrite (already rejected by the previous work) and the two limit tests.

### What was and was not run

- Run: the 15 new tests and the unchanged 17 of the previous export, 32 of 32 passing, plus the base comparison above. **vitest is still not installed in this container and no dependency download was allowed**, so they ran on the same small stand-in for the vitest API over the compiled TypeScript (Linux). Not a vitest run. The owner's real Windows Vitest run of the previous 17 is reported by the controller, not by me.
- Run: strict `tsc` (`strict`, `noUncheckedIndexedAccess`) over the source, both test files and a vitest declaration stub: no errors.
- **Not run:** `npm run typecheck`, `npm run build`, the full vitest suite, `test:scripts`, and full Windows acceptance. The 15 tests use only in-place writes, truncation, appends and `utimes` (no rename), but their behaviour on Windows is unobserved. Electron was not launched; no CLI, model or inference was used.

## Residual limits (honest)

- **Growth hides a rewrite made before or while the window is read.** The times move for the append as well, so such a rewrite cannot be told from the append; it is part of what is read (documented by a test) and the comparison afterwards matches the file. Only a rewrite made after the window was read, or during the re-read, is seen.
- Without growth the check is stamp-based: a rewrite keeping size, identity and both times (a clock too coarse to tell two writes apart, or times set back) is not seen (documented by a test).
- The boundary prefix is fingerprinted at its two ends only; a rewrite of its middle before the capture is not seen.
- A live CLI that keeps appending across the whole re-verification makes the capture `unavailable` rather than looping; a later return reads the same boundary.
- A re-read that agrees with the first read proves the bytes were stable between the two reads, not that they were never different before the first.
