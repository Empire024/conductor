// Latest models, step 4: the compatibility report. Reads what the earlier scripts of this run
// printed (cli-catalogs.out, conductor-pins.out, primary-sources.out in
// CONDUCTOR_SCHEDULE_RUN_DIR) and turns every difference into a finding the owner can act on
// without reading anything else:
//   action  Conductor refuses a CLI, offers a stale id or shows a wrong label now
//   watch   drift that may break later or needs a judgment call
//   info    context (verified baselines, defaults, stale comments)
// with the evidence and, where one is known, the exact edit. A missing or unreadable input is
// itself a finding. Deterministic: no clock, nothing read but the run directory and the checkout
// (cwd, only to check that test files exist); findings are sorted.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const runDir = process.env.CONDUCTOR_SCHEDULE_RUN_DIR || process.cwd()
const root = process.cwd()
const MANAGER = 'src/main/agent-manager.ts'
const MANAGER_TEST = 'src/main/agent-manager.test.ts'
const CLAUDE_ADAPTER = 'src/main/providers/claude.ts'
const CODEX_ADAPTER = 'src/main/providers/codex.ts'
const SELECTION = 'src/shared/agent-model-selection.ts'
const ROUTING = 'src/shared/model-routing.ts'
const CORE_TESTS = [MANAGER_TEST, 'src/main/providers/claude.test.ts', 'src/main/providers/claude-ui-fixture.test.ts', 'src/main/providers/codex.test.ts', 'src/shared/agent-model-selection.test.ts']

const findings = []
const clip = (value, max = 500) => value.length > max ? `${value.slice(0, max - 1)}…` : value
const add = (severity, area, finding, evidence, extra = {}) => findings.push({ severity, area, finding: clip(finding, 900), evidence: clip(evidence), ...extra })
const q = value => `'${value}'`
const quoted = values => values.map(q).join(', ')
const unique = values => [...new Set(values.filter(Boolean))].sort()
const title = word => word ? word[0].toUpperCase() + word.slice(1) : word
const parseVersion = value => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? ''); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null }
const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const compareTuples = (a, b) => a[0] - b[0] || a[1] - b[1]

function input(name, what, optional = false) {
  let text
  try { text = readFileSync(join(runDir, `${name}.out`), 'utf8') } catch {
    if (optional) return null
    add('watch', 'inputs', `${name}.out is missing, so ${what} could not be compared this run.`, `${name} did not run, failed before printing, or its output was not saved`)
    return null
  }
  try { return JSON.parse(text) } catch {
    add('watch', 'inputs', `${name}.out is empty or not valid JSON, so ${what} could not be compared this run.`, `first bytes: ${JSON.stringify(text.slice(0, 80))}`)
    return null
  }
}
const catalogs = input('cli-catalogs', 'what the installed CLIs advertise')
const pinsInput = input('conductor-pins', "Conductor's hard-coded catalogs and version pins")
const sourcesInput = input('primary-sources', "the providers' own model pages")
const restoreBaseline = input('restore-point-baseline', 'installed CLI versions against the latest known-good restore point', true)?.knownGood ?? null
if (pinsInput && !pinsInput.checkout) add('info', 'inputs', 'The project folder is not a Conductor checkout, so only the CLI catalogs and primary sources are reported.', 'conductor-pins printed {"checkout":false}')
const pins = pinsInput?.checkout ? pinsInput : null
const refs = Array.isArray(pins?.references) ? pins.references : []

for (const [provider, label] of [['claude', 'Claude Code'], ['codex', 'Codex'], ['grok', 'Grok']]) {
  const installed = catalogs?.[provider]?.version ?? null
  const known = restoreBaseline?.cliVersions?.[provider] ?? null
  if (installed && known && installed !== known) add('info', 'restore-point', `CLI ${label} changed since the last known-good build ${restoreBaseline.version}: ${known} -> ${installed}.`, `Restore point ${restoreBaseline.version} (${restoreBaseline.createdAt ?? 'unknown time'}) recorded ${label} ${known}; installed now ${installed}.`)
}
/** Every file that mentions `id` (code and comments), for the files list of an edit. */
const filesFor = id => unique(refs.filter(ref => ref.id === id && !ref.retired).map(ref => ref.file))

// ---------------------------------------------------------------------------------------------
// Model id helpers
// ---------------------------------------------------------------------------------------------
const normalizeClaude = id => (id ?? '').replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')
const claudeFamily = id => /^(opus|sonnet|haiku|fable)\b/.exec(id ?? '')?.[1] ?? /^claude-([a-z]{3,})-\d/.exec(id ?? '')?.[1] ?? /^claude-\d+(?:-\d+)*-([a-z]+)/.exec(id ?? '')?.[1] ?? null
/** Family, version and 1M window a Claude entry resolves to: its resolvedModel, else its description ("Opus 5.5 with 1M context"). */
function resolution(model) {
  const oneM = /\b1M context\b/i.test(model.description ?? '')
  const resolved = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(model.resolvedModel ?? '')
  if (resolved) return { family: resolved[1], version: resolved[3] ? `${resolved[2]}.${resolved[3]}` : resolved[2], oneM: Boolean(resolved[4]) || oneM }
  const described = /^([A-Z][A-Za-z]+) (\d+(?:\.\d+)?)\b/.exec(model.description ?? '')
  return described ? { family: described[1].toLowerCase(), version: described[2], oneM } : null
}
const claudeLabel = res => `Claude ${title(res.family)} ${res.version}${res.oneM ? ' (1M context)' : ''}`
/** Anthropic ids in either naming order, e.g. claude-opus-5-5 and claude-3-7-sonnet. */
function parseAnthropic(id) {
  const plain = normalizeClaude(id)
  let m = /^claude-([a-z]{3,})-(\d+)(?:-(\d{1,2}))?$/.exec(plain)
  if (m) return { family: m[1], version: [Number(m[2]), Number(m[3] ?? 0)] }
  m = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)$/.exec(plain)
  return m ? { family: m[3], version: [Number(m[1]), Number(m[2] ?? 0)] } : null
}
/** gpt-<major>[.<minor>][-<variant>]; the variant ('sol', 'pro', '') is the family. */
function parseGpt(id) {
  const m = /^gpt-(\d+)(?:\.(\d+))?(?:-([a-z][a-z0-9.-]*))?$/.exec(id ?? '')
  return m ? { family: m[3] ?? '', version: [Number(m[1]), Number(m[2] ?? 0)] } : null
}
const MODALITY = /audio|realtime|transcribe|tts|image|search|embed|moderation|chat|preview|research|computer|oss|live|translate|whisper/

