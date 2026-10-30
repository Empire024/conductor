# Codex provider-clock tool timings (P3 increment)

Cloud-session delivery, 2026-10-30. Branch `claude/t3code-provider-clock-timings-4xstsl`.

The base is the initial tool-timing source `2205f97` (implementation `ecf5b27`). This change does
not include the owner's later local commits (`7dcd17d`, `7d99da3`, `216cae9`, `ddf4eb7`). It is
one increment, to be applied by hand from
`docs/perf-evidence/t3code-provider-clock-timings-integration.patch`.

## Scope

**What this adds:**
- Codex provider-clock elapsed time for live structured tool items.
- Codex automatic approval-review time (the guardian), kept apart from human approval wait.
- The report fields and UI labels for both.

**Still open (not covered):**
- Raw CLI-view tabs.
- Conversations mirrored from another machine.
- Cloud-coworker transcripts.
- Claude and Grok are unchanged: neither sends provider lifecycle stamps on its live stream.

This is not an all-provider timing claim.

## Source evidence (the repository's generated Codex schema)

| Frame | Field | Schema text |
|---|---|---|
| `item/started` (`v2/ItemStartedNotification.ts`) | `startedAtMs: number` | "Unix timestamp (in milliseconds) when this item lifecycle started." |
| `item/completed` (`v2/ItemCompletedNotification.ts`) | `completedAtMs: number` | "Unix timestamp (in milliseconds) when this item lifecycle completed." |
| `item/autoApprovalReview/completed` (`v2/ItemGuardianApprovalReviewCompletedNotification.ts`) | `startedAtMs`, `completedAtMs`, `reviewId`, `targetItemId: string \| null` | "[UNSTABLE] Temporary notification payload … expected to change soon"; `targetItemId` is null for network-policy reviews; one command can have several (execve) reviews. |
| `item/commandExecution/requestApproval` | `startedAtMs` | Not used. Human approval wait stays measured by the host, because subtracting a provider start from a host answer would mix two clocks. |

Before this change, `CodexAdapter` (`src/main/providers/codex.ts`) dropped every `*AtMs` field.
The auto-review notifications went to `unknown()` and only produced a notice.

Each stamp only ever covers its own frame:
- `startedAtMs` exists only on `item/started`, and `completedAtMs` only on `item/completed`.
- An item seen only through `item/completed`, or through a `turn/completed` snapshot, therefore
  has no provider start. Its elapsed time stays `unavailable`, as before.
- The synthetic fixtures (`scripts/fixtures/codex-app-server.mjs`) and older servers send no
  item stamps. The behaviour for them is unchanged.

## Semantics

**Adapter (`codex.ts`)**
- `notification` forwards `params.startedAtMs` on `item/started` and `params.completedAtMs` on
  `item/completed` as `providerStartedAtMs` / `providerCompletedAtMs` on that item's tool event.
  - Only finite numbers are forwarded (`finiteMs`). Anything else is not a stamp.
  - Neither stamp is ever derived from the other.
- `item/autoApprovalReview/completed` is checked by `reviewInterval`. It must have:
  - a `reviewId` string of 1–256 characters;
  - a `targetItemId` string of 1–256 characters;
  - finite stamps with 0 ≤ start ≤ end and end − start ≤ 7 days.
- A null target (a network review), a reshaped payload or a bad interval attributes nothing to
  any tool.
- Valid intervals are kept in `reviews`: target item key → `reviewId` → interval.
  - A repeated `reviewId` replaces its own interval, so duplicates count once.
  - A completion that arrives before its `started` notification needs nothing from it.
  - At most 16 reviews per item and 512 items are kept; the oldest item goes first.
  - A review of an item that has already completed is not kept.
- When the item completes, the union of its intervals (`unionMs`, overlaps counted once, all on
  one provider clock) rides that terminal event as `providerReviewMs`, and the entry is deleted.
- The existing `Codex event: …` notice is still emitted, so the timeline is unchanged.

**Recorder (`src/main/tool-timings.ts`)**
- Each open call keeps the first `providerStartedAtMs` it sees and the latest
  `providerReviewMs`.
- **On the terminal event** (`finish`), `providerInterval(start, completedAtMs)`:
  - is null when either stamp is missing, and the existing host elapsed (`host-monotonic`, or
    `unavailable`) stays;
  - when the stamps are negative, reversed or more than 7 days apart, notes
    `invalid-provider-interval` and keeps the host elapsed;
  - otherwise sets `elapsedMs = end − start` with `elapsedSource: 'provider'`.
  - This is item **lifecycle** time on the provider's clock, not execution. Execution stays the
    provider `durationMs` or the host `running` phase, as before.
- `reviewMs` / `reviewSource: 'provider-review'` holds a valid review time. An invalid one is
  noted `invalid-provider-review` and not stored. **`waitMs` stays host-observed human approval
  wait and is never summed with review time.**
- **Amending an abandoned call:** an abandoned call that ends later in the same process uses the
  provider start it kept (`abandonedProviderStart`, a WeakMap). Across a restart that start is
  gone, so the earlier wall-clock fallback applies.
- **Duplicates:** restated terminal frames (a repeated `item/completed`, `turn/completed`
  snapshots) are dropped exactly as before. Their stamps never replace the first statement.
- **Persistence:** `parseRecord` accepts an optional `reviewMs` only when it is a finite number
  ≥ 0 and comes with `reviewSource: 'provider-review'`. Older lines without it still parse.
  Bounded tail reads, the claimed exit journal, compaction, masking and output exclusion are
  untouched.

