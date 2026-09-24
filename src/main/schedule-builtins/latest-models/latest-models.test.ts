import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LATEST_MODELS_BUILTIN } from './index'
import { SCHEDULE_PROMPT_MAX, SCHEDULE_SCRIPT_MAX_BYTES, SCHEDULE_SCRIPT_MAX_PER_TASK, SCHEDULE_SCRIPT_MAX_TIMEOUT_SEC, SCHEDULE_SCRIPT_NAME } from '../../../shared/schedules'

const here = dirname(fileURLToPath(import.meta.url))
const temps: string[] = []
const temp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), `conductor-latest-models-${prefix}-`)); temps.push(dir); return dir }
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

interface Run { code: number; stdout: string; stderr: string }
/** Runs one of the task's scripts the way the schedule runner does: `node <file>` with cwd = the project folder. */
function run(script: string, cwd: string, env: Record<string, string> = {}, timeout = 30_000): Promise<Run> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONDUCTOR_')))
  return new Promise(resolve => execFile(process.execPath, [join(here, script)], { cwd, env: { ...clean, ...env }, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })))
}
const write = (root: string, path: string, text: string): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }

// ---------------------------------------------------------------------------------------------
// A synthetic checkout, as src/ looked before commit 818c29b (or after it)
// ---------------------------------------------------------------------------------------------
const EFFORTS = "['low', 'medium', 'high', 'xhigh', 'max']"
const CLAUDE_BEFORE_818C29B = [
  "  { id: 'default', label: 'Default for account' },",
  "  { id: 'opus[1m]', label: 'Claude Opus (1M context)' },",
  "  { id: 'claude-fable-5-1[1m]', label: 'Claude Fable' },",
  "  { id: 'sonnet', label: 'Claude Sonnet' },",
  "  { id: 'haiku', label: 'Claude Haiku' }"
]
const CLAUDE_AFTER_818C29B = [
  "  { id: 'default', label: 'Default for account' },",
  "  { id: 'opus[1m]', label: 'Claude Opus 5.5 (1M context)' },",
  "  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },",
  "  { id: 'sonnet', label: 'Claude Sonnet 5' },",
  "  { id: 'haiku', label: 'Claude Haiku 4.5' }"
]
function checkout(claudeCatalog: string[], options: { compatibility?: string; fixture?: 'before' | 'after' } = {}): string {
  const root = temp('checkout')
  write(root, 'package.json', JSON.stringify({ name: 'conductor-desktop' }))
  write(root, 'src/main/agent-manager.ts', [
    'export const CODEX_EFFORTS: Array<{ id: AgentEffort; label: string }> = [',
    "  { id: 'auto', label: 'Automatic' },", "  { id: 'low', label: 'Low' },", "  { id: 'medium', label: 'Medium' },", "  { id: 'high', label: 'High' },",
    "  { id: 'xhigh', label: 'Extra high' },", "  { id: 'max', label: 'Maximum' },", "  { id: 'ultra', label: 'Ultra (delegating)' }", ']',
    "/** Labels are the CLI's own displayNames from model/list (0.155.1, 2026-09-21). */",
    'export const CODEX_MODELS = [',
    "  { id: 'default', label: 'Default for account' },", "  { id: 'gpt-6-astra', label: 'GPT-6-Astra' },", "  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },",
    "  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },", "  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }", ']',
    '', 'export const CLAUDE_MODELS = [', ...claudeCatalog, ']',
    "/** What a signed-in Grok 1.0.41 advertised on 2026-09-24. */", 'export const GROK_MODELS = [', "  { id: 'default', label: 'Default for account' },", "  { id: 'grok-4.7', label: 'Grok 4.7' }", ']',
    'const providers = {', '  claude: {', '    // Mirrors the ids the installed Claude Code 2.1.278 advertised on 2026-09-21 (initialize.models):', '    models: CLAUDE_MODELS,', '  }', '}', ''
  ].join('\n'))
  write(root, 'src/main/providers/claude.ts', `export const CLAUDE_COMPATIBILITY = '${options.compatibility ?? '2.1.278'}'\nconst capabilities = { effort: ${EFFORTS}, models: [] }\n// modelUsage is keyed by the configured name ('claude-opus-5[1m]')\n`)
  write(root, 'src/main/providers/codex.ts', [
    "export const CODEX_PROTOCOL_BASELINE = '0.155.1'",
    "const capabilities = { effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], models: [] }",
    "if (!/^0\\.155\\./.test(this.capabilities.runtimeVersion)) throw new Error('outside')",
    "if (settings.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(settings.effort)) throw new Error('Unsupported Codex reasoning effort')", ''
  ].join('\n'))
  write(root, 'src/shared/agent-model-selection.ts', "export const CLAUDE_FALLBACK_MODEL = 'opus[1m]'\nexport const CODEX_FALLBACK_MODEL = 'gpt-6-astra'\nexport const GROK_FALLBACK_MODEL = 'grok-4.7'\n")
  write(root, 'src/shared/structured-agent.ts', "  if (provider === 'claude') return /(?:^|[-/])(?:opus|fable)/i.test(model)\n  if (provider === 'codex') return /^gpt-6(?:[-.]|$)|astra/i.test(model)\n")
  write(root, 'src/shared/model-routing.ts', '  if (/gpt-6|astra|opus/.test(id)) return 3\n  if (/terra|sonnet|gpt-5\\.5/.test(id)) return 2\n  if (/luna|sol|haiku|mini|cheap/.test(id)) return 1\n')
  write(root, 'src/shared/project-backlog.ts', "  claude: { heavy: { model: 'opus', effort: 'high' }, medium: { model: 'sonnet', effort: 'medium' }, light: { model: 'haiku', effort: 'low' } }\n")
  write(root, 'src/main/agent-control.ts', "return entry?.models.find(model => model.id === 'opus[1m]')?.id ?? entry?.models.find(model => model.id === 'opus')?.id\n")
  const pinned = claudeCatalog.map(line => /id: '([^']+)'/.exec(line)?.[1]).map(id => `'${id}'`).join(', ')
  write(root, 'src/main/agent-manager.test.ts', `expect(CLAUDE_MODELS.map((model) => model.id)).toEqual([${pinned}])\n`)
  for (const file of ['src/main/providers/claude.test.ts', 'src/main/providers/claude-ui-fixture.test.ts', 'src/main/providers/codex.test.ts', 'src/shared/agent-model-selection.test.ts']) write(root, file, '// placeholder\n')
  write(root, 'scripts/smoke-capability-sweep.mjs', `const families = { claude: [${pinned.replace("'default', ", '')}] }\n`)
  write(root, 'scripts/generate-codex-protocol.mjs', "const expected = '0.155.1'\n")
  const before = options.fixture !== 'after'
  write(root, 'scripts/fixtures/swarm-capabilities-claude.mjs', [
    `/** SYNTHETIC fixture. It answers initialize with the model catalog the installed Claude Code ${before ? '2.1.278' : '2.1.281'}`,
    ` *  advertised to this account on ${before ? '2026-09-21' : '2026-09-24'}. */`,
    `if (process.argv.includes('--version')) { console.log('${before ? '2.1.278' : '2.1.281'} (Claude Code)'); process.exit(0) }`,
    `const EFFORTS = ${EFFORTS}`,
    'export const CLAUDE_MODELS = [',
    `  { value: 'default', resolvedModel: '${before ? 'claude-opus-5[1m]' : 'claude-opus-5-5[1m]'}', displayName: 'Default (recommended)', description: 'shortened', supportsEffort: true, supportedEffortLevels: EFFORTS },`,
    `  { value: 'opus[1m]', resolvedModel: '${before ? 'claude-opus-5[1m]' : 'claude-opus-5-5[1m]'}', displayName: 'Opus (1M context)', description: 'shortened', supportsEffort: true, supportedEffortLevels: EFFORTS },`,
    `  { value: '${before ? 'claude-fable-5-1[1m]' : 'claude-fable-5-1'}', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'shortened', supportsEffort: true, supportedEffortLevels: EFFORTS },`,
    "  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'shortened', supportsEffort: true, supportedEffortLevels: EFFORTS },",
    "  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5' },",
    "  // Not advertised by the real CLI: the CLI's future shape.",
    "  { value: 'swarm-unknown-model' }",
    ']', ''
  ].join('\n'))
  return root
}

