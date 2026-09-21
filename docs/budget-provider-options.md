# Budget frontier-level providers for Conductor

Researched 2026-09-21. The budget is **20 US dollars a month or less**. Nothing here was bought,
signed up for, or configured; every snippet is a proposal.

Read with `docs/local-model-shortlist.md` (what MAIN can host itself) and
`docs/agent-runtime-options.md` (what would drive these endpoints).

## The question that decides everything

Two of these offerings sell a *subscription that only works inside named coding tools*, and the
rest sell *API credit*. That distinction matters more than the price, because Conductor has
three integration paths and they need different things:

| Conductor path | Needs | Works with a tools-only subscription? |
| --- | --- | --- |
| Local adapter pointed at a remote endpoint | An OpenAI-compatible `/v1/chat/completions` URL and a key usable from arbitrary software | **No.** Conductor is not on anyone's supported-tools list. |
| Claude Code harness pointed at an Anthropic-compatible endpoint | `ANTHROPIC_BASE_URL` + a token, per process | **Yes** — Claude Code is on every supported-tools list here. |
| A new structured provider | Whatever that provider's CLI needs | Depends on the CLI. |

So: a $18 GLM Coding Plan is usable through Conductor's *Claude* adapter and not through its
*local* adapter, and the terms say so explicitly. That is the central finding of this document.

## Screening

| Offering | Entry price | API entitlement | Verdict |
| --- | --- | --- | --- |
| **Z.ai GLM Coding Plan** | "Starting at just 18 USD per month" | **Plan only, no general API.** "API calls outside the plan are not available." | **Deep dive.** Cheapest route to a current frontier open-weights model inside Claude Code. |
| **Moonshot / Kimi** | Pay-as-you-go; rate-limit tiers keyed to cumulative top-up ($10 → Tier1, $20 → Tier2). Kimi memberships from ¥49/month. | **Yes**, full API, plus an Anthropic-compatible endpoint. | **Deep dive.** The only ≤$20 option that satisfies *all three* Conductor paths. |
| **DeepSeek** | Pay-as-you-go, no subscription. | **Yes**, full API, OpenAI- and Anthropic-compatible. | **Deep dive.** By far the cheapest per token, with the heaviest data-boundary cost. |
| Alibaba Cloud Model Studio Coding Plan | **$50/month** (Pro). Lite withdrawn for new subscriptions 2026-03-20, renewals ended 2026-04-13. | Plan is "for interactive use in programming tools" only; the terms forbid using its key for "automated scripts, application backends, or other non-interactive scenarios". | Rejected: 2.5x over budget, and the cheap tier no longer exists. |
| MiniMax Token Plan | **$22/month** (Plus), then $55 and $132. | Included across the MiniMax lineup. | Rejected: $2 over the stated budget. Earlier reporting of $10/$20/$50 tiers is stale; the platform's own page now lists $22/$55/$132. Revisit if the budget moves. |
| Anthropic / OpenAI first-party | Above budget for a second subscription; the owner already holds both. | — | Out of scope: this document is about *adding* cheap capacity, not replacing what works. |

---

## 1. Z.ai — GLM Coding Plan

**Pricing.** `docs.z.ai/devpack/overview` (read 2026-09-21) states "Starting at just 18 USD per
month, with Pro and Max plans" for the three tiers Lite / Pro / Max. **The exact Pro and Max
prices and any annual or introductory rate could not be confirmed from a primary source**: the
`z.ai/pricing` and `z.ai/subscribe` pages render their tables in JavaScript and serve no numbers
to a fetch. Third-party blogs disagree with each other ($10/$30/$80 vs $18/$72/$160), so none of
them is quoted here. **Verify at checkout before subscribing**, specifically whether the first
month is discounted against the recurring rate — several of those blogs claim a standing 30%
introductory discount, which would mean the recurring price is higher than the advertised one.
The FAQ does say subscriptions are **non-refundable** once purchased.

**Quota.** Credits, not tokens (`docs.z.ai/devpack/overview`):

| Tier | Credits per 5 hours | Credits per week |
| --- | --- | --- |
| Lite | 2,000 | 10,000 |
| Pro | 12,000 | 60,000 |
| Max | 28,000 | 140,000 |

