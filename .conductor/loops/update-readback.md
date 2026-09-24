---
id: update-readback
version: 1
title: Build the local update, read it back, install it, verify it
trigger: [after:batch-delivery]
inputs: [batchIds, focusedTests]
steps:
  - id: authorize
    role: controller
    action: app.update.authorize   # for the Qwen tab; lapses when the wizard tab closes
  - id: build
    role: churn
    model: local:qwen3.6-35b-a3b
    output: last line `UPDATE OK <version>` or `UPDATE FAILED <stage>` + ≤20 lines
  - id: install
    role: controller
    action: app.update.install({force:true})   # wizard tab only
  - id: verify
    role: churn
    model: local:qwen3.6-35b-a3b
    output: last line `VERIFIED <version>` or `REGRESSION <test> <first failure>`
locked: [steps.install]
---

# Update and read back

1. The wizard calls `app.update.authorize` for the Qwen tab.
2. Qwen calls `app.update`, then polls `app.update.status` about once a minute until it is no longer running.
   On failure it reads the full build log and extracts the first error with file:line and the failing stage
   (tsc, electron-vite, electron-builder, signing). It reports in the fixed last-line format.
3. A zero-token shell watcher on Qwen's `agents.status` wakes the parent only on `UPDATE FAILED` or when the turn
   ends without a report. On `UPDATE OK`, the wizard runs `app.update.check`, `app.update.download` and
   `app.update.install({force:true})`.
4. After the restart, the wizard sends Qwen "verify". Qwen checks that the running version matches the build and
   runs `focusedTests` in its sandbox, then reports `VERIFIED` or `REGRESSION`. A regression goes to the batch's
   implementer with Qwen's summary only.

## Run log

- 2026-09-24 (pre-loop, by the wizard directly): the 818c29b update was built, downloaded and force-installed from a
  wizard Opus 5.5 tab without a dialog; the tab was brought back after the restart.
