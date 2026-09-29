# Auto model upgrade

Owner, 2026-09-30: *"should've happened automatically and required like 1 OK from me and I shouldn't even have thought about it.. whenever a better model arrives, that's when"*. The trigger was GPT-6.1 Sol. It appeared in the Codex catalog only for Codex CLI 0.159.1, because OpenAI filters the catalog by client version, while 0.155.1 was installed. A bare CLI upgrade would also have cut every Codex tab, because Conductor pins the Codex protocol minor (`docs/codex-compatibility.md`).

Conductor now notices a better model on its own, prepares everything the switch needs, and asks the owner once.

## Pipeline

Code: `src/main/model-upgrades/` (`service.ts` state machine, `better.ts` ranking, `cli-source.ts` npm, scratch installs and catalog probes, `app-wiring.ts` wiring to the app). Shared types are in `src/shared/model-upgrades.ts`.

1. **Watch** runs about 2 minutes after startup, then every 6 hours. It uses no GPU and no model turn.
   - For each native CLI it reads the `latest` dist-tag of its npm package (`@openai/codex`, `@anthropic-ai/claude-code`). That is one small GET; `CONDUCTOR_NPM_REGISTRY` overrides the registry.
   - It re-reads the current CLI's catalog, so a model that appears without a new CLI is noticed too. The previous catalog is kept per CLI version in `userData/model-upgrades/state.json`.
   - The installed CLIs on this machine may come from the standalone installers. npm is only where Conductor learns that a version exists and where it fetches a copy to probe.
2. **Probe** runs when npm has a newer version than the CLI new tabs launch.
   - `npm install --prefix userData/model-upgrades/cli/<provider>/<version>` installs it into a scratch prefix, never globally. The install is staged and moved into place only once its executable reports the expected version. A failed install leaves nothing behind.
   - The catalog comes from the latest-models `cli-catalogs.mjs` probe: Codex `initialize` + `model/list`, Claude `initialize`, never a turn. It runs with a scratch `CODEX_HOME` / `CLAUDE_CONFIG_DIR` that holds only a copy of the sign-in file (`auth.json`, `.credentials.json`). The owner's config, history and MCP servers are not read.
   - The probed catalog is diffed against the current one (`betterModels`). A model is better than one of the owner's picks when:
     - the catalog names it the pick's `upgrade`;
     - the pick is now described as a previous generation;
     - it is the same tier at a higher version (Opus 5.5 → 5.6);
     - it is a new major generation that ranks as high;
     - or the catalog made it the default in the pick's place, and it either ranks at least as high or is a later version of the same series.
   - The picks are: the promoted model (see below), the current catalog default, Conductor's fallback model, and every wizard-eligible model in the catalog.
   - Better models are recorded in the model registry (`model-intelligence` `recordObservations`, availability `limited`). The linked pass adds price and context where OpenRouter knows them.
   - A newer CLI that offers nothing better is remembered and not installed again.
3. **Prepare** needs no owner input.
   - If this Conductor already connects to the new CLI (`conductorSupports`: the Codex verified-runtime minors, `claudeCompatibility`), the offer is `ready` at once.
   - Otherwise it needs a protocol bump. The service dispatches **one Opus fixer coworker** with `router.dispatch` in the Conductor project, using an owner scope. Its brief (`fixerBrief`) is the documented rebaseline:
     - regenerate from the scratch CLI;
     - move the gates and fixtures;
     - run the contract tests;
     - `git.ship` a local commit;
     - build `app.update({commit, smoke:["smoke-model-upgrades"]})` until verified.
   - The fixer then reports `models.upgrades.prepared({id, commit})`. The service accepts that only if `app.update.status` shows a verified build of that commit.
   - If the fixer cannot make the bump safely, it reverts and reports `blocked`. A fixer that closes without either, or preparing that takes more than 24 h, also ends in `blocked` with the reason. With no Conductor checkout open, preparing is `blocked` at once. `models.upgrades.retry` starts over.
