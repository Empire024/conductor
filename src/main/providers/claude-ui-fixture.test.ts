import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConductorDatabase } from '../database'
import { StructuredSessions } from '../structured-sessions'
import { ClaudeAdapter } from './claude'
import { JsonLineTransport } from './transport'
import type { AgentSpec } from '../../shared/models'

const panel = "export function updatePanel(el, pinned) {\n  var wasOpen = el.classList.contains('is-open');\n  var wasPinned = pinned;\n  el.classList.add('is-loading');\n}\n"
const edited = "export function updatePanel(el, pinned) {\n  el.classList.add('is-loading');\n}\n"
const panelTest = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { updatePanel } from './panel.mjs';\ntest('adds loading state without querying existing state', () => {\n  const added = [];\n  const el = { classList: { contains() { throw new Error('contains must not be called'); }, add(name) { added.push(name); } } };\n  updatePanel(el, true);\n  assert.deepEqual(added, ['is-loading']);\n});\n"
const roots: string[] = [], databases: ConductorDatabase[] = [], managers: StructuredSessions[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const database of databases.splice(0)) database.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  vi.unstubAllEnvs()
})
function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-claude-raw-ui-')); roots.push(root)
  const workspace = join(root, 'Disposable 日本語 smoke'); mkdirSync(workspace)
  writeFileSync(join(workspace, 'panel.mjs'), panel); writeFileSync(join(workspace, 'panel.test.mjs'), panelTest)
  const database = new ConductorDatabase(join(root, 'conductor.sqlite')); databases.push(database)
  const project = database.upsertProject(workspace, 'Synthetic raw Claude fixture')
  const spec: AgentSpec = { id: 'synthetic-claude', title: 'Synthetic Claude', projectId: project.id, sessionId: database.listSessions(project.id)[0]!.id, provider: 'claude', cwd: workspace }
  const manager = new StructuredSessions(database, () => process.execPath, vi.fn(), (_provider, options) => new ClaudeAdapter(options, {
    version: async () => '2.1.263', createTransport: (transport) => new JsonLineTransport({ ...transport, executable: process.execPath, args: [resolve('scripts/fixtures/fake-claude.mjs'), ...transport.args], environment: { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1' } })
  })); managers.push(manager)
  manager.ensure(spec)
  return { database, manager, spec, workspace, snapshot: () => database.structured.snapshot(spec.id)! }
}

describe('Claude raw Electron fixture through production adapter/controller/store — zero inference', () => {
  it('approves once through backend, records exact immutable two-line diff and actual Node command result', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'SYNTHETIC A: exercise the production Claude adapter', { permission: 'default', plan: false })
    await vi.waitFor(() => expect(f.snapshot().phase).toBe('waiting_approval'))
    expect(readFileSync(join(f.workspace, 'panel.mjs'), 'utf8')).toBe(panel)
    const interaction = f.snapshot().items.find((item) => item.data.type === 'interaction' && item.data.interaction.status === 'pending')!
    if (interaction.data.type !== 'interaction') throw new Error('Missing pending approval')
    const response = { sessionId: f.spec.id, runtimeId: f.snapshot().runtimeId, requestId: interaction.data.interaction.id, decision: 'allow' }
    await f.manager.respond(response)
    await expect(f.manager.respond(response)).rejects.toThrow('already submitted')
    await vi.waitFor(() => expect(f.snapshot().phase).toBe('completed'), { timeout: 5000 })
    expect(readFileSync(join(f.workspace, 'panel.mjs'), 'utf8')).toBe(edited)
    expect(readFileSync(join(f.workspace, 'panel.test.mjs'), 'utf8')).toBe(panelTest)
    const changes = f.snapshot().items.find((item) => item.data.type === 'changes')!
    if (changes.data.type !== 'changes') throw new Error('Missing real hook snapshot')
    const change = changes.data.changes[0]!
    expect(change).toMatchObject({ additions: 0, deletions: 2, status: 'applied' })
    expect(f.database.structured.artifact(f.spec.id, change.artifactId!)).toMatchObject({ before: panel, after: edited, canUndo: true })
    const command = f.snapshot().items.find((item) => item.data.type === 'tool' && item.data.name === 'Bash')!
    expect(command.data).toMatchObject({ status: 'completed', exitCode: 0 })
    if (command.data.type !== 'tool') throw new Error('Missing actual Node test output')
    expect(command.data.output).toContain('pass 1')
    const native = f.snapshot().nativeSessionId
    await f.manager.resume(f.spec.id)
    expect(f.snapshot().nativeSessionId).toBe(native)
    await f.manager.submit(f.spec.id, 'SYNTHETIC B: explicit synthetic continuation', { permission: 'default', plan: false })
    await vi.waitFor(() => expect(f.snapshot().phase).toBe('completed'))
    expect(f.snapshot().items.some((item) => item.data.type === 'text' && item.data.text.includes('Synthetic fixture continuation'))).toBe(true)
    expect(await f.manager.review(f.spec.id, change.artifactId!, 'undo')).toEqual({ outcome: 'reverted' })
    expect(readFileSync(join(f.workspace, 'panel.mjs'), 'utf8')).toBe(panel)
  })

  it('denies the real pending fake-runtime request and leaves the fixture bytes unchanged', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'SYNTHETIC A: deny pending edit', { permission: 'default', plan: false })
    await vi.waitFor(() => expect(f.snapshot().phase).toBe('waiting_approval'))
    const interaction = f.snapshot().items.find((item) => item.data.type === 'interaction')!
    if (interaction.data.type !== 'interaction') throw new Error('Missing permission request')
    await f.manager.respond({ sessionId: f.spec.id, runtimeId: f.snapshot().runtimeId, requestId: interaction.data.interaction.id, decision: 'deny' })
    await vi.waitFor(() => expect(f.snapshot().phase).toBe('completed'))
    expect(readFileSync(join(f.workspace, 'panel.mjs'), 'utf8')).toBe(panel)
    expect(f.snapshot().items.some((item) => item.data.type === 'changes')).toBe(false)
    expect(f.snapshot().items.find((item) => item.data.type === 'tool' && item.data.name === 'Edit')?.data).toMatchObject({ status: 'rejected' })
  })
})