// What Claude Code 2.1.281 and codex-cli 0.155.1 answered on 2026-09-24 (initialize, model/list).
const EFFORT_LIST = ['low', 'medium', 'high', 'xhigh', 'max']
const claude281 = (): Array<Record<string, unknown>> => [
  { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks', supportsEffort: true, efforts: EFFORT_LIST, isDefault: false },
  { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks', supportsEffort: true, efforts: EFFORT_LIST, isDefault: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers', supportsEffort: null, efforts: [], isDefault: false },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks', supportsEffort: true, efforts: EFFORT_LIST, isDefault: false },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportsEffort: true, efforts: EFFORT_LIST, isDefault: false }
]
const codexModel = (id: string, displayName: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id, displayName, description: `${displayName} model.`, hidden: false, isDefault: false, efforts: [...EFFORT_LIST, 'ultra'], defaultEffort: 'medium', upgrade: null, retirementAt: null, ...extra })
const codex1551 = (): Array<Record<string, unknown>> => [
  codexModel('gpt-5.5', 'GPT-5.5', { description: 'Legacy coding model.', upgrade: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh'] }),
  codexModel('gpt-5.6-luna', 'GPT-5.6-Luna', { efforts: EFFORT_LIST }),
  codexModel('gpt-5.6-sol', 'GPT-5.6-Sol'),
  codexModel('gpt-5.6-terra', 'GPT-5.6-Terra'),
  codexModel('gpt-6-astra', 'GPT-6-Astra', { isDefault: true })
]
const catalogsOut = (claude: object, codex: object): string => JSON.stringify({ claude, codex }, null, 2)
const SOURCES_OUT = JSON.stringify({ sources: {
  'anthropic-models': { modelIds: ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-opus-4-1', 'claude-opus-5-5', 'claude-sonnet-5'] },
  'llama-cpp-release': { tagName: 'b9000' },
  'openai-models': { modelIds: ['gpt-4o', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-6-astra', 'o3'] },
  'qwen-3.5-9b-metadata': { sha: 'c202236235762e1c871ad0ccb60c8ee5ba337b9a' }
} })

interface Finding { severity: 'action' | 'watch' | 'info'; area: string; finding: string; evidence: string; proposedEdit?: string; files?: string[] }
interface Report { summary: Record<string, number>; versions: Record<string, unknown>; findings: Finding[]; relevantTests: string[] }

/** Runs conductor-pins in `root`, stores its output with the given other inputs, and runs the report. */
async function report(root: string, inputs: { catalogs?: string; sources?: string } = {}): Promise<{ run: Run; report: Report; runDir: string }> {
  const runDir = temp('run')
  const pins = await run('conductor-pins.mjs', root)
  expect(pins.code).toBe(0)
  writeFileSync(join(runDir, 'conductor-pins.out'), pins.stdout)
  if (inputs.catalogs !== undefined) writeFileSync(join(runDir, 'cli-catalogs.out'), inputs.catalogs)
  if (inputs.sources !== undefined) writeFileSync(join(runDir, 'primary-sources.out'), inputs.sources)
  const result = await run('compatibility-report.mjs', root, { CONDUCTOR_SCHEDULE_RUN_DIR: runDir })
  expect(result.code).toBe(0)
  return { run: result, report: JSON.parse(result.stdout) as Report, runDir }
}

describe('latest models: conductor-pins', { timeout: 30_000 }, () => {
  it('reads catalogs, pins, fixtures and hard-coded ids from source text', async () => {
    const root = checkout(CLAUDE_BEFORE_818C29B)
    const result = await run('conductor-pins.mjs', root)
    expect(result.code).toBe(0)
    const pins = JSON.parse(result.stdout)
    expect(pins.catalogs.claude.map((entry: { id: string }) => entry.id)).toEqual(['default', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku'])
    expect(pins.catalogs.claude[1].label).toBe('Claude Opus (1M context)')
    expect(pins).toMatchObject({ claudeCompatibility: '2.1.278', codexProtocolBaseline: '0.155.1', codexVersionGate: '0.155.x', codexGeneratorExpected: '0.155.1', fallbacks: { claude: 'opus[1m]', codex: 'gpt-6-astra' } })
    expect(pins.catalogProvenance.claude).toEqual({ version: '2.1.278', date: '2026-09-21' })
    expect(pins.efforts.claudeAdapter).toEqual(EFFORT_LIST)
    const fixture = pins.fixtures.find((entry: { file: string }) => entry.file === 'scripts/fixtures/swarm-capabilities-claude.mjs')
    expect(fixture).toMatchObject({ reportsVersion: '2.1.278', headerVersions: ['2.1.278'], headerDates: ['2026-09-21'] })
    expect(fixture.models.find((model: { value: string }) => model.value === 'opus[1m]')).toMatchObject({ resolvedModel: 'claude-opus-5[1m]', efforts: EFFORT_LIST, synthetic: false })
    expect(fixture.models.find((model: { value: string }) => model.value === 'swarm-unknown-model').synthetic).toBe(true)
    expect(pins.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'opus[1m]', file: 'src/main/agent-control.ts', kind: 'source', comment: false }),
      expect.objectContaining({ id: 'claude-fable-5-1[1m]', file: 'scripts/smoke-capability-sweep.mjs', kind: 'script' }),
      expect.objectContaining({ id: 'claude-fable-5-1[1m]', file: 'src/main/agent-manager.test.ts', kind: 'test' }),
      expect.objectContaining({ id: 'claude-opus-5[1m]', file: 'src/main/providers/claude.ts', comment: true })
    ]))
    expect((await run('conductor-pins.mjs', root)).stdout).toBe(result.stdout)
  })

  it('prints {"checkout":false} outside a Conductor checkout', async () => {
    const root = temp('other')
    write(root, 'package.json', JSON.stringify({ name: 'something-else' }))
    const result = await run('conductor-pins.mjs', root)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ checkout: false })
  })

  it('still reads the real checkout it ships in', async () => {
    const result = await run('conductor-pins.mjs', process.cwd())
    expect(result.code).toBe(0)
    const pins = JSON.parse(result.stdout)
    expect(pins.checkout).toBe(true)
    expect(pins.catalogs.claude.length).toBeGreaterThan(1)
    expect(pins.catalogs.codex.length).toBeGreaterThan(1)
    expect(pins.claudeCompatibility).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pins.codexVersionGate).toMatch(/^\d+\.\d+\.x$/)
    expect(pins.fixtures.some((fixture: { models?: unknown[] }) => fixture.models?.length)).toBe(true)
  })
})