**Report and UI (`src/shared/tool-timings.ts`, `ToolTimings.tsx`)**
- `ElapsedSource` gains `'provider'`. Records gain the optional `reviewMs` / `reviewSource`.
- `ToolAggregate.review` statistics.
- `coverage.review`, plus `ProviderCoverage.elapsedFromProvider` and `.review`.
- The Codex gap text now describes all of this.
- In the UI, slowest calls show `elapsed · provider`. An "Auto-review" column appears only when
  some review was measured. The coverage line names the provider auto-review share,
  "shown apart from approval wait".

## Tests

The new test file `src/main/providers/codex-provider-clock.test.ts` drives the real
`CodexAdapter` on an in-memory App Server wire, with `emit` feeding `ToolTimingRecorder.observe`.
It covers:

1. start 1000 / end 4000 delivered 10 ms apart on the host: elapsed 3000 from `provider`,
   execution 2900 from `provider`;
2. no stamps, or only an end stamp: host-monotonic elapsed unchanged, no notes;
3. a completion-only frame: elapsed `unavailable`, `startedAt` null;
4. starts and ends restated, plus a `turn/completed` snapshot: one call, the first start
   stands, `restated: 2`, aggregate total 3000;
5. reversed, negative, more-than-7-days and string stamps: host elapsed kept, invalid intervals
   noted, strings ignored;
6. a human approval request (with its own `startedAtMs`) and a review: `waitMs` 8000 from
   `observed-approval`, and `reviewMs` 500 from `provider-review`, reported in separate columns;
7. duplicate, reordered and overlapping reviews ([1000,3000] ∪ [2000,4000] ∪ [10000,10500]):
   3500, and the per-item map is emptied;
8. a null target, a reversed or negative interval, an empty `reviewId`, another item, and a
   review after completion: nothing is attributed, and only the other pending item stays held;
9. bounds: 20 reviews on one item count only 16; 600 reviewed items hold 512;
10. secrets: the summary is masked, a failure keeps only its masked, bounded first error line,
    and no output body appears anywhere in the report.

Added to `src/main/tool-timings.test.ts`:
- an abandoned call amended on the provider clock, with review;
- an invalid review rejected, with wait unchanged;
- provider elapsed and review persisted across a restart, and a malformed `reviewMs` or
  `reviewSource` refused on load.

**Failure-first.** Against the base `ecf5b27` code, 11 of these 13 tests fail. The 2 that pass
there are the "no stamps" and "completion-only" guards, which by design must not change.

Results in this Linux container:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx electron-vite build` | built |
| `vitest run src/main/providers/codex-provider-clock.test.ts src/main/tool-timings.test.ts src/shared/tool-timings.test.ts` | 48/48 passed |
| `vitest run src/main/providers/ src/shared/` | 509 passed, 3 failed, 2 files fail to load. Unmodified base: 499 passed, the same 3 failures (Windows `icacls` sandbox-ACL tests) and the same 2 files (`claude.test.ts` and `claude-ui-fixture.test.ts` need the Electron binary). |
| `src/main/tool-timings.pipeline.test.ts` | Not run: it needs the Electron binary. |
| Full `npx vitest run` | 5,660 passed, 16 failed, 78 skipped. 32 files fail to load: they need the Electron binary or the native `node-pty` build, which `--ignore-scripts` did not fetch. I reran the failing files on the unmodified base `2205f97`: the same 15 failures (host-dependent: where.exe, icacls, IPv6 relay, Python/pip path policy, process-kill timing, and the approval/wizard listings built on them) and the same 32 load failures. The one extra failure, `local-models.test.ts` "still finds a port when the whole neighbouring range is unavailable", is outside this change and passed 3 of 3 runs on its own. This is not a full-green run. |

Dependencies were restored with `npm ci --ignore-scripts`, so the Electron binary was not
downloaded. The parked smoke `smoke-tool-timings` was therefore not run here. Its scenario
(`synthetic:activity-groups`) sends only `item/completed` frames without stamps, so its
assertions are unaffected by design. This is not a Windows acceptance run.

## Hunks the integration must keep (later local fixes)

The owner's checkout already has three later fixes that touch the same files. Apply this
increment's hunks around them; do not drop them:

- **`native.method === 'cli/history'` exclusion** in `ToolTimingRecorder.observe` (and the
  `Observed` Pick that includes `native`). This increment does not touch `observe` or `Observed`.
- **Sticky `inputComplete`**: it closes the initial prepare phase, and prepare never reopens
  after approval. It lives in `OpenCall`, `start()` and `closePhase`. This increment adds two
  fields to `OpenCall` and to `start()`'s object literal (`providerStartedAtMs`, `reviewMs`), and
  two lines in `observeTool` after `if (data.detached)`. Merge them beside the local fields; the
  phase logic is untouched.
- **Top-level Claude hook `input.duration_ms`** propagated in `claude.ts` `hook()`. This
  increment does not touch `claude.ts`.

Another shared hunk: the tool variant of `AgentEventData` in `src/shared/structured-agent.ts`
gains three optional fields. If the local tree added fields there too, keep both.

## Limitations

- The auto-review payload is marked UNSTABLE. Field checks keep a reshaped payload from
  attributing time, but a renamed field would silently mean no review time.
- A review that completes after its item completed is not counted.
- An `execve` review that names no target cannot be attributed.
- Provider elapsed is lifecycle time. Whether the lifecycle includes time spent awaiting approval
  depends on when Codex emits `item/started`; it is never labelled execution.
- After a restart, an abandoned call's provider start is not persisted, so its later end falls
  back to wall-clock time.
- fileChange and webSearch still report no `durationMs`. When stamps arrive, their elapsed time
  becomes provider lifecycle time.

## Effort

One bounded cloud session, about 2 hours: roughly 120 lines of source, 300 lines of tests and
this note.