function classify(provider, id) {
  const test = (pattern, flags, value) => { try { return new RegExp(pattern, flags).test(value) } catch { return false } }
  const frontier = pins?.classifiers?.frontier?.[provider]
  const matches = (pins?.classifiers?.capabilityRank ?? []).filter(rule => test(rule.pattern, rule.flags, id.toLowerCase()))
  return { frontier: frontier ? test(frontier.pattern, frontier.flags, id) : null, rank: matches[0]?.rank ?? 2, matches }
}
const describeClass = (provider, id) => {
  const result = classify(provider, id)
  return `wizard-eligible (isFrontierModel): ${result.frontier === null ? 'unknown' : result.frontier ? 'yes' : 'no'}; capabilityRank: ${result.rank}`
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------
const claude = catalogs?.claude ?? null
const claudeModels = Array.isArray(claude?.models) ? claude.models : null
const claudeVersion = claude?.version ?? null
const cc = `Claude Code ${claudeVersion ?? '(unknown version)'}`
if (catalogs && !claudeModels) add('watch', 'claude-cli', `Claude Code did not answer initialize${claude?.error ? ` (${claude.error})` : ''}, so its model catalog was not compared.`, `version: ${claudeVersion ?? 'unknown'}`)
if (claude?.missingFlags?.length) add('action', 'claude-cli', `${cc} no longer lists ${quoted(claude.missingFlags)} in --help; Conductor passes ${claude.missingFlags.length === 1 ? 'this flag' : 'these flags'} whenever it starts a Claude conversation (ClaudeAdapter.start in ${CLAUDE_ADAPTER}).`, 'claude --help', { proposedEdit: `Find the replacement in claude --help and change the launch arguments in ClaudeAdapter.start() in ${CLAUDE_ADAPTER}.`, files: [CLAUDE_ADAPTER] })

if (claudeVersion && pins?.claudeCompatibility) {
  const installed = parseVersion(claudeVersion), baseline = parseVersion(pins.claudeCompatibility), b = pins.claudeCompatibility
  const evidence = `claude --version ${claudeVersion}; CLAUDE_COMPATIBILITY '${b}' in ${CLAUDE_ADAPTER}`
  const bump = `After npx vitest run src/main/providers/claude.test.ts src/main/providers/claude-ui-fixture.test.ts passes, edit ${CLAUDE_ADAPTER}: CLAUDE_COMPATIBILITY '${b}' -> '${claudeVersion}' (and the baseline line in docs/claude-compatibility.md).`
  if (!installed || !baseline) add('watch', 'claude-version', `Could not compare ${cc} with CLAUDE_COMPATIBILITY '${b}'.`, evidence)
  else if (installed[0] !== baseline[0]) add('action', 'claude-version', `${cc} is a different major line than CLAUDE_COMPATIBILITY ${b}: Conductor refuses to start Claude conversations on it.`, evidence, { proposedEdit: `Verify the control protocol against ${claudeVersion}, then: ${bump}`, files: [CLAUDE_ADAPTER] })
  else if (compareVersions(installed, baseline) < 0) add('action', 'claude-version', `${cc} is older than CLAUDE_COMPATIBILITY ${b}: Conductor refuses to start Claude conversations on it ("below the tested ${b} bridge baseline").`, evidence, { proposedEdit: `Update Claude Code to ${b} or newer (claude update). Do not lower CLAUDE_COMPATIBILITY in ${CLAUDE_ADAPTER} unless ${claudeVersion} is verified.` })
  else if (compareVersions(installed, baseline) > 0) add('watch', 'claude-version', `${cc} is newer than the fixture-verified CLAUDE_COMPATIBILITY ${b}: Conductor connects, but every Claude conversation carries the limitation "Runtime ${claudeVersion} is newer than the fixture-verified ${b} baseline".`, evidence, { proposedEdit: bump, files: [CLAUDE_ADAPTER, 'docs/claude-compatibility.md'] })
  else add('info', 'claude-version', `${cc} is the fixture-verified CLAUDE_COMPATIBILITY baseline.`, evidence)
}

if (claudeModels && pins) {
  const offered = new Map(claudeModels.map(model => [model.value, model]))
  const catalog = pins.catalogs?.claude ?? []
  const catalogIds = new Set(catalog.map(entry => entry.id))
  const offeredList = `initialize models: ${quoted(claudeModels.map(model => model.value))}`
  const consumed = new Set()
  const spare = claudeModels.filter(model => model.value !== 'default' && !catalogIds.has(model.value))
  /** The one offered id a catalog id most likely became: same id without [1m]/date, else same family. */
  const successor = id => {
    const exact = spare.filter(model => !consumed.has(model.value) && [model.value, model.resolvedModel].some(value => value && normalizeClaude(value) === normalizeClaude(id)))
    if (exact.length === 1) return exact[0]
    const family = claudeFamily(id)
    const same = spare.filter(model => !consumed.has(model.value) && family && [claudeFamily(model.value), claudeFamily(model.resolvedModel), resolution(model)?.family].includes(family))
    return same.length === 1 ? same[0] : null
  }
  for (const entry of catalog) {
    if (entry.id === 'default') continue
    const cli = offered.get(entry.id)
    if (cli) {
      const res = resolution(cli)
      if (!res) continue
      const expected = claudeLabel(res)
      if (entry.label === expected) continue
      const named = /\b(\d+(?:\.\d+)?)\b/.exec(entry.label)?.[1] ?? null
      const target = cli.resolvedModel ? `${cli.resolvedModel} (${title(res.family)} ${res.version})` : `${title(res.family)} ${res.version} (per its description)`
      add(named && named === res.version ? 'watch' : 'action', 'claude-catalog',
        `${cc} resolves ${entry.id} to ${target}; CLAUDE_MODELS labels it ${q(entry.label)}, ${named ? `which names version ${named}` : 'which does not name the version'}. Edit ${MANAGER}: label -> ${q(expected)}.`,
        `initialize: ${entry.id} -> resolvedModel ${cli.resolvedModel ?? 'n/a'}, description ${JSON.stringify(cli.description ?? '')}`,
        { proposedEdit: `In CLAUDE_MODELS in ${MANAGER}: { id: ${q(entry.id)}, label: ${q(entry.label)} } -> { id: ${q(entry.id)}, label: ${q(expected)} }`, files: [MANAGER] })
      continue
    }
    const next = successor(entry.id)
    if (next) {
      consumed.add(next.value)
      const res = resolution(next)
      const label = res ? claudeLabel(res) : entry.label
      add('action', 'claude-catalog',
        `${cc} no longer offers ${q(entry.id)}; it offers ${q(next.value)}${res ? ` (${title(res.family)} ${res.version})` : ''} instead. CLAUDE_MODELS still lists ${q(entry.id)}, so Conductor's picker (and any tab saved on it) passes an id the CLI no longer advertises.`,
        offeredList,
        { proposedEdit: `In CLAUDE_MODELS in ${MANAGER}: { id: ${q(entry.id)}, label: ${q(entry.label)} } -> { id: ${q(next.value)}, label: ${q(label)} }; replace ${q(entry.id)} with ${q(next.value)} in the other files listed (tests and scripts pin it too).`, files: unique([MANAGER, ...filesFor(entry.id)]) })
    } else {
      add('action', 'claude-catalog', `CLAUDE_MODELS lists ${q(entry.id)}, which ${cc} no longer offers, and no single offered model replaces it.`, offeredList,
        { proposedEdit: `Remove { id: ${q(entry.id)}, label: ${q(entry.label)} } from CLAUDE_MODELS in ${MANAGER} (and from the files listed), unless claude --model ${entry.id} is confirmed to still work.`, files: unique([MANAGER, ...filesFor(entry.id)]) })
    }
  }
  for (const model of spare) {
    if (consumed.has(model.value)) continue
    const res = resolution(model)
    add('action', 'claude-catalog',
      `${cc} offers ${q(model.value)} (${model.displayName ?? model.value}${model.description ? `: ${model.description}` : ''}) but CLAUDE_MODELS lacks it, so it is missing from Conductor's static fallback catalog (the picker before discovery).`,
      `initialize: ${model.value} -> ${model.resolvedModel ?? 'n/a'}; efforts ${model.efforts?.join('/') || 'none'}; ${describeClass('claude', model.value)}`,
      { proposedEdit: `Add { id: ${q(model.value)}, label: ${q(res ? claudeLabel(res) : model.displayName ?? model.value)} } to CLAUDE_MODELS in ${MANAGER}, and the id to the list pinned in ${MANAGER_TEST}.`, files: [MANAGER, MANAGER_TEST] })
  }
  const fallback = pins.fallbacks?.claude
  if (fallback && !offered.has(fallback) && !catalogIds.has(fallback)) {
    const next = successor(fallback)
    add('action', 'claude-catalog', `CLAUDE_FALLBACK_MODEL ${q(fallback)} in ${SELECTION} is not offered by ${cc}; a Claude conversation runs on it before discovery names a model.`, offeredList,
      { proposedEdit: next ? `Edit ${SELECTION}: CLAUDE_FALLBACK_MODEL ${q(fallback)} -> ${q(next.value)}` : `Point CLAUDE_FALLBACK_MODEL in ${SELECTION} at an id ${cc} offers.`, files: [SELECTION] })
  }
  const accountDefault = offered.get('default')
  if (accountDefault) {
    const res = resolution(accountDefault)
    add('info', 'claude-catalog', `${cc}: the account default resolves to ${accountDefault.resolvedModel ?? 'an unnamed model'}${res ? ` (${title(res.family)} ${res.version})` : ''}.`, `initialize: default -> ${accountDefault.resolvedModel ?? 'n/a'}`)
  }
  const ladder = pins.efforts?.claudeAdapter ?? []
  const cliEfforts = unique(claudeModels.flatMap(model => model.efforts ?? []))
  if (ladder.length && cliEfforts.length) {
    for (const effort of cliEfforts.filter(effort => !ladder.includes(effort))) {
      add('action', 'claude-effort', `${cc} offers effort ${q(effort)} (${quoted(claudeModels.filter(model => model.efforts?.includes(effort)).map(model => model.value))}) but the Claude adapter's effort ladder lacks it, so Conductor cannot select it.`, `adapter ladder: ${ladder.join('/')}`,
        { proposedEdit: `Add ${q(effort)} to the effort ladder in the capabilities of ${CLAUDE_ADAPTER}.`, files: [CLAUDE_ADAPTER] })
    }
    const unused = ladder.filter(effort => !cliEfforts.includes(effort))
    if (unused.length) add('watch', 'claude-effort', `The Claude adapter's effort ladder offers ${quoted(unused)}, which no model of ${cc} supports.`, `CLI efforts: ${cliEfforts.join('/')}`, { files: [CLAUDE_ADAPTER] })
  }
  for (const fixture of (pins.fixtures ?? []).filter(fixture => fixture.provider === 'claude' && Array.isArray(fixture.models))) {
    const real = fixture.models.filter(model => !model.synthetic)
    const kept = new Map(real.map(model => [model.value, model]))
    const diffs = []
    const added = claudeModels.filter(model => !kept.has(model.value)).map(model => model.value)
    const removed = real.filter(model => !offered.has(model.value)).map(model => model.value)
    if (added.length) diffs.push(`${cc} adds ${quoted(added)}`)
    if (removed.length) diffs.push(`${cc} no longer offers ${quoted(removed)}`)
    for (const model of real) {
      const cli = offered.get(model.value)
      if (!cli) continue
      if ((model.resolvedModel ?? null) !== (cli.resolvedModel ?? null)) diffs.push(`${model.value} now resolves to ${cli.resolvedModel ?? 'nothing'} (fixture: ${model.resolvedModel ?? 'nothing'})`)
      if ((model.displayName ?? null) !== (cli.displayName ?? null)) diffs.push(`${model.value} is now named ${q(cli.displayName)} (fixture: ${q(model.displayName)})`)
      if ((model.efforts ?? []).join('/') !== (cli.efforts ?? []).join('/')) diffs.push(`${model.value} efforts ${cli.efforts?.join('/') || 'none'} (fixture: ${model.efforts?.join('/') || 'none'})`)
    }
    const versionDiffers = fixture.reportsVersion && claudeVersion && fixture.reportsVersion !== claudeVersion
    if (!diffs.length && !versionDiffers) continue
    const captured = fixture.headerVersions?.length ? ` (captured from Claude Code ${fixture.headerVersions.join('/')}${fixture.headerDates?.length ? ` on ${fixture.headerDates.join('/')}` : ''})` : ''
    add(diffs.length ? 'action' : 'watch', 'fixtures',
      `${fixture.file}${captured} no longer matches the installed ${cc}: ${diffs.length ? diffs.join('; ') : `it still reports --version ${fixture.reportsVersion}`}.`,
      `fixture --version ${fixture.reportsVersion ?? 'n/a'}; fixture models ${quoted(real.map(model => model.value))}`,
      { proposedEdit: `Re-capture with node scripts/probe-capability-sweep.mjs --skip-codex (initialize only, no inference): copy initialize.models verbatim into CLAUDE_MODELS of ${fixture.file} (keep its synthetic swarm-* entry), set its --version line to '${claudeVersion} (Claude Code)' and the version/date in its header.`, files: [fixture.file] })
  }
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------
const codex = catalogs?.codex ?? null
const codexModels = Array.isArray(codex?.models) ? codex.models : null
const codexVersion = codex?.version ?? null
const cx = `Codex ${codexVersion ?? '(unknown version)'}`
if (catalogs && !codexModels) add('watch', 'codex-cli', `Codex did not answer model/list${codex?.error ? ` (${codex.error})` : ''}, so its model catalog was not compared.`, `version: ${codexVersion ?? 'unknown'}`)

if (codexVersion && pins) {
  const baseline = pins.codexProtocolBaseline, gate = pins.codexVersionGate
  const evidence = `codex --version ${codexVersion}; CODEX_PROTOCOL_BASELINE '${baseline}', gate ${gate ?? 'unreadable'} in ${CODEX_ADAPTER}`
  const [major, minor] = (codexVersion.match(/^(\d+)\.(\d+)/) ?? []).slice(1)
  const rebaseline = `Rebaseline per docs/codex-compatibility.md: set expected in scripts/generate-codex-protocol.mjs and CODEX_PROTOCOL_BASELINE in ${CODEX_ADAPTER} to '${codexVersion}'${major ? ` and the version gate to /^${major}\\.${minor}\\./ in CodexAdapter.start()` : ''}, run node scripts/generate-codex-protocol.mjs, diff src/main/providers/generated/codex against the committed bundle, update scripts/fixtures/codex-app-server.mjs where the wire moved, then npm run test:agent-contracts.`
  const inGate = gate ? codexVersion.startsWith(gate.replace(/x$/, '')) : null
  const installed = parseVersion(codexVersion), base = parseVersion(baseline)
  if (inGate === null) add('watch', 'codex-version', `Could not read the Codex version gate in ${CODEX_ADAPTER}, so ${cx} was only compared with CODEX_PROTOCOL_BASELINE ${baseline}.`, evidence)
  if (inGate === false) {
    const older = installed && base && compareVersions(installed, base) < 0
    add('action', 'codex-version', `${cx} is outside the tested ${gate} protocol gate: Conductor refuses to connect Codex conversations ("outside the tested ${gate} protocol baseline").`, evidence,
      { proposedEdit: older ? `Install codex-cli ${baseline} (the fixture-verified baseline), or rebaseline down only after verifying ${codexVersion}.` : rebaseline, files: [CODEX_ADAPTER, 'scripts/generate-codex-protocol.mjs', 'scripts/fixtures/codex-app-server.mjs'] })
  } else if (baseline && codexVersion !== baseline) {
    add('watch', 'codex-version', `${cx} is inside the ${gate ?? 'version'} gate but is not the fixture-verified CODEX_PROTOCOL_BASELINE ${baseline}: Conductor connects with the "not fixture-verified" limitation and experimental features (plan mode) disabled.`, evidence,
      { proposedEdit: rebaseline, files: [CODEX_ADAPTER, 'scripts/generate-codex-protocol.mjs'] })
  } else if (baseline) add('info', 'codex-version', `${cx} is the fixture-verified CODEX_PROTOCOL_BASELINE.`, evidence)
  if (pins.codexGeneratorExpected && baseline && pins.codexGeneratorExpected !== baseline) add('watch', 'codex-version', `scripts/generate-codex-protocol.mjs expects codex-cli ${pins.codexGeneratorExpected} but CODEX_PROTOCOL_BASELINE is ${baseline}; the next regeneration would refuse or target the wrong version.`, 'const expected in scripts/generate-codex-protocol.mjs', { proposedEdit: `Set const expected = '${baseline}' in scripts/generate-codex-protocol.mjs.`, files: ['scripts/generate-codex-protocol.mjs'] })
  for (const fixture of (pins.fixtures ?? []).filter(fixture => fixture.provider === 'codex' && !fixture.models && fixture.reportsVersion && fixture.reportsVersion !== codexVersion)) {
    add('watch', 'fixtures', `${fixture.file} speaks the codex-cli ${fixture.reportsVersion} protocol; the installed Codex is ${codexVersion}, so the contract tests do not cover the installed wire.`, `fixture --version codex-cli ${fixture.reportsVersion}`, { files: [fixture.file] })
  }
}

if (codexModels && pins) {
  const offered = new Map(codexModels.map(model => [model.id, model]))
  const visible = codexModels.filter(model => !model.hidden)
  const catalog = pins.catalogs?.codex ?? []
  const catalogIds = new Set(catalog.map(entry => entry.id))
  const offeredList = `model/list: ${quoted(visible.map(model => model.id))}${codexModels.length > visible.length ? `; hidden ${quoted(codexModels.filter(model => model.hidden).map(model => model.id))}` : ''}`
  const consumed = new Set()
  const legacy = model => Boolean(model.upgrade) || /\b(?:legacy|retir|deprecat)/i.test(model.description ?? '')
  /** A visible, current model of the same family with a higher version (gpt-5.6-sol -> gpt-6-sol). */
  const newer = id => {
    const own = parseGpt(id)
    if (!own?.family) return null
    const candidates = visible.filter(model => { const other = parseGpt(model.id); return other && other.family === own.family && compareTuples(other.version, own.version) > 0 && !legacy(model) })
    return candidates.sort((a, b) => compareTuples(parseGpt(b.id).version, parseGpt(a.id).version))[0] ?? null
  }
  for (const entry of catalog) {
    if (entry.id === 'default') continue
    const cli = offered.get(entry.id)
    if (cli) {
      if (cli.hidden) add('watch', 'codex-catalog', `CODEX_MODELS lists ${q(entry.id)}, which ${cx} hides from its own picker.`, offeredList, { files: [MANAGER] })
      if (cli.displayName && cli.displayName !== entry.label) add('action', 'codex-catalog', `${cx} names ${q(entry.id)} ${q(cli.displayName)}; CODEX_MODELS labels it ${q(entry.label)}. Edit ${MANAGER}: label -> ${q(cli.displayName)}.`, `model/list displayName for ${entry.id}`,
        { proposedEdit: `In CODEX_MODELS in ${MANAGER}: { id: ${q(entry.id)}, label: ${q(entry.label)} } -> { id: ${q(entry.id)}, label: ${q(cli.displayName)} }, and the label list pinned in ${MANAGER_TEST}.`, files: [MANAGER, MANAGER_TEST] })
      if (cli.upgrade) add('watch', 'codex-catalog', `${cx} marks ${q(entry.id)} for upgrade to ${q(cli.upgrade)}${cli.retirementAt ? ` (retires ${cli.retirementAt})` : ''}; CODEX_MODELS still lists it.`, `model/list upgrade for ${entry.id}`, { files: [MANAGER] })
      continue
    }
    const family = parseGpt(entry.id)?.family
    const candidates = family ? visible.filter(model => !catalogIds.has(model.id) && !consumed.has(model.id) && parseGpt(model.id)?.family === family) : []
    if (candidates.length === 1) {
      const next = candidates[0]
      consumed.add(next.id)
      add('action', 'codex-catalog', `${cx} no longer offers ${q(entry.id)}; it offers ${q(next.id)} (${next.displayName}) in the same family. CODEX_MODELS still lists ${q(entry.id)}.`, offeredList,
        { proposedEdit: `In CODEX_MODELS in ${MANAGER}: { id: ${q(entry.id)}, label: ${q(entry.label)} } -> { id: ${q(next.id)}, label: ${q(next.displayName ?? next.id)} }; replace ${q(entry.id)} with ${q(next.id)} in the other files listed.`, files: unique([MANAGER, ...filesFor(entry.id)]) })
    } else {
      add('action', 'codex-catalog', `CODEX_MODELS lists ${q(entry.id)}, which ${cx} no longer offers.`, offeredList,
        { proposedEdit: `Remove { id: ${q(entry.id)}, label: ${q(entry.label)} } from CODEX_MODELS in ${MANAGER} and the lists pinned in ${MANAGER_TEST}; replace it in the other files listed.`, files: unique([MANAGER, ...filesFor(entry.id)]) })
    }
  }
  for (const model of visible) {
    if (catalogIds.has(model.id) || consumed.has(model.id)) continue
    if (legacy(model)) {
      add('info', 'codex-catalog', `${cx} still offers the legacy ${q(model.id)}${model.upgrade ? ` (upgrade: ${q(model.upgrade)})` : ''}${model.retirementAt ? `, retiring ${model.retirementAt}` : ''}; CODEX_MODELS leaves legacy models to discovery.`, `model/list description ${JSON.stringify(model.description ?? '')}`)
      continue
    }
    add('action', 'codex-catalog',
      `${cx} offers ${q(model.id)} (${model.displayName ?? model.id}${model.description ? `: ${model.description}` : ''}) but CODEX_MODELS lacks it, so it is missing from Conductor's static fallback catalog (the picker before discovery, router and task defaults).`,
      `model/list: ${model.id} efforts ${model.efforts?.join('/') || 'none'}, default ${model.defaultEffort ?? 'n/a'}${model.isDefault ? ', account default' : ''}; ${describeClass('codex', model.id)}`,
      { proposedEdit: `Add { id: ${q(model.id)}, label: ${q(model.displayName ?? model.id)} } to CODEX_MODELS in ${MANAGER}, and to the id and label lists pinned in ${MANAGER_TEST}.`, files: [MANAGER, MANAGER_TEST] })
  }
  const cliDefault = codexModels.find(model => model.isDefault)
  const fallback = pins.fallbacks?.codex
  if (fallback && !offered.has(fallback) && !catalogIds.has(fallback)) {
    add('action', 'codex-catalog', `CODEX_FALLBACK_MODEL ${q(fallback)} in ${SELECTION} is not offered by ${cx}.`, offeredList, { proposedEdit: `Edit ${SELECTION}: CODEX_FALLBACK_MODEL ${q(fallback)} -> ${q(cliDefault?.id ?? visible[0]?.id ?? '?')}`, files: [SELECTION] })
  } else if (fallback && cliDefault && cliDefault.id !== fallback) {
    add('watch', 'codex-catalog', `${cx}'s default model is ${q(cliDefault.id)}; CODEX_FALLBACK_MODEL in ${SELECTION} is ${q(fallback)}.`, 'model/list isDefault', { proposedEdit: `Edit ${SELECTION}: CODEX_FALLBACK_MODEL ${q(fallback)} -> ${q(cliDefault.id)}, if the account default should also be Conductor's.`, files: [SELECTION] })
  } else if (cliDefault) add('info', 'codex-catalog', `${cx}: the account default model is ${q(cliDefault.id)}.`, 'model/list isDefault')

  const cliEfforts = unique(visible.flatMap(model => model.efforts ?? []))
  const catalogEfforts = (pins.efforts?.catalog ?? []).filter(effort => effort !== 'auto')
  const adapterEfforts = pins.efforts?.codexAdapter ?? []
  const accepted = pins.efforts?.codexAccepted ?? []
  if (cliEfforts.length && catalogEfforts.length) {
    for (const effort of cliEfforts) {
      const gaps = [!catalogEfforts.includes(effort) && `CODEX_EFFORTS in ${MANAGER}`, adapterEfforts.length && !adapterEfforts.includes(effort) && `the adapter's fallback effort ladder in ${CODEX_ADAPTER}`, accepted.length && !accepted.includes(effort) && `the efforts CodexAdapter accepts per turn in ${CODEX_ADAPTER} (it throws 'Unsupported Codex reasoning effort')`].filter(Boolean)
      if (gaps.length) add('action', 'codex-effort', `${cx} offers effort ${q(effort)} (${quoted(visible.filter(model => model.efforts?.includes(effort)).map(model => model.id))}) but ${gaps.join(', and ')} lack${gaps.length === 1 ? 's' : ''} it.`, `CLI efforts: ${cliEfforts.join('/')}`,
        { proposedEdit: `Add ${q(effort)} to ${gaps.join(' and ')}.`, files: unique([catalogEfforts.includes(effort) ? null : MANAGER, CODEX_ADAPTER]) })
    }
    const unused = catalogEfforts.filter(effort => !cliEfforts.includes(effort))
    if (unused.length) add('watch', 'codex-effort', `CODEX_EFFORTS offers ${quoted(unused)}, which no visible model of ${cx} supports.`, `CLI efforts: ${cliEfforts.join('/')}`, { files: [MANAGER] })
  }
  // Ids hard-coded outside the catalog: task weights, fallbacks, migrations.
  for (const id of unique(refs.filter(ref => ref.provider === 'codex' && ref.kind === 'source' && !ref.comment && !ref.retired).map(ref => ref.id))) {
    if (catalogIds.has(id)) {
      const files = unique(refs.filter(ref => ref.id === id && ref.kind === 'source' && !ref.comment && !ref.retired && ref.file !== MANAGER).map(ref => ref.file))
      const cli = offered.get(id), next = newer(id)
      if (!files.length || !cli || (!cli.upgrade && !next)) continue
      const target = cli.upgrade ?? next.id
      add('watch', 'codex-models', `${cx} ${cli.upgrade ? `marks ${q(id)} for upgrade to ${q(cli.upgrade)}` : `offers ${q(next.id)} (${JSON.stringify(next.description ?? '')}) as the newer ${parseGpt(id).family} model and describes ${q(id)} as ${JSON.stringify(cli.description ?? '')}`}; ${files.join(', ')} still hard-code${files.length === 1 ? 's' : ''} ${q(id)}.`, `model/list: ${id}${cli.upgrade ? ` upgrade ${cli.upgrade}` : ''}`,
        { proposedEdit: `Consider ${q(id)} -> ${q(target)} in ${files.join(', ')}.`, files })
      continue
    }
    const files = unique(refs.filter(ref => ref.id === id && ref.kind === 'source' && !ref.comment && !ref.retired).map(ref => ref.file))
    if (!offered.has(id)) add('action', 'codex-models', `${files.join(', ')} hard-code${files.length === 1 ? 's' : ''} ${q(id)}, which ${cx} does not offer.`, offeredList,
      { proposedEdit: newer(id) ? `Replace ${q(id)} with ${q(newer(id).id)} in ${files.join(', ')}.` : `Replace ${q(id)} in ${files.join(', ')} with a model ${cx} offers.`, files: filesFor(id) })
  }
  for (const model of visible) {
    const result = classify('codex', model.id)
    const ranks = unique(result.matches.map(rule => String(rule.rank)))
    const other = result.matches.find(rule => rule.rank !== result.rank)
    if (ranks.length > 1) add('watch', 'routing', `capabilityRank in ${ROUTING} ranks ${q(model.id)} ${result.rank} by /${result.matches[0].pattern}/, though /${other.pattern}/ (rank ${other.rank}) also matches${result.frontier && other.rank < result.rank ? ', and isFrontierModel (src/shared/structured-agent.ts) makes it wizard-eligible' : ''}; ${cx} describes it as ${JSON.stringify(model.description ?? '')}.`, describeClass('codex', model.id),
      { proposedEdit: `Decide the rank of ${q(model.id)} and order or narrow the patterns in capabilityRank (${ROUTING}); isFrontierModel in src/shared/structured-agent.ts uses a similar pattern.`, files: [ROUTING, 'src/shared/model-routing.test.ts'] })
  }
}

// Claude ids hard-coded outside the catalog.
if (claudeModels && pins) {
  const catalogIds = new Set((pins.catalogs?.claude ?? []).map(entry => entry.id))
  const known = new Set(claudeModels.flatMap(model => [model.value, model.resolvedModel, normalizeClaude(model.value), normalizeClaude(model.resolvedModel)]).filter(Boolean))
  const families = new Set(claudeModels.flatMap(model => [claudeFamily(model.value), claudeFamily(model.resolvedModel), resolution(model)?.family]).filter(Boolean))
  for (const id of unique(refs.filter(ref => ref.provider === 'claude' && ref.kind === 'source' && !ref.comment && !ref.retired).map(ref => ref.id))) {
    if (catalogIds.has(id)) continue
    const files = unique(refs.filter(ref => ref.id === id && ref.kind === 'source' && !ref.comment && !ref.retired).map(ref => ref.file))
    if (/^(?:opus|sonnet|haiku|fable)$/.test(id)) {
      if (!families.has(id)) add('action', 'claude-models', `${cc} offers no ${title(id)} model any more; ${files.join(', ')} hard-code${files.length === 1 ? 's' : ''} the alias ${q(id)}.`, `initialize models: ${quoted(claudeModels.map(model => model.value))}`, { files: filesFor(id) })
      continue
    }
    if (known.has(id) || known.has(normalizeClaude(id))) continue
    const family = claudeFamily(id)
    const next = claudeModels.filter(model => model.value !== 'default' && family && [claudeFamily(model.value), resolution(model)?.family].includes(family))
    add('action', 'claude-models', `${files.join(', ')} hard-code${files.length === 1 ? 's' : ''} ${q(id)}, which ${cc} neither offers nor resolves to.`, `initialize models: ${quoted(claudeModels.map(model => `${model.value} -> ${model.resolvedModel ?? '?'}`))}`,
      { proposedEdit: next.length === 1 ? `Replace ${q(id)} with ${q(next[0].value)} in ${files.join(', ')}.` : `Replace ${q(id)} in ${files.join(', ')} with an id ${cc} offers.`, files: filesFor(id) })
  }
}

// Comments that still name ids the CLIs no longer offer or resolve: tidy-ups, not breakage.
if (pins && (claudeModels || codexModels)) {
  const knownClaude = new Set((claudeModels ?? []).flatMap(model => [model.value, model.resolvedModel, normalizeClaude(model.value), normalizeClaude(model.resolvedModel)]).filter(Boolean))
  const knownCodex = new Set((codexModels ?? []).map(model => model.id))
  const stale = refs.filter(ref => ref.comment && ref.kind === 'source' && !ref.retired && !/^(?:opus|sonnet|haiku|fable)$/.test(ref.id) && (
    ref.provider === 'claude' ? claudeModels && !knownClaude.has(ref.id) && !knownClaude.has(normalizeClaude(ref.id)) : ref.provider === 'codex' ? codexModels && !knownCodex.has(ref.id) : false))
  if (stale.length) add('info', 'comments', `Comments still name ids the installed CLIs no longer offer or resolve: ${stale.map(ref => `${q(ref.id)} (${ref.file})`).join(', ')}.`, 'quoted ids in comments; update them with the next edit to those files', { files: unique(stale.map(ref => ref.file)) })
  for (const [provider, installed] of [['claude', claudeVersion], ['codex', codexVersion]]) {
    const recorded = pins.catalogProvenance?.[provider]
    if (installed && recorded?.version && recorded.version !== installed) add('info', 'comments', `The comment on ${provider === 'claude' ? 'CLAUDE_MODELS' : 'CODEX_MODELS'} says it mirrors ${provider === 'claude' ? 'Claude Code' : 'codex-cli'} ${recorded.version}${recorded.date ? ` (${recorded.date})` : ''}; the installed CLI is ${installed}. Refresh it with the next catalog edit.`, `${MANAGER}`, { files: [MANAGER] })
  }
}

// Codex capability fixture: captured catalog versus what the CLI advertises now.
if (codexModels && pins) {
  const offered = new Map(codexModels.map(model => [model.id, model]))
  for (const fixture of (pins.fixtures ?? []).filter(fixture => fixture.provider === 'codex' && Array.isArray(fixture.models))) {
    const real = fixture.models.filter(model => !model.synthetic)
    const kept = new Map(real.map(model => [model.id, model]))
    const diffs = []
    const added = codexModels.filter(model => !kept.has(model.id)).map(model => `${q(model.id)}${model.hidden ? ' (hidden)' : ''}`)
    const removed = real.filter(model => !offered.has(model.id)).map(model => model.id)
    if (added.length) diffs.push(`${cx} adds ${added.join(', ')}`)
    if (removed.length) diffs.push(`${cx} no longer offers ${quoted(removed)}`)
    for (const model of real) {
      const cli = offered.get(model.id)
      if (!cli) continue
      for (const key of ['displayName', 'hidden', 'isDefault', 'defaultEffort', 'upgrade']) if ((model[key] ?? null) !== (cli[key] ?? null)) diffs.push(`${model.id} ${key} ${JSON.stringify(cli[key] ?? null)} (fixture: ${JSON.stringify(model[key] ?? null)})`)
      if ((model.efforts ?? []).join('/') !== (cli.efforts ?? []).join('/')) diffs.push(`${model.id} efforts ${cli.efforts?.join('/') || 'none'} (fixture: ${model.efforts?.join('/') || 'none'})`)
    }
    const versionDiffers = fixture.reportsVersion && codexVersion && fixture.reportsVersion !== codexVersion
    if (!diffs.length && !versionDiffers) continue
    const captured = fixture.headerVersions?.length ? ` (captured from codex-cli ${fixture.headerVersions.join('/')}${fixture.headerDates?.length ? ` on ${fixture.headerDates.join('/')}` : ''})` : ''
    add(diffs.length ? 'action' : 'watch', 'fixtures', `${fixture.file}${captured} no longer matches the installed ${cx}: ${diffs.length ? diffs.join('; ') : `it still reports --version ${fixture.reportsVersion}`}.`,
      `fixture --version codex-cli ${fixture.reportsVersion ?? 'n/a'}; fixture models ${quoted(real.map(model => model.id))}`,
      { proposedEdit: `Re-capture with node scripts/probe-capability-sweep.mjs --skip-claude (initialize and model/list only, no inference): copy model/list verbatim into CODEX_MODELS of ${fixture.file} (keep its synthetic swarm-* entry), set its --version line to 'codex-cli ${codexVersion}' and the version/date in its header.`, files: [fixture.file] })
  }
}

// ---------------------------------------------------------------------------------------------
// Primary sources
// ---------------------------------------------------------------------------------------------
const sources = sourcesInput?.sources && typeof sourcesInput.sources === 'object' ? sourcesInput.sources : null
if (sourcesInput && !sources) add('watch', 'primary-sources', `primary-sources printed no source facts${sourcesInput.error ? ` (${sourcesInput.error})` : ''}.`, 'primary-sources.out')
for (const [id, entry] of Object.entries(sources ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
  if (entry?.unavailable) add('watch', 'primary-sources', `${id} has not answered since its cache was empty, so it contributes no facts.`, 'primary-sources: unavailable')
  if (entry?.stale) add('watch', 'primary-sources', `${id} has failed three or more runs in a row; its facts are from the last successful fetch.`, 'primary-sources: stale')
  if (entry?.problem) add('watch', 'primary-sources', `${id} ${entry.problem}.`, 'primary-sources: problem')
}
/** Ids a provider page names that nobody here knows, and that are not older than what is known. */
function unknownIds(pageIds, knownIds, parse) {
  const known = knownIds.map(parse).filter(Boolean)
  if (!known.length) return []
  const floor = known.map(entry => entry.version).sort(compareTuples)[0]
  const best = new Map()
  for (const entry of known) if (!best.has(entry.family) || compareTuples(entry.version, best.get(entry.family)) > 0) best.set(entry.family, entry.version)
  const knownSet = new Set(knownIds)
  return unique(pageIds.filter(id => {
    if (knownSet.has(id)) return false
    const entry = parse(id)
    if (!entry || MODALITY.test(entry.family)) return false
    return best.has(entry.family) ? compareTuples(entry.version, best.get(entry.family)) > 0 : compareTuples(entry.version, floor) >= 0
  }))
}
const openAiIds = sources?.['openai-models']?.modelIds
if (Array.isArray(openAiIds) && (codexModels || pins)) {
  const knownIds = unique([...(codexModels ?? []).filter(model => !model.hidden).map(model => model.id), ...(pins?.catalogs?.codex ?? []).map(entry => entry.id)])
  const found = unknownIds(openAiIds, knownIds, parseGpt)
  if (found.length) add('watch', 'primary-sources', `OpenAI's model catalog names ${quoted(found)}, which neither ${codexModels ? cx : 'Codex'} nor CODEX_MODELS knows; Codex may offer ${found.length === 1 ? 'it' : 'them'} after an update or to another plan.`, 'developers.openai.com all-models page (link ids)')
}
const anthropicIds = sources?.['anthropic-models']?.modelIds
if (Array.isArray(anthropicIds) && (claudeModels || pins)) {
  const knownIds = unique([...(claudeModels ?? []).flatMap(model => [normalizeClaude(model.value), normalizeClaude(model.resolvedModel)]), ...(pins?.catalogs?.claude ?? []).map(entry => normalizeClaude(entry.id))])
  const found = unknownIds(unique(anthropicIds.map(normalizeClaude)), knownIds, parseAnthropic)
  if (found.length) add('watch', 'primary-sources', `Anthropic's models overview names ${quoted(found)}, which neither ${claudeModels ? cc : 'Claude Code'} nor CLAUDE_MODELS knows; Claude Code may offer ${found.length === 1 ? 'it' : 'them'} after an update.`, 'platform.claude.com models overview')
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------
const RANK = { action: 0, watch: 1, info: 2 }
findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.area.localeCompare(b.area) || a.finding.localeCompare(b.finding))
const shown = findings.slice(0, 150)
const moved = findings.filter(finding => finding.severity !== 'info')
const extraTests = moved.flatMap(finding => finding.files ?? []).filter(file => /^src\/.*\.test\.tsx?$/.test(file))
if (moved.some(finding => finding.area.startsWith('claude'))) extraTests.push('src/renderer/src/panes/composer-settings.test.ts')
const relevantTests = pins ? unique([...CORE_TESTS, ...extraTests]).filter(file => existsSync(join(root, file))) : []
const report = {
  summary: { action: findings.filter(f => f.severity === 'action').length, watch: findings.filter(f => f.severity === 'watch').length, info: findings.filter(f => f.severity === 'info').length, ...(shown.length < findings.length ? { omitted: findings.length - shown.length } : {}) },
  versions: {
    claudeCode: { installed: claudeVersion, compatibility: pins?.claudeCompatibility ?? null, fixture: pins?.fixtures?.find(fixture => fixture.provider === 'claude' && fixture.models)?.reportsVersion ?? null },
    codex: { installed: codexVersion, protocolBaseline: pins?.codexProtocolBaseline ?? null, versionGate: pins?.codexVersionGate ?? null, generatorExpected: pins?.codexGeneratorExpected ?? null },
    llamaCppLatestRelease: sources?.['llama-cpp-release']?.tagName ?? null,
    qwen35_9bRevision: sources?.['qwen-3.5-9b-metadata']?.sha ?? null
  },
  findings: shown,
  relevantTests
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(0))