describe('latest models: compatibility report', { timeout: 30_000 }, () => {
  it('turns the 2026-09-24 situation into the action findings a human had to find by hand (818c29b)', async () => {
    const root = checkout(CLAUDE_BEFORE_818C29B)
    const { report: out } = await report(root, { catalogs: catalogsOut({ version: '2.1.281', missingFlags: [], models: claude281() }, { version: '0.155.1', models: codex1551() }), sources: SOURCES_OUT })
    const actions = out.findings.filter(finding => finding.severity === 'action')
    const opus = actions.find(finding => finding.finding.includes('resolves opus[1m] to claude-opus-5-5[1m] (Opus 5.5)'))
    expect(opus?.finding).toContain("CLAUDE_MODELS labels it 'Claude Opus (1M context)'")
    expect(opus?.finding).toContain("label -> 'Claude Opus 5.5 (1M context)'")
    expect(opus?.proposedEdit).toBe("In CLAUDE_MODELS in src/main/agent-manager.ts: { id: 'opus[1m]', label: 'Claude Opus (1M context)' } -> { id: 'opus[1m]', label: 'Claude Opus 5.5 (1M context)' }")
    const fable = actions.find(finding => finding.finding.includes("no longer offers 'claude-fable-5-1[1m]'"))
    expect(fable?.finding).toContain("it offers 'claude-fable-5-1' (Fable 5.1) instead")
    expect(fable?.proposedEdit).toContain("{ id: 'claude-fable-5-1[1m]', label: 'Claude Fable' } -> { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' }")
    expect(fable?.files).toEqual(['scripts/fixtures/swarm-capabilities-claude.mjs', 'scripts/smoke-capability-sweep.mjs', 'src/main/agent-manager.test.ts', 'src/main/agent-manager.ts'])
    // The renamed id is one finding, not also an "add claude-fable-5-1".
    expect(actions.filter(finding => finding.finding.includes("'claude-fable-5-1'") && finding.finding.includes('lacks it'))).toEqual([])
    expect(actions.map(finding => finding.proposedEdit)).toEqual(expect.arrayContaining([
      expect.stringContaining("label: 'Claude Sonnet 5'"), expect.stringContaining("label: 'Claude Haiku 4.5'")
    ]))
    const fixture = actions.find(finding => finding.area === 'fixtures')
    expect(fixture?.finding).toContain('scripts/fixtures/swarm-capabilities-claude.mjs (captured from Claude Code 2.1.278 on 2026-09-21)')
    expect(fixture?.finding).toContain('opus[1m] now resolves to claude-opus-5-5[1m] (fixture: claude-opus-5[1m])')
    expect(fixture?.finding).toContain("no longer offers 'claude-fable-5-1[1m]'")
    expect(fixture?.proposedEdit).toContain("'2.1.281 (Claude Code)'")
    const version = out.findings.find(finding => finding.area === 'claude-version')
    expect(version).toMatchObject({ severity: 'watch' })
    expect(version?.finding).toContain('Claude Code 2.1.281 is newer than the fixture-verified CLAUDE_COMPATIBILITY 2.1.278')
    expect(version?.proposedEdit).toContain("CLAUDE_COMPATIBILITY '2.1.278' -> '2.1.281'")
    expect(out.versions).toMatchObject({ claudeCode: { installed: '2.1.281', compatibility: '2.1.278', fixture: '2.1.278' }, llamaCppLatestRelease: 'b9000' })
    expect(out.relevantTests).toEqual(expect.arrayContaining(['src/main/agent-manager.test.ts', 'src/main/providers/claude.test.ts', 'src/main/providers/claude-ui-fixture.test.ts']))
    expect(out.summary.action).toBe(actions.length)
    // Nothing on the Codex side moved, and the older claude-opus-4-1 on Anthropic's page is not news.
    expect(out.findings.filter(finding => finding.area.startsWith('codex') && finding.severity !== 'info')).toEqual([])
    expect(out.findings.filter(finding => finding.area === 'primary-sources')).toEqual([])
  })

  it('names a label whose version is wrong', async () => {
    const root = checkout(CLAUDE_AFTER_818C29B.map(line => line.replace("'Claude Opus 5.5 (1M context)'", "'Claude Opus 5 (1M context)'")), { fixture: 'after' })
    const { report: out } = await report(root, { catalogs: catalogsOut({ version: '2.1.281', missingFlags: [], models: claude281() }, { version: '0.155.1', models: codex1551() }), sources: SOURCES_OUT })
    const actions = out.findings.filter(finding => finding.severity === 'action')
    expect(actions).toHaveLength(1)
    expect(actions[0]?.finding).toBe("Claude Code 2.1.281 resolves opus[1m] to claude-opus-5-5[1m] (Opus 5.5); CLAUDE_MODELS labels it 'Claude Opus 5 (1M context)', which names version 5. Edit src/main/agent-manager.ts: label -> 'Claude Opus 5.5 (1M context)'.")
  })

  it('calls an older Claude Code an action: Conductor refuses to run it', async () => {
    const root = checkout(CLAUDE_AFTER_818C29B, { fixture: 'after' })
    const { report: out } = await report(root, { catalogs: catalogsOut({ version: '2.1.270', missingFlags: [], models: claude281() }, { version: '0.155.1', models: codex1551() }), sources: SOURCES_OUT })
    const version = out.findings.find(finding => finding.area === 'claude-version')
    expect(version).toMatchObject({ severity: 'action' })
    expect(version?.finding).toContain('Claude Code 2.1.270 is older than CLAUDE_COMPATIBILITY 2.1.278: Conductor refuses to start Claude conversations')
  })

  it('reports Codex drift: a version outside the gate, a new model, a renamed one and an unknown id on the OpenAI page', async () => {
    const root = checkout(CLAUDE_AFTER_818C29B, { fixture: 'after' })
    const codex = codex1551().filter(model => model.id !== 'gpt-5.6-terra')
    codex.push(codexModel('gpt-6-terra', 'GPT-6-Terra'), codexModel('gpt-6-sol', 'GPT-6-Sol'))
    const sources = JSON.parse(SOURCES_OUT)
    sources.sources['openai-models'].modelIds.push('gpt-6.5-astra', 'gpt-5.4-pro', 'gpt-realtime-2')
    const { report: out } = await report(root, { catalogs: catalogsOut({ version: '2.1.281', missingFlags: [], models: claude281() }, { version: '0.156.0', models: codex }), sources: JSON.stringify(sources) })
    const text = out.findings.map(finding => `${finding.severity} ${finding.finding} | ${finding.proposedEdit ?? ''}`)
    expect(text).toEqual(expect.arrayContaining([
      expect.stringMatching(/^action Codex 0\.156\.0 is outside the tested 0\.155\.x protocol gate: Conductor refuses to connect/),
      expect.stringContaining("action Codex 0.156.0 no longer offers 'gpt-5.6-terra'; it offers 'gpt-6-terra' (GPT-6-Terra) in the same family."),
      expect.stringContaining("Add { id: 'gpt-6-sol', label: 'GPT-6-Sol' } to CODEX_MODELS in src/main/agent-manager.ts"),
      expect.stringContaining("watch OpenAI's model catalog names 'gpt-6.5-astra', which neither Codex 0.156.0 nor CODEX_MODELS knows"),
      expect.stringContaining("watch capabilityRank in src/shared/model-routing.ts ranks 'gpt-6-sol' 3")
    ]))
    const gate = out.findings.find(finding => finding.area === 'codex-version')
    expect(gate?.proposedEdit).toContain('/^0\\.156\\./')
  })

  it('prints byte-identical output when nothing changed', async () => {
    const root = checkout(CLAUDE_AFTER_818C29B, { compatibility: '2.1.281', fixture: 'after' })
    const inputs = { catalogs: catalogsOut({ version: '2.1.281', missingFlags: [], models: claude281() }, { version: '0.155.1', models: codex1551() }), sources: SOURCES_OUT }
    const first = await report(root, inputs)
    const second = await report(root, inputs)
    expect(second.run.stdout).toBe(first.run.stdout)
    expect(first.report.summary.action).toBe(0)
    expect(first.report.findings.filter(finding => finding.severity === 'watch')).toEqual([])
  })

  it('reports missing and unreadable inputs as findings instead of crashing', async () => {
    const runDir = temp('empty')
    const missing = await run('compatibility-report.mjs', runDir, { CONDUCTOR_SCHEDULE_RUN_DIR: runDir })
    expect(missing.code).toBe(0)
    const out = JSON.parse(missing.stdout) as Report
    expect(out.findings.map(finding => finding.finding)).toEqual([
      "cli-catalogs.out is missing, so what the installed CLIs advertise could not be compared this run.",
      "conductor-pins.out is missing, so Conductor's hard-coded catalogs and version pins could not be compared this run.",
      "primary-sources.out is missing, so the providers' own model pages could not be compared this run."
    ])
    expect(out.relevantTests).toEqual([])
    writeFileSync(join(runDir, 'cli-catalogs.out'), '{ not json')
    writeFileSync(join(runDir, 'primary-sources.out'), JSON.stringify({ sources: { 'openai-models': { unavailable: true }, 'anthropic-models': { modelIds: ['claude-opus-5-5'], stale: true } } }))
    const broken = JSON.parse((await run('compatibility-report.mjs', runDir, { CONDUCTOR_SCHEDULE_RUN_DIR: runDir })).stdout) as Report
    expect(broken.findings.map(finding => finding.finding)).toEqual(expect.arrayContaining([
      'cli-catalogs.out is empty or not valid JSON, so what the installed CLIs advertise could not be compared this run.',
      'anthropic-models has failed three or more runs in a row; its facts are from the last successful fetch.',
      'openai-models has not answered since its cache was empty, so it contributes no facts.'
    ]))
  })
})

