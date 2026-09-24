import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import { ClaudeAdapter, CLAUDE_COMPATIBILITY } from './providers/claude'
import { JsonLineTransport } from './providers/transport'
import { createApprovalRouting } from './approval-review-routing'
import { ApprovalReviews } from './approval-review'
import type { AgentControlDependencies } from './agent-control'
import type { AgentSpec } from '../shared/models'
import type { SessionSettings, TimelineItem } from '../shared/structured-agent'

// Native acceptance for the stronger-model review, offline: the worker, its wizard controller and
// the Opus reviewer are all real Claude adapters on scripts/fixtures/fake-claude.mjs, run through
// the production StructuredSessions, review gate and review routing. Zero inference.
const panel = "export function updatePanel(el, pinned) {\n  var wasOpen = el.classList.contains('is-open');\n  var wasPinned = pinned;\n  el.classList.add('is-loading');\n}\n"
const edited = "export function updatePanel(el, pinned) {\n  el.classList.add('is-loading');\n}\n"
const panelTest = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { updatePanel } from './panel.mjs';\ntest('adds loading state', () => {\n  const added = [];\n  updatePanel({ classList: { contains() { throw new Error('no'); }, add(value) { added.push(value); } } }, false);\n  assert.deepEqual(added, ['is-loading']);\n});\n"
const worker: SessionSettings = { permission: 'default', plan: false }
const wizard: SessionSettings = { permission: 'auto', plan: false, wizard: true, model: 'opus' }

const roots: string[] = [], databases: ConductorDatabase[] = [], managers: StructuredSessions[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const database of databases.splice(0)) database.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  vi.unstubAllEnvs()
})

function harness(decision: 'allow' | 'deny' | 'escalate' | 'perhaps') {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-review-acceptance-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  writeFileSync(join(workspace, 'panel.mjs'), panel); writeFileSync(join(workspace, 'panel.test.mjs'), panelTest)
  const database = new ConductorDatabase(join(root, 'conductor.sqlite')); databases.push(database)
  const project = database.upsertProject(workspace, 'Review acceptance')
  const spec = (id: string, title: string): AgentSpec => ({ id, title, projectId: project.id, sessionId: database.listSessions(project.id)[0]!.id, provider: 'claude', cwd: workspace })
  const manager = new StructuredSessions(database, () => process.execPath, vi.fn(), (_provider, options) => new ClaudeAdapter(options, {
    version: async () => CLAUDE_COMPATIBILITY,
    createTransport: transport => new JsonLineTransport({ ...transport, executable: process.execPath, args: [resolve('scripts/fixtures/fake-claude.mjs'), ...transport.args], environment: { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_REVIEWER_DECISION: decision } })
  })); managers.push(manager)
  const controller = spec('controller', 'Wizard controller'), coworker = spec('coworker', 'Coworker')
  manager.ensure(controller); manager.ensure(coworker)
  const opened: string[] = [], closed: string[] = []
  manager.setApprovalReviewRouting(createApprovalRouting({ database, sessions: manager } as unknown as AgentControlDependencies, {
    controller: id => id === coworker.id ? controller.id : undefined,
    localAndOpen: () => true,
    discoveredOpus: () => 'opus',
    open: async (parent, model) => {
      const id = `reviewer-${opened.length + 1}`
      manager.markApprovalReviewer(id)
      manager.ensure({ ...spec(id, 'Stronger approval review'), sessionId: parent.sessionId })
      manager.saveSettings(id, { permission: 'default', plan: false, model })
      opened.push(id)
      return id
    },
    close: async (_parent, id) => { closed.push(id) }
  }))
  const snapshot = (id = coworker.id) => database.structured.snapshot(id)!
  const approval = (): TimelineItem | undefined => snapshot().items.filter(item => item.data.type === 'interaction' && item.data.interaction.kind === 'approval').at(-1)
  const review = () => { const item = approval(); return item?.data.type === 'interaction' ? item.data.interaction.review : undefined }
  const record = () => new ApprovalReviews(database).get(project.id, review()!.id)!
  const start = async () => {
    manager.saveSettings(controller.id, wizard)
    await manager.submit(controller.id, 'SYNTHETIC B: owner asks the coworker to remove the two unused declarations from panel.mjs and run its test', wizard)
    await vi.waitFor(() => expect(snapshot(controller.id).phase).toBe('completed'), { timeout: 8000 })
    await manager.submit(coworker.id, 'SYNTHETIC A: remove the unused declarations from panel.mjs', worker)
  }
  return { manager, database, workspace, coworker, opened, closed, snapshot, approval, review, record, start }
}