4. **One OK**: a non-modal card at the bottom right, for example *"GPT-6.1-Sol is available (better than GPT-6-Astra: the catalog now makes it the default instead of GPT-6-Astra). Needs Codex 0.159.1 (now 0.155.1). Switch?"*, with **OK, switch** / **No, keep GPT-6-Astra** / Not now (×).
   - OK installs the verified Conductor build first if one is needed: `app.update.check` / `download` / `app.update.install`. The install waits and retries every minute while any tab works. The rest of the switch finishes on the new build after the restart. If that build still cannot run the CLI, the offer is `blocked` and nothing is switched.
   - The CLI: the scratch copy is saved into Conductor's CLI store and pinned (`CliVersionStore.adopt`, pin marked `model-upgrade`). New tabs launch it; open tabs keep their process. The owner's global CLI is not touched, following FX20: Conductor never installs or changes the owner's CLIs. The machine's CLIs are standalone installs, not npm ones. Rollback is **Use installed CLIs**. Once the owner's own CLI reaches the pinned version, the pin is released automatically.
   - The catalog is re-discovered at once from the CLI new tabs now launch (a short-lived app-server `model/list` or Claude `initialize`). `models.list`, `router.dispatch` and `tabs.open` take the catalog of the **newest runtime**: an open tab or that probe, whichever reports the higher CLI version. A tab still on the pre-upgrade CLI therefore no longer hides the new model. This was a real failure after the manual Codex 0.159.1 upgrade.
   - The model becomes the pick wherever the old one was: the setting `model-upgrades:promoted`, read through `src/shared/promoted-models.ts`. Three places honour it:
     - `concreteModel` makes it the default when nothing explicit is chosen and the runtime offers it;
     - `capabilityRank` gives it the replaced model's rank, which drives routing;
     - `isFrontierModel` keeps wizard eligibility when the replaced model had it.
   - No hard-coded regex edit is needed for the next model.
   - **No** is remembered per model (`declined`), across restarts.
   - A wizard tab may answer the OK only if the owner opted in, with the card's switch or `models.upgrades.configure({wizardMayAccept:true})` from the owner credential. The default is to ask the owner.

## App control

| Method | Who | What |
| --- | --- | --- |
| `models.upgrades.status()` | anyone | Each CLI (installed, what new tabs launch, latest, last check, error), every offer (state `preparing` / `blocked` / `ready` / `applying` / `applied` / `declined`, reasons, CLI, protocol bump, candidate, fixer, steps, reason), the declined models, and the wizard opt-in. |
| `models.upgrades.check()` | anyone | One pass now; returns the status. |
| `models.upgrades.prepared({id, commit? \| blocked?})` | the fixer | A verified commit, or why not. |
| `models.upgrades.accept({id})` | owner credential; wizard only if opted in | The one OK. |
| `models.upgrades.decline({id})`, `models.upgrades.retry({id})` | owner or wizard | Decline an offer, or prepare a blocked one again. |
| `models.upgrades.configure({wizardMayAccept})` | owner credential only | The wizard opt-in. |

## Tests

- Unit: `src/main/model-upgrades/*.test.ts` covers the ranking, the state machine with fake ports, and the real npm/probe path. That path uses a fake registry (a local HTTP server), `scripts/fixtures/fake-npm.mjs` and `scripts/fixtures/fake-upgrade-cli.mjs`. `src/shared/promoted-models.test.ts` covers the hooks.
- Parked smoke: `node scripts/smoke-lock.mjs -- node scripts/smoke-model-upgrades.mjs` (after a build). It runs the whole pipeline in the real app with the fake registry, npm and CLIs:
  - a ready Codex offer and a blocked Claude protocol bump;
  - the card and its OK: pin and promotion;
  - a remembered decline;
  - npm only ever with `--prefix` in the profile.
- Test-profile switches:
  - `CONDUCTOR_NPM_REGISTRY` enables the watch in a test profile, which is otherwise off;
  - `CONDUCTOR_MODEL_UPGRADE_NPM` sets the npm to use;
  - `CONDUCTOR_MODEL_UPGRADE_FIXER=off` turns off fixer dispatch.

## Limits

- The fixer's own work is only as good as the rebaseline brief. A protocol change that needs judgement comes back `blocked`, not guessed.
- A package that ships no native executable (JavaScript entry only) cannot be pinned. The offer is not created and the watch shows the install error.
- On macOS the Claude sign-in lives in the Keychain. A scratch config dir there may probe an unauthenticated catalog.
- Tabs that explicitly chose the old model keep it; only the defaults and picks move.