// ---------------------------------------------------------------------------------------------
// primary-sources against a local server (CONDUCTOR_SCHEDULE_TEST_SOURCES, loopback only)
// ---------------------------------------------------------------------------------------------
describe('latest models: primary-sources', { timeout: 60_000 }, () => {
  let server: Server
  let base = ''
  let mode: 'ok' | 'fail' | 'redirect' | 'huge' = 'ok'
  const seen: Array<{ path: string; ifNoneMatch?: string }> = []
  const PAGES: Record<string, { type: string; body: string }> = {
    '/openai': { type: 'text/markdown', body: '# Models\n\nIf you are not sure, use [GPT-6 Astra](/api/docs/models/gpt-6-astra). Our cheapest GPT-5.4-class model.\n- [GPT-6 Sol](/api/docs/models/gpt-6-sol.md): Built for coding.\n- [o3](/api/docs/models/o3.md): Reasoning.\n- [codex-mini-latest](/api/docs/models/codex-mini-latest.md): Fast.\n- [GPT-6 Astra](/api/docs/models/gpt-6-astra.md): Flagship.\n' },
    '/anthropic': { type: 'text/markdown', body: '| Claude Opus 5.5 | claude-opus-5-5 | anthropic.claude-opus-5-5-20260101-v1:0 | claude-opus-5-5@20260101 |\n| Claude Sonnet 5 | claude-sonnet-5 |\nUse Claude Code (claude-code) with claude-haiku-4-5-20251001.\n' },
    '/llama': { type: 'application/json', body: JSON.stringify({ tag_name: 'b9000', body: 'release notes that must never be printed' }) },
    '/qwen': { type: 'application/json', body: JSON.stringify({ sha: 'c202236235762e1c871ad0ccb60c8ee5ba337b9a', lastModified: '2026-09-01T00:00:00.000Z' }) }
  }
  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const path = request.url ?? '/'
      seen.push({ path, ifNoneMatch: request.headers['if-none-match'] as string | undefined })
      const page = PAGES[path]
      if (!page) { response.writeHead(404).end(); return }
      if (mode === 'fail') { response.writeHead(503).end('down'); return }
      if (mode === 'redirect') { response.writeHead(302, { location: 'http://example.com/moved' }).end(); return }
      if (mode === 'huge') { response.writeHead(200, { 'content-type': page.type }); response.end('x'.repeat(300 * 1024)); return }
      const etag = `"${path.slice(1)}-v1"`
      if (request.headers['if-none-match'] === etag) { response.writeHead(304, { etag }).end(); return }
      response.writeHead(200, { 'content-type': page.type, etag }).end(page.body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))
  const overrides = (): string => JSON.stringify({ 'openai-models': `${base}/openai`, 'anthropic-models': `${base}/anthropic`, 'llama-cpp-release': `${base}/llama`, 'qwen-3.5-9b-metadata': `${base}/qwen` })

  it('extracts ids only, revalidates with ETags and prints cached facts through failures until they go stale', async () => {
    const stateDir = temp('state')
    const env = { CONDUCTOR_SCHEDULE_STATE_DIR: stateDir, CONDUCTOR_SCHEDULE_TEST_SOURCES: overrides() }
    mode = 'ok'
    const fresh = await run('primary-sources.mjs', stateDir, env)
    expect(fresh.code).toBe(0)
    expect(JSON.parse(fresh.stdout)).toEqual({ sources: {
      'anthropic-models': { modelIds: ['claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-opus-5-5-20260101', 'claude-sonnet-5'] },
      'llama-cpp-release': { tagName: 'b9000' },
      'openai-models': { modelIds: ['codex-mini-latest', 'gpt-6-astra', 'gpt-6-sol', 'o3'] },
      'qwen-3.5-9b-metadata': { sha: 'c202236235762e1c871ad0ccb60c8ee5ba337b9a' }
    } })
    expect(fresh.stdout).not.toContain('release notes')

    seen.length = 0
    const revalidated = await run('primary-sources.mjs', stateDir, env)
    expect(seen.map(request => request.ifNoneMatch).sort()).toEqual(['"anthropic-v1"', '"llama-v1"', '"openai-v1"', '"qwen-v1"'])
    expect(revalidated.stdout).toBe(fresh.stdout)

    mode = 'fail'
    const blip = await run('primary-sources.mjs', stateDir, env)
    expect(blip.code).toBe(0)
    expect(blip.stdout).toBe(fresh.stdout)
    expect(blip.stderr).toContain('HTTP 503')
    mode = 'redirect'
    const moved = await run('primary-sources.mjs', stateDir, env)
    expect(moved.stdout).toBe(fresh.stdout)
    expect(moved.stderr).toContain('redirected (HTTP 302)')
    mode = 'huge'
    const third = await run('primary-sources.mjs', stateDir, env)
    expect(third.stderr).toContain('response exceeded 256 KB')
    expect(JSON.parse(third.stdout).sources['openai-models']).toEqual({ modelIds: ['codex-mini-latest', 'gpt-6-astra', 'gpt-6-sol', 'o3'], stale: true })

    mode = 'ok'
    const recovered = await run('primary-sources.mjs', stateDir, env)
    expect(recovered.stdout).toBe(fresh.stdout)
  })

  it('fails only when no source has fresh or cached facts', async () => {
    const stateDir = temp('state-empty')
    mode = 'fail'
    const result = await run('primary-sources.mjs', stateDir, { CONDUCTOR_SCHEDULE_STATE_DIR: stateDir, CONDUCTOR_SCHEDULE_TEST_SOURCES: overrides() })
    mode = 'ok'
    expect(result.code).toBe(1)
    expect(Object.values(JSON.parse(result.stdout).sources)).toEqual([{ unavailable: true }, { unavailable: true }, { unavailable: true }, { unavailable: true }])
  })

  it('refuses a test override that names anything but a loopback URL', async () => {
    const stateDir = temp('state-refused')
    const result = await run('primary-sources.mjs', stateDir, { CONDUCTOR_SCHEDULE_STATE_DIR: stateDir, CONDUCTOR_SCHEDULE_TEST_SOURCES: JSON.stringify({ 'openai-models': 'https://example.com/models' }) })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: 'CONDUCTOR_SCHEDULE_TEST_SOURCES may only name loopback http URLs' })
  })
})