What a credit converts to in tokens is **not documented**. The weekly quota "starts counting from
the time you place your order and refreshes on a 7-day cycle". No concurrency figure is published.

**Models.** "All plans support GLM-5.3, GLM-5.3-Flash. Requests for GLM-5.2/GLM-5.1 will be
automatically routed to GLM-5.3, requests for GLM-4.7 will automatically be routed to
GLM-5.3-Flash." So a plan subscriber cannot pin an older model — Z.ai reroutes it.

**API shape and harnesses.** Anthropic-compatible at `https://api.z.ai/api/anthropic`. Supported
tools, from `docs.z.ai/devpack/quick-start`: **Claude Code, Roo Code, Kilo Code, Cline, OpenCode,
OpenClaw, Crush, Goose, Cursor**. Conductor is not among them, and the FAQ is unambiguous: "The
GLM Coding Plan is strictly limited to use within officially supported tools… API calls outside
the plan are not available."

**Caching.** Not documented for the plan. The separate pay-as-you-go API does price cached input
at roughly a fifth of fresh input (below), which implies a prefix cache exists.

**Data handling and jurisdiction.** The API data-processing addendum names **JINGSHENG HENGXING
TECHNOLOGY PTE. LTD** — a Singapore entity — as processor, with the customer as controller. The
privacy policy keeps personal data "as long as it is needed to provide services", with periods
varying by "volume, type, and sensitivity". It does not publish a no-training-on-API-input
commitment of the kind Anthropic and OpenAI offer for business tiers. Treat every prompt sent
there as leaving the owner's control.

**Availability.** A card and a Z.ai account. Not verified for this owner; no purchase was made.

**Pay-as-you-go alternative, with real API access** (`docs.z.ai/guides/overview/pricing`,
per million tokens):

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| GLM-5.3 | $1.40 | $0.26 | $4.40 |
| GLM-5.3-Flash | $0.15 | $0.03 | $0.50 |
| GLM-4.7-FlashX | $0.07 | $0.01 | $0.40 |

This is the route to take if Conductor's *local* adapter is ever pointed at Z.ai — it is a normal
API key with normal terms, not the coding plan.

---

## 2. Moonshot / Kimi — the only option that fits all three paths

**API pricing** (`platform.kimi.ai/docs/pricing/chat`, read 2026-09-21, per million tokens):

| Model | Context | Input (cache hit) | Input (cache miss) | Output | Cache write |
| --- | --- | --- | --- | --- | --- |
| `kimi-k3` | 1,048,576 | $0.30 | $3.00 | $15.00 | $3.00 (5 min TTL) / $6.00 (1 h TTL) |
| `kimi-k2.7-code` | 262,144 | $0.19 | $0.95 | $4.00 | not separately billed |
| `kimi-k2.7-code-highspeed` | 262,144 | $0.38 | $1.90 | $8.00 | — |
| `kimi-k2.6` | 262,144 | $0.16 | $0.95 | $4.00 | — |

Kimi is the only one of the three with an **explicit 1-hour cache TTL option**. For Conductor
that is worth more than a headline price: `docs/context-accounting.md` records a mean of 160,000
context tokens over 192 calls per session, which is a workload that lives or dies on prefix-cache
hits. A 5-minute TTL expires between an owner's messages; a 1-hour TTL does not.

**Concurrency and rate limits** (`platform.kimi.ai/docs/pricing/limits`), keyed to cumulative
account top-up, not a subscription:

| Tier | Concurrency | RPM | TPM |
| --- | --- | --- | --- |
| Tier0 ($1) | 1 | 3 | 500,000 |
| Tier1 ($10) | 15 | 100 | 2,000,000 |
| **Tier2 ($20)** | **40** | 100 | 3,000,000 |

$20 of credit — inside the budget, and it does not expire monthly — buys 40 concurrent requests.
That is more parallel coworkers than MAIN can host locally, and it is the only concurrency figure
any of these three vendors publishes.

**API shape.** Both. OpenAI-compatible at `https://api.moonshot.ai/v1`, and Anthropic-compatible
at `https://api.moonshot.ai/anthropic`. Kimi Code subscribers get a third at
`https://api.kimi.com/coding/` (Anthropic protocol).