describe('stronger-model review through real adapters (offline fixture, zero inference)', { timeout: 40000 }, () => {
  it('a wizard coworker\'s workspace edit is reviewed by an actual Opus turn and completes without the owner', async () => {
    const f = harness('allow')
    await f.start()
    await vi.waitFor(() => expect(f.snapshot().phase).toBe('completed'), { timeout: 15000 })
    expect(readFileSync(join(f.workspace, 'panel.mjs'), 'utf8')).toBe(edited)
    expect(f.snapshot().items.find(item => item.data.type === 'tool' && item.data.name === 'Bash')?.data).toMatchObject({ status: 'completed', exitCode: 0 })
    // One reviewer turn, closed after its decision; it never used a tool.
    expect(f.opened).toHaveLength(1)
    await vi.waitFor(() => expect(f.closed).toEqual(f.opened))
    expect(f.snapshot(f.opened[0]).items.some(item => ['tool', 'interaction'].includes(item.data.type))).toBe(false)
    // The owner never answered: the journal names the reviewer model and turn, no owner answer,
    // and the observed execution result of the one exact action.
    const record = f.record()
    expect(record).toMatchObject({ phase: 'executed', reviewerId: f.opened[0] })
    expect(record.ownerAnswer).toBeUndefined()
    expect(record.reviewerModel).toMatch(/opus/)
    expect(record.reviewerTurnId).toBeTruthy()
    expect(record.reviewerUsage).toBeTruthy()
    expect(record.history.map(entry => entry.phase)).toEqual(['approved', 'responding', 'responded', 'executed'])
    const item = f.approval()
    expect(item?.data.type === 'interaction' && item.data.interaction.status).toBe('resolved')
  })

  it('a reviewer denial answers the coworker, leaves the file alone and fences the target for later routes', async () => {
    const f = harness('deny')
    await f.start()
    await vi.waitFor(() => expect(f.snapshot().phase).toBe('completed'), { timeout: 15000 })
    expect(readFileSync(join(f.workspace, 'panel.mjs'), 'utf8')).toBe(panel)
    expect(f.record()).toMatchObject({ phase: expect.stringMatching(/^(responded|executed|execution-failed)$/), reviewerId: f.opened[0] })
    expect(f.record().ownerAnswer).toBeUndefined()
    expect(f.record().history.map(entry => entry.phase)).toContain('denied')
    expect(f.record().denied).toBe(true)
    // Another tool route to the same file is refused by the durable denial, before any card.
    const gate = (f.manager as unknown as { approvalGate: { guardTool(spec: AgentSpec, tool: string, input: unknown): Promise<string | undefined> } }).approvalGate
    expect(await gate.guardTool(f.database.structured.spec<AgentSpec>(f.coworker.id)!, 'Write', { file_path: 'panel.mjs', content: 'other route' })).toMatch(/durable approval denial/)
    expect(await gate.guardTool(f.database.structured.spec<AgentSpec>(f.coworker.id)!, 'Write', { file_path: 'other.mjs', content: 'unrelated' })).toBeUndefined()
  })

  it('only an explicit escalation reaches the owner, shown as an owner decision, and the owner\'s answer completes the turn', async () => {
    const f = harness('escalate')
    await f.start()
    await vi.waitFor(() => expect(f.review()?.phase).toBe('owner'), { timeout: 15000 })
    const item = f.approval()!
    if (item.data.type !== 'interaction') throw new Error('Missing approval')
    expect(item.data.interaction.title).toMatch(/^Owner decision: /)
    expect(item.data.interaction.status).toBe('pending')
    expect(readFileSync(join(f.workspace, 'panel.mjs'), 'utf8')).toBe(panel)
    await f.manager.respond({ sessionId: f.coworker.id, runtimeId: f.snapshot().runtimeId!, requestId: item.data.interaction.id, decision: 'allow' })
    await vi.waitFor(() => expect(f.snapshot().phase).toBe('completed'), { timeout: 15000 })
    expect(readFileSync(join(f.workspace, 'panel.mjs'), 'utf8')).toBe(edited)
    expect(f.record()).toMatchObject({ ownerAnswer: 'allow', reviewerId: f.opened[0] })
  })

  it('a reviewer answer outside the decision schema pauses the review and the owner can still answer', async () => {
    const f = harness('perhaps')
    await f.start()
    await vi.waitFor(() => expect(f.review()?.phase).toBe('paused'), { timeout: 15000 })
    const item = f.approval()!
    if (item.data.type !== 'interaction') throw new Error('Missing approval')
    expect(item.data.interaction.status).toBe('pending')
    expect(item.data.interaction.choices.find(choice => choice.id === 'allow')?.disabled).toBeFalsy()
    expect(f.record()).toMatchObject({ reviewerId: f.opened[0], reviewerModel: expect.stringMatching(/opus/), rationale: expect.stringMatching(/strict decision schema/) })
    expect(f.record().reviewerUsage).toBeTruthy()
    await f.manager.respond({ sessionId: f.coworker.id, runtimeId: f.snapshot().runtimeId!, requestId: item.data.interaction.id, decision: 'deny' })
    await vi.waitFor(() => expect(f.snapshot().phase).toBe('completed'), { timeout: 15000 })
    expect(readFileSync(join(f.workspace, 'panel.mjs'), 'utf8')).toBe(panel)
  })
})