// ---------------------------------------------------------------------------------------------
// cli-catalogs against fake CLIs (a .cmd shim on Windows, which also covers the cmd.exe path)
// ---------------------------------------------------------------------------------------------
const FAKE_CLI = `import { appendFileSync } from 'node:fs'
import readline from 'node:readline'
const [kind, ...args] = process.argv.slice(2)
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ kind, args, pid: process.pid }) + '\\n')
if (args.includes('--version')) { console.log(kind === 'claude' ? '2.1.281 (Claude Code)' : 'codex-cli 0.155.1'); process.exit(0) }
if (args.includes('--help')) { console.log('--print --input-format --output-format --verbose --include-partial-messages --permission-prompt-tool --permission-mode --forward-subagent-text --no-session-persistence --strict-mcp-config --mcp-config'); process.exit(0) }
if (process.env.FAKE_EXIT === kind) process.exit(3)
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const visible = [{ id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6-Sol', description: 'Workhorse.', hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low', upgrade: null, availabilityNux: { message: 'volatile' } },
  { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Frontier.', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium', upgrade: null }]
const hidden = { id: 'gpt-reserve', model: 'gpt-reserve', displayName: 'GPT-Reserve', description: 'Hidden.', hidden: true, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', upgrade: null }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (kind === 'claude' && message.type === 'control_request' && message.request.subtype === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { pid: process.pid, account: { email: 'owner@example.com' }, models: [
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5.5 with 1M context', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true }] } } })
  if (kind === 'codex' && message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake/' + process.pid } })
  if (kind === 'codex' && message.method === 'model/list') send({ id: message.id, result: { data: message.params.includeHidden ? [...visible, hidden] : visible, nextCursor: null } })
}).on('close', () => process.exit(0))
`
function fakeClis(): { dir: string; log: string; env: Record<string, string> } {
  const dir = temp('fake-cli')
  const script = join(dir, 'fake-cli.mjs')
  writeFileSync(script, FAKE_CLI)
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  const shim = (kind: string): string => {
    if (process.platform === 'win32') { const file = join(dir, `${kind}.cmd`); writeFileSync(file, `@echo off\r\n"${process.execPath}" "${script}" ${kind} %*\r\n`); return file }
    const file = join(dir, kind)
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${kind} "$@"\n`)
    chmodSync(file, 0o755)
    return file
  }
  return { dir, log, env: { CONDUCTOR_CLAUDE_PATH: shim('claude'), CONDUCTOR_CODEX_PATH: shim('codex'), FAKE_LOG: log } }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

describe('latest models: cli-catalogs', () => {
  it('asks both CLIs for their catalogs without a turn, prints only stable fields and leaves no process behind', async () => {
    const fake = fakeClis()
    const result = await run('cli-catalogs.mjs', fake.dir, fake.env, 60_000)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      claude: { missingFlags: ['--permission-prompts'], version: '2.1.281', models: [
        { description: 'Opus 5.5 with 1M context', displayName: 'Default (recommended)', efforts: ['low', 'high'], isDefault: true, resolvedModel: 'claude-opus-5-5[1m]', supportsEffort: true, value: 'default' },
        { description: 'Sonnet 5', displayName: 'Sonnet', efforts: ['low', 'high'], isDefault: false, resolvedModel: 'claude-sonnet-5', supportsEffort: true, value: 'sonnet' }
      ] },
      codex: { version: '0.155.1', models: [
        { defaultEffort: 'medium', description: 'Frontier.', displayName: 'GPT-6-Astra', efforts: ['medium'], hidden: false, id: 'gpt-6-astra', isDefault: true, retirementAt: null, upgrade: null },
        { defaultEffort: 'low', description: 'Workhorse.', displayName: 'GPT-6-Sol', efforts: ['low', 'high'], hidden: false, id: 'gpt-6-sol', isDefault: false, retirementAt: null, upgrade: null },
        { defaultEffort: 'medium', description: 'Hidden.', displayName: 'GPT-Reserve', efforts: [], hidden: true, id: 'gpt-reserve', isDefault: false, retirementAt: null, upgrade: null }
      ] }
    })
    expect(result.stdout).not.toMatch(/owner@example\.com|volatile|fake\//)
    const calls = readFileSync(fake.log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; args: string[]; pid: number })
    const session = calls.find(call => call.kind === 'claude' && call.args.includes('--input-format'))
    expect(session?.args).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']))
    expect(calls.find(call => call.kind === 'codex' && call.args[0] === 'app-server')?.args).toEqual(['app-server', '--listen', 'stdio://'])
    expect(calls.map(call => call.pid).filter(alive)).toEqual([])
    expect((await run('cli-catalogs.mjs', fake.dir, fake.env, 60_000)).stdout).toBe(result.stdout)
  }, 120_000)

  it('reports a CLI that exits early or is missing as that side\'s error, and fails only when neither answers', async () => {
    const fake = fakeClis()
    const oneSide = await run('cli-catalogs.mjs', fake.dir, { ...fake.env, FAKE_EXIT: 'claude' }, 60_000)
    expect(oneSide.code).toBe(0)
    const out = JSON.parse(oneSide.stdout)
    expect(out.claude).toEqual({ version: '2.1.281', missingFlags: ['--permission-prompts'], error: 'exited before answering initialize (code 3)' })
    expect(out.codex.models).toHaveLength(3)
    const neither = await run('cli-catalogs.mjs', fake.dir, { FAKE_LOG: fake.log, CONDUCTOR_CLAUDE_PATH: join(fake.dir, 'missing-claude.exe'), CONDUCTOR_CODEX_PATH: join(fake.dir, 'missing-codex.exe') }, 60_000)
    expect(neither.code).toBe(1)
    const failed = JSON.parse(neither.stdout)
    expect(failed.claude.error).toMatch(/--version/)
    expect(failed.codex.error).toMatch(/--version/)
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------
// offline-tests: selection only (running vitest here would nest a whole test run)
// ---------------------------------------------------------------------------------------------
describe('latest models: offline-tests', { timeout: 30_000 }, () => {
  it('runs nothing outside a checkout or when the report names no safe test file', async () => {
    const other = temp('offline-other')
    expect(JSON.parse((await run('offline-tests.mjs', other)).stdout)).toEqual({ checkout: false })
    const root = checkout(CLAUDE_AFTER_818C29B)
    const runDir = temp('offline-run')
    writeFileSync(join(runDir, 'compatibility-report.out'), JSON.stringify({ relevantTests: ['../outside.test.ts', 'src/a b.test.ts', 'src/main/missing.test.ts', 'src/x.test.ts & calc'] }))
    const result = await run('offline-tests.mjs', root, { CONDUCTOR_SCHEDULE_RUN_DIR: runDir })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ ran: [], passed: 0, failed: 0, failures: [] })
  })
})

describe('latest models: restore point baseline', () => {
  it('reports CLI drift from the latest known-good local build', async () => {
    const root = checkout(CLAUDE_AFTER_818C29B), runDir = temp('restore-drift')
    writeFileSync(join(runDir, 'cli-catalogs.out'), catalogsOut({ version: '2.1.281', models: claude281() }, { version: '0.156.0', models: codex1551() }))
    writeFileSync(join(runDir, 'conductor-pins.out'), JSON.stringify({ checkout: false }))
    writeFileSync(join(runDir, 'primary-sources.out'), SOURCES_OUT)
    writeFileSync(join(runDir, 'restore-point-baseline.out'), JSON.stringify({ knownGood: { version: '0.2.0-local.8', createdAt: '2026-09-23T12:00:00Z', cliVersions: { claude: '2.1.278', codex: '0.155.1', grok: '1.0.41' } } }))
    const result = await run('compatibility-report.mjs', root, { CONDUCTOR_SCHEDULE_RUN_DIR: runDir })
    const out = JSON.parse(result.stdout) as Report
    expect(out.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: 'restore-point', finding: expect.stringContaining('CLI Claude Code changed since the last known-good build 0.2.0-local.8') }),
      expect.objectContaining({ area: 'restore-point', finding: expect.stringContaining('CLI Codex changed since the last known-good build 0.2.0-local.8') })
    ]))
  })
})

// ---------------------------------------------------------------------------------------------
// The built-in task spec
// ---------------------------------------------------------------------------------------------
describe('LATEST_MODELS_BUILTIN', () => {
  it('ships the scripts in order, byte for byte, within the store limits', () => {
    const scripts = LATEST_MODELS_BUILTIN.scripts
    expect(scripts.map(script => script.name)).toEqual(['cli-catalogs', 'conductor-pins', 'primary-sources', 'restore-point-baseline', 'compatibility-report', 'offline-tests'])
    expect(new Set(scripts.map(script => script.name)).size).toBe(scripts.length)
    expect(scripts.map(script => script.order)).toEqual([...scripts.map(script => script.order)].sort((a, b) => a - b))
    expect(new Set(scripts.map(script => script.order)).size).toBe(scripts.length)
    expect(scripts.length).toBeLessThanOrEqual(SCHEDULE_SCRIPT_MAX_PER_TASK)
    for (const script of scripts) {
      expect(script.content).toBe(readFileSync(join(here, `${script.name}.mjs`), 'utf8'))
      expect(script.name).toMatch(SCHEDULE_SCRIPT_NAME)
      expect(Buffer.byteLength(script.content, 'utf8')).toBeLessThan(SCHEDULE_SCRIPT_MAX_BYTES)
      expect(script.timeoutSec).toBeLessThanOrEqual(SCHEDULE_SCRIPT_MAX_TIMEOUT_SEC)
      expect(script).toMatchObject({ language: 'node', format: 'json' })
    }
    expect(scripts.filter(script => script.runWhen === 'changed').map(script => script.name)).toEqual(['offline-tests'])
    expect(scripts.reduce((sum, script) => sum + script.timeoutSec * 1000, 0)).toBeLessThan(LATEST_MODELS_BUILTIN.timeoutMs)
    expect(LATEST_MODELS_BUILTIN).toMatchObject({ kind: 'latest-models-methods', name: 'Latest models and CLI compatibility', everyMinutes: 1_440, timing: 'night', brain: true, timeoutMs: 30 * 60_000 })
    expect(LATEST_MODELS_BUILTIN.prompt.length).toBeLessThanOrEqual(SCHEDULE_PROMPT_MAX)
  })
})