**Subscription alternative.** Kimi memberships (Andante ¥49/month through Allegro ¥699/month on
the legacy ladder; Plus and above on the new one) include Kimi Code, whose usage is "included in
your subscription fee with no extra payment required". Credits refresh on a 7-day cycle inside a
5-hour rolling rate-limit window. Kimi's own billing examples: "a simple request… costs about
¥0.03; a complex multi-step task… costs about ¥1.6". The ¥49 entry tier is roughly $7 at
current rates — comfortably inside budget — but **the USD price and the per-tier credit
allowances are not published on a page that serves static content**, so the tier ladder was not
confirmed. As of 2026-08-20 kimi.com carried a banner that membership plans are being
restructured and Kimi and Kimi Code benefits separated. Check the checkout page.

**Data handling and jurisdiction.** Not verified from a primary source for this task. Moonshot AI
is a PRC company; assume PRC data handling unless the international platform's terms say
otherwise, and verify before sending anything the owner would not publish.

---

## 3. DeepSeek — cheapest per token, heaviest data cost

**Pricing** (`api-docs.deepseek.com/quick_start/pricing`, read 2026-09-21, per million tokens).
DeepSeek prices by clock: "off-peak rates are half of the peak rates", with peak hours
"01:00 – 04:00 and 06:00 – 10:00 UTC, Monday through Friday, excluding Chinese public holidays".

| Model | Context | Cache hit (off/peak) | Cache miss (off/peak) | Output (off/peak) |
| --- | --- | --- | --- | --- |
| `deepseek-flash` (V4.1-Flash) | 1,000,000 | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 |
| `deepseek-v4-pro` (V4-Pro-0813) | not stated | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

A cache hit on `deepseek-flash` costs **three tenths of a cent per million tokens**. That is two
orders of magnitude below every other option here.

**API shape.** Both. OpenAI-compatible at `https://api.deepseek.com`, Anthropic-compatible at
`https://api.deepseek.com/anthropic` with a documented alias map: Claude Opus model names resolve
to `deepseek-v4-pro`, Haiku and Sonnet names to `deepseek-flash`, and any unrecognised Claude name
falls back to `deepseek-flash`. There is no subscription to violate — it is ordinary API credit,
so all three Conductor paths are permitted.

**Data handling and jurisdiction — the reason this is third, not first.** DeepSeek's privacy
policy states: "we directly collect, process and store your Personal Data in People's Republic of
China." The open-platform terms state that they "shall be governed by the laws of the People's
Republic of China", with disputes heard where DeepSeek is registered. Data is retained "for as
long as necessary to provide our Services", and inputs are used "to train and improve our
technology, such as our machine learning models" — there is an opt-out, but it is opt-*out*, and
it was not exercised or verified here. For a repository the owner ships to the public that may be
acceptable; for anything with credentials, customer data or unpublished work it is not.

**Availability.** Open self-service signup, no subscription commitment. Not verified for this
owner.

---

## What a Conductor session would actually cost

Anchored on the measured workload in `docs/context-accounting.md`: a mean of **160,000 context
tokens per call** over a mean of **192 calls per session**, i.e. 30.72 M input-token reads, plus
an assumed 1,500 output tokens per reply (0.288 M). The real cost sits between the two columns
depending on how much of that context is a cache hit; a long Conductor session is heavily
prefix-cached, so the left column is the realistic end and the right column is the disaster case
where caching does not engage.

| Model | Session, all cached | Session, no cache | Note |
| --- | --- | --- | --- |
| DeepSeek `deepseek-flash` (off-peak) | **$0.26** | $4.78 | |
| DeepSeek `deepseek-flash` (peak) | $0.53 | $9.56 | |
| Z.ai GLM-5.3-Flash (API) | $1.07 | $4.75 | |
| DeepSeek `deepseek-v4-pro` (off-peak) | $1.25 | $20.85 | |
| Kimi `kimi-k2.6` | $6.07 | $30.34 | |
| Kimi `kimi-k2.7-code` | $6.99 | $30.34 | 1 h cache TTL available |
| Z.ai GLM-5.3 (API) | $9.25 | $44.28 | |
| Kimi `kimi-k3` | $13.54 | $96.48 | plus cache-write billing |

Two things fall out of this table:

1. **The spread between the columns is 10x to 20x, larger than the spread between vendors.**
   Whatever Conductor does about caching is worth more than which of these providers it picks.
   That is an argument for the fresh-tab and context-budget work in this swarm, not against it.
2. **A $20 GLM Coding Plan is not obviously cheaper than pay-as-you-go**, because its quota is
   denominated in undocumented credits. It is worth it if the owner wants a *fixed* bill and
   Claude Code is the harness; it is worse than DeepSeek credit if the owner wants the lowest
   marginal cost.

Cost per *accepted* task is higher than any of these numbers, because a weaker model retries.
None of these vendors publishes an accepted-task figure and this task measured none. Budget at
least a factor of two on top for a model below the owner's current frontier tier, and verify with
the bounded local-acceptance fixtures rather than with benchmark scores.

## Benchmarks

Deliberately none. Every "frontier-level" score reachable for GLM-5.3, Kimi K3 and DeepSeek V4 in
this research came from vendor marketing pages or SEO aggregators that did not state the harness,
scaffold, context window or sampling settings, and one identical checkpoint
(Qwen3.6-35B-A3B) was reported at both 64.40 and 73.4 on SWE-bench Verified by two different
cards — a 9-point swing from harness alone. Quoting an unconditioned number here would be worse
than quoting nothing. The model cards cited in `docs/local-model-shortlist.md` are included
precisely because they *do* state their conditions.

---

## Integration design, per Conductor path

### Path A — Claude Code harness pointed at an Anthropic-compatible endpoint

**Recommended.** This is the path that fits the budget offerings' own terms, and it is the
cheapest to build.

*What exists.* `AdapterOptions` already carries an `environment?: NodeJS.ProcessEnv`
(`src/main/providers/adapter.ts:14`), and `JsonLineTransport` passes it to the spawned Claude
process (`src/main/providers/claude.ts:164-167`). **`StructuredSessions.options()` never sets it**
(`src/main/structured-sessions.ts:187-212`), so today every Claude tab inherits the Electron
process environment unchanged. The adapter's own comment records that this is deliberate: "No
`--bare`, `--system-prompt`, `--setting-sources`, or environment auth mutation" — the CLI's
defaults, configuration and policy are preserved, and `capabilities.authentication` is `'cli'`.

*The change.* Populate `environment` for sessions the owner has explicitly marked as using a
third-party endpoint, with `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and the
`ANTHROPIC_DEFAULT_*_MODEL` aliases. This is a **per-process** environment; it does not touch
`~/.claude/settings.json`, so the owner's own terminal `claude` and every un-marked Conductor tab
keep the subscription.

*The four costs, all of them real.*

1. **Settings files beat the process environment.** Claude Code's documented rule: "When the same
   variable is set in both your shell and a settings file `env` block, the settings file value
   applies. Claude Code writes each `env` entry into the process environment, replacing the value
   inherited from the shell." So if the owner ever follows a vendor quick-start — Z.ai's, Kimi's
   and DeepSeek's all tell you to write `~/.claude/settings.json` — **that file silently
   overrides Conductor's per-session variables in both directions**: subscription tabs would start
   billing a third party, and third-party tabs would ignore their endpoint. Kimi's own docs warn
   about exactly this ("stale values left in its env field override environment variables exported
   in your terminal"). The adapter must read the user and project settings files at start, and
   refuse or loudly warn when either sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or
   `ANTHROPIC_AUTH_TOKEN`. Conductor could instead own a settings file and pass `--settings`,
   which sits above both project files in precedence — but below managed settings, and it changes
   the "no `--setting-sources`" promise the adapter makes today.
2. **`ANTHROPIC_API_KEY` is a live grenade.** Claude Code's reference: when set, "this key is used
   instead of your Claude Pro, Max, Team, or Enterprise subscription even if you are logged in."
   Conductor must use `ANTHROPIC_AUTH_TOKEN` (which becomes an `Authorization: Bearer` header) and
   must never let `ANTHROPIC_API_KEY` reach a tab the owner did not mark.
3. **Capability regression, silently.** "When [`ANTHROPIC_BASE_URL`] is set to a non-first-party
   host, MCP tool search is disabled by default." Conductor attaches its own MCP servers at launch
   via `--mcp-config`, so this belongs in `capabilities.limitations` for such a session. Effort
   levels, thinking display, background tasks and subagent forwarding are all negotiated against
   Anthropic's protocol and are not guaranteed by a compatibility shim; the existing
   `claudeCompatibility(version)` gate checks the *CLI* version, not the *endpoint's* fidelity.
4. **Usage and cost telemetry becomes wrong.** `cumulativeCostUsd` is computed from the CLI's
   price table (`src/main/providers/claude.ts:503`), which prices Anthropic models. On a GLM or
   Kimi endpoint the dollar figures shown in the tab would be fiction. Either suppress cost for
   these sessions or label it.

*Credential storage.* These are bearer tokens for a paid account. They must not go in
`config.json` next to the model pins, and not in the renderer. The existing local-model
credential pattern — a 0600 file under the local root, read in the main process only
(`src/main/local-models/config.ts:107-128`) — is the right shape, but `readApiKey` enforces a
32-character minimum that a vendor key may not satisfy, so it needs its own reader rather than
reuse.

*Proposed configuration, not executed.* Per-session environment, built in `options()`:

```ts
// Z.ai GLM Coding Plan — https://docs.z.ai/devpack/tool/claude
environment: {
  ...process.env,
  ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
  ANTHROPIC_AUTH_TOKEN: readVendorToken('zai'),
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
  API_TIMEOUT_MS: '3000000',
  ANTHROPIC_API_KEY: undefined   // must never be inherited into a third-party session
}

