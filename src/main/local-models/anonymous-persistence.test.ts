import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ConductorDatabase } from '../database'
import { StructuredSessions } from '../structured-sessions'
import type { AdapterOptions, ProviderAdapter } from '../providers/adapter'
import type { AgentSpec, PaneTab, WorkspaceLayout } from '../../shared/models'
import type { ProviderCapabilities } from '../../shared/structured-agent'
import { anonymousConversations } from './anonymous'

/** local-anonymous-mode: after an anonymous conversation, no byte under userData carries its
 *  words; the identical run as an ordinary conversation is the control that finds them. */
const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.unstubAllEnvs(); anonymousConversations.clearForTests() })

const capabilities: ProviderCapabilities = { provider: 'local', runtimeVersion: 'fixture', adapterVersion: 1, authentication: 'api', textStreaming: true, steering: false, toolInputStreaming: false, toolOutputStreaming: false, approvals: false, questions: false, resume: false, fork: false, plans: false, permissions: ['read-only', 'accept-edits'], effort: [], models: [], limitations: [] }

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

/** Every file under userData that holds the marker, as UTF-8 or UTF-16 (SQLite may use either). */
const carriers = (userData: string, marker: string): string[] => filesUnder(userData).filter(path => {
  const bytes = readFileSync(path)
  return bytes.includes(Buffer.from(marker, 'utf8')) || bytes.includes(Buffer.from(marker, 'utf16le'))
})

