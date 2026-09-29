# Local update invitations

`app.update({commit, smoke, offer:true})` requests an owner invitation after verification. Without `offer`, the build stays in Settings → Updates. Its builder may later call `app.update.offer({})`; a wizard may offer it too. Offering an unverified build is refused. Builds of the dirty checkout are never considered verified.

The offer is recorded by version in `conductor-local-offer.json`, separate from the immutable package descriptor. A newer build cannot inherit an older build's verification or offer. Missing metadata keeps older local builds quiet. GitHub releases keep their existing automatic update prompts.

Local banners and prompts require verification, an explicit offer, and no live turn or background work in any project. The main process uses the same inventory as `app.update.install`, ignoring a dead runtime's stale background count. Settings shows why a local build is quiet. The gate refreshes once a second, so an offered build surfaces when work settles.

The owner's Restart to update action checks the inventory again in the main process, including after renderer flushing. If work started, the update stays ready and the UI offers **Install when idle**. That choice queues only the downloaded version and rechecks the inventory at idle. A superseding build cancels the queue. Agent/wizard forced restarts retain their existing explicit authority.

Validation: `src/main/local-update-offer.test.ts`, `src/main/update-manager.test.ts`, and `src/renderer/src/use-app-updates.test.ts`; parked integration smoke `scripts/smoke-update-prompt-safe.mjs` under `scripts/smoke-lock.mjs`. The smoke uses synthetic artifacts and a fake CLI with live background work. It starts another fake turn after the renderer precheck to exercise the production IPC click-time guard. No installer executes.