// Moonshot / Kimi — https://platform.kimi.ai/docs/guide/claude-code-kimi
{ ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
  ANTHROPIC_AUTH_TOKEN: readVendorToken('moonshot'),
  ANTHROPIC_MODEL: 'kimi-k3[1m]',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
  CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3[1m]',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' }

// DeepSeek — https://api-docs.deepseek.com/guides/anthropic_api
{ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: readVendorToken('deepseek') }
// DeepSeek maps Opus names to deepseek-v4-pro and Sonnet/Haiku names to deepseek-flash itself.
```

### Path B — the local adapter pointed at a remote endpoint

**Not recommended, and larger than it looks.** The plan brief already flags that "the local
adapter is not a configurable remote-provider integration". Reading it confirms how deep that
goes:

- `endpointFor(model)` is literally `` `http://127.0.0.1:${recordedPort(model)}` ``
  (`src/main/local-models/config.ts:187`). There is no field for a remote host, and
  `recordedPort` reads a llama.cpp run record.
- `validateConfig` requires every model to carry `repo`, a `*.gguf` filename, a 64-hex `sha256`,
  a port, and `gpuLayers` (`config.ts:134-152`). A remote model has none of those.
- `readApiKey` demands a 32-character-plus local key, and `llamaServerArgs` rejects anything not
  matching `/^[a-f0-9]{32,}$/`.
- `LocalAdapter.ready()` health-probes and *starts llama.cpp* before every turn
  (`src/main/providers/local.ts:120-127`).
- The adapter's published `limitations` promise "Inference runs on this machine through llama.cpp
  on 127.0.0.1" and that web research "sends only the requested URL, without cookies or
  credentials". Both become false, and they are what the owner reads in the tab to decide what is
  safe to paste.
- The Docker sandbox with `--network none` was designed around a local model; whether it still
  makes sense when the *model* is remote is a policy question, not a refactor.

That is a model-kind discriminator, a second credential store, a second endpoint resolver, a
bypass of server admission, and a rewritten data-boundary notice — for a path that Z.ai's and
Alibaba's terms forbid anyway and that only DeepSeek and Moonshot permit. If it is ever built, it
should be built as its own thing, not by loosening the local one.

### Path C — a new structured provider

Cleanest boundary, highest cost. `StructuredProvider` is a three-member union
(`src/shared/structured-agent.ts:3`) and **29 non-test source files** reference `'local'` today —
adapter factory, agent manager, database, machines, phone access, remote control, session
archive, turn briefing, update manager, the launcher, the pane factory, model selection and the
shared model catalog. A fourth member touches most of that. Worth it only if a runtime brings
capabilities the Claude adapter cannot express, which is the question
`docs/agent-runtime-options.md` answers.