async function converse(anonymous: boolean): Promise<{ userData: string; workspace: string; marker: string; reopened: { snapshot: unknown; tabIds: string[]; settings: string | null } }> {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const marker = 'ANONMARK' + randomUUID().replace(/-/g, '')
  const root = mkdtempSync(join(tmpdir(), 'conductor-anonymous-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const userData = join(root, 'userData'), workspace = join(root, 'workspace')
  mkdirSync(userData); mkdirSync(workspace)
  const dbPath = join(userData, 'conductor.db')
  let database = new ConductorDatabase(dbPath)
  const project = database.upsertProject(workspace, 'Anonymous fixture')
  const sessionId = database.listSessions(project.id)[0]!.id
  const id = 'agent_' + randomUUID().replace(/-/g, '').slice(0, 12)
  const spec: AgentSpec = { id, projectId: project.id, sessionId, provider: 'local', title: 'Dolphin', cwd: workspace, ...(anonymous ? { anonymous: true } : {}) }
  const factory = (_provider: unknown, opts: AdapterOptions): ProviderAdapter => ({
    provider: 'local', capabilities,
    start: async () => { opts.emit({ data: { type: 'session', phase: 'idle' } }) },
    submit: async (text: string) => {
      const turnId = 'turn-1'
      opts.emit({ turnId, data: { type: 'session', phase: 'running' } })
      // A tool that writes a workspace file: the file stays, Conductor's before/after copy may not.
      await opts.beforeTool?.('tool-1', [join(workspace, 'notes.txt')])
      writeFileSync(join(workspace, 'notes.txt'), `generated ${marker}\n`)
      opts.emit({ turnId, itemId: 'tool-1', data: { type: 'tool', name: 'write_file', status: 'completed', input: { path: 'notes.txt', content: `generated ${marker}` }, output: `wrote ${marker}` } })
      await opts.afterTool?.('tool-1', [join(workspace, 'notes.txt')], true)
      // Output over the inline limit goes to an artifact.
      opts.emit({ turnId, itemId: 'tool-2', data: { type: 'tool', name: 'run_command', status: 'completed', input: { command: `echo ${marker}` }, output: (marker + '\n').repeat(3000) } })
      await opts.localCheckpoint?.save({ messages: [{ role: 'user', content: text }, { role: 'assistant', content: `answer ${marker}` }] })
      opts.emit({ turnId, itemId: 'answer', data: { type: 'text', role: 'assistant', mode: 'snapshot', text: `The answer is ${marker}. CONDUCTOR_MEMORY[semantic]: ${marker} is a fact | cues: ${marker}` } })
      opts.emit({ turnId, data: { type: 'usage', inputTokens: 10, outputTokens: 20, source: 'provider', scope: 'turn' } })
      opts.emit({ turnId, data: { type: 'notice', message: `energy for ${marker}` } })
      opts.emit({ turnId, data: { type: 'session', phase: 'completed' } })
    },
    respond: async () => {}, interrupt: async () => {}, dispose: () => {}
  })
  let manager = new StructuredSessions(database, () => '', () => {}, factory)
  manager.ensure(spec)
  await manager.submit(id, `please remember ${marker}`, { permission: 'accept-edits', plan: false })
  await vi.waitFor(() => expect(database.structured.snapshot(id)?.phase).toBe('completed'))
  // The rest of the app's sinks, as they are reached for a conversation.
  try { database.remember({ projectId: project.id, kind: 'semantic', source: 'agent', gist: `${marker} captured`, origin: { agentSessionId: id, workspaceId: sessionId, title: 'Dolphin', provider: 'local' } }) } catch { /* refused for an anonymous conversation */ }
  database.recordMemoryRecall({ projectId: project.id, agentSessionId: id, itemId: 'item-1', prompt: `please remember ${marker}`, memoryIds: ['memory-1'] })
  database.setSetting('agentControlParent:' + id, JSON.stringify({ note: marker }))
  const tab: PaneTab = { id: 'pane-' + id, kind: 'agent', title: `Named ${marker}`, resourceId: id, state: { provider: 'local', model: 'local/dolphin', ...(anonymous ? { anonymous: true } : {}) } }
  const layout = database.getSession(sessionId)!.layout
  const withTab: WorkspaceLayout = { ...layout, root: layout.root.type === 'group' ? { ...layout.root, tabs: [...layout.root.tabs, tab], activeTabId: tab.id } : layout.root }
  database.saveSession(sessionId, withTab, null, [{ ...tab, id: 'closed-' + id }])
  database.saveRecoveryCheckpoint({ sessions: [{ id: sessionId, layout: withTab, maximizedGroupId: null, closedTabs: [] }], activeProjectId: project.id, activeSessionId: sessionId, focusedGroupIds: {}, sessionIdsByProject: {} })
  // While open, the conversation is fully usable in this process.
  expect(database.structured.snapshot(id)?.items.some(item => item.data.type === 'text' && item.data.text.includes(marker))).toBe(true)
  const live = database.getSession(sessionId)!.layout.root
  expect(live.type === 'group' && live.tabs.some(candidate => candidate.id === tab.id)).toBe(true)
  const tool = database.structured.snapshot(id)!.items.find(item => item.id === 'tool-2')
  if (tool?.data.type === 'tool' && tool.data.outputArtifactId) expect(database.structured.output(id, tool.data.outputArtifactId)).toContain(marker)
  manager.dispose(); database.close()
  // "Restart": a fresh process has no registry, so nothing anonymous can come back.
  anonymousConversations.clearForTests()
  database = new ConductorDatabase(dbPath)
  manager = new StructuredSessions(database, () => '', () => {}, factory)
  const reopenedLayout = database.getSession(sessionId)!.layout
  const reopened = { snapshot: database.structured.snapshot(id), tabIds: reopenedLayout.root.type === 'group' ? reopenedLayout.root.tabs.map(candidate => candidate.id) : [], settings: database.getSetting('agentControlParent:' + id) }
  manager.dispose(); database.close()
  return { userData, workspace, marker, reopened }
}

it('leaves no trace of an anonymous local conversation under userData, and is not restored', async () => {
  const run = await converse(true)
  expect(carriers(run.userData, run.marker)).toEqual([])
  expect(run.reopened.snapshot).toBeNull()
  expect(run.reopened.tabIds.some(tabId => tabId.startsWith('pane-agent_'))).toBe(false)
  expect(run.reopened.settings).toBeNull()
  // Files the model wrote are the owner's and stay.
  expect(readFileSync(join(run.workspace, 'notes.txt'), 'utf8')).toContain(run.marker)
})

it('control: the same ordinary conversation is found in the database and artifacts', async () => {
  const run = await converse(false)
  const found = carriers(run.userData, run.marker)
  expect(found.some(path => /conductor\.db/.test(path))).toBe(true)
  expect(found.some(path => /agent-artifacts/.test(path))).toBe(true)
  expect(run.reopened.snapshot).not.toBeNull()
})