---

## Ranked recommendation

1. **Keep the current stack as the default.** The owner's Codex and Claude subscriptions were at
   7% and 11–12% of their windows when this swarm was planned. Nothing here is cheaper than
   capacity already paid for and not used. A budget provider is for *overflow* and for
   *mechanical* work, not for replacing the frontier tabs.
2. **If one thing is added, add Moonshot/Kimi API credit — $20, once, not monthly.** It is the
   only option that satisfies all three Conductor paths, the only one publishing a concurrency
   number (40 at Tier2), and the only one with a 1-hour prompt-cache TTL, which is the feature
   that matters most for Conductor's 160k-token sessions. Credit does not expire monthly, so a
   quiet month costs nothing — unlike a subscription.
3. **Then the Z.ai GLM Coding Plan at $18/month, through the Claude adapter only.** Best fixed-bill
   option, current open-weights frontier model, and its own supported-tools list covers both
   Claude Code and (see the runtime document) OpenCode, Crush and Goose. Confirm the recurring
   price and the credit-to-token conversion at checkout; it is non-refundable.
4. **DeepSeek only for work the owner would publish.** The cost advantage is real and large. The
   PRC data residency, PRC governing law and opt-*out* training policy are also real, and no
   integration cleverness makes them smaller.
5. **Do not buy MiniMax or Alibaba.** $22 and $50 are outside the stated budget and neither offers
   anything the three above do not.
6. **Build Path A before buying anything.** Per-session `environment` plus a settings-file conflict
   check is a contained change to one adapter, and it is what turns any of these subscriptions
   into something Conductor can actually use. Buying first and integrating later gets the order
   backwards.

## Sources

All read 2026-09-21.

- <https://docs.z.ai/devpack/overview> — "Starting at just 18 USD per month"; Lite/Pro/Max credit table; GLM-5.3 routing
- <https://docs.z.ai/devpack/faq> — plan is limited to supported tools; no API calls outside the plan; non-refundable
- <https://docs.z.ai/devpack/quick-start> — supported tools list
- <https://docs.z.ai/devpack/tool/claude> — `https://api.z.ai/api/anthropic`, settings.json snippet, model aliases
- <https://docs.z.ai/guides/overview/pricing> — pay-as-you-go GLM prices including cached input
- <https://docs.z.ai/legal-agreement/privacy-policy> — retention; JINGSHENG HENGXING TECHNOLOGY PTE. LTD as processor
- <https://platform.kimi.ai/docs/pricing/chat> — per-token prices, context lengths, cache-write TTLs
- <https://platform.kimi.ai/docs/pricing/limits> — concurrency/RPM/TPM by cumulative top-up tier
- <https://platform.kimi.ai/docs/guide/claude-code-kimi> — `https://api.moonshot.ai/anthropic`, model aliases
- <https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html> — `https://api.kimi.ai/coding/`, settings.json overriding shell env, plaintext-key warning
- <https://www.kimi.com/code/docs/en/kimi-code/membership.html> — tier/model access, 5-hour rolling window
- <https://www.kimi.com/en/help/membership/membership-pricing> — ¥49 / ¥99 / ¥199 / ¥699 monthly tiers
- <https://www.kimi.com/en/help/kimi-code/benefits> — 7-day credit refresh; per-request cost examples
- <https://api-docs.deepseek.com/quick_start/pricing> — off-peak/peak table, peak-hours definition
- <https://api-docs.deepseek.com/guides/anthropic_api> — `https://api.deepseek.com/anthropic`, Claude-name alias map
- <https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html> — PRC storage, retention, training and opt-out
- <https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html> — PRC governing law
- <https://www.alibabacloud.com/help/en/model-studio/coding-plan> — Pro $50/month, quotas, interactive-use-only restriction, Lite withdrawal dates
- <https://platform.minimax.io/docs/guides/pricing-token-plan> — Plus $22 / Max $55 / Ultra $132
- <https://code.claude.com/docs/en/env-vars> — `ANTHROPIC_BASE_URL` disabling MCP tool search; `ANTHROPIC_API_KEY` overriding the subscription; settings-`env`-beats-shell precedence
- <https://code.claude.com/docs/en/settings> — the five-level settings precedence stack
