import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, win32 } from 'node:path'
import type { AgentSpec, LayoutNode, PaneTab, TerminalSpec, WorkspaceDocumentState, WorkspaceLayout } from '../shared/models'
import type { SessionArchive } from '../shared/session-archive'
import { sanitizeDiagnostic } from './structured-store'
import { LOCAL_MACHINE_ID } from '../shared/remote-control'
import type { SessionSettings } from '../shared/structured-agent'

export const MAX_SESSION_ARCHIVE_BYTES = 32 * 1024 * 1024
const idPattern = /^[a-zA-Z0-9_-]{1,160}$/
const documentIdPattern = /^document:(?:(?:project|detached):)?[a-zA-Z0-9_-]{1,160}:[a-zA-Z0-9_-]{1,160}$/
const kinds = new Set(['launcher', 'agent', 'terminal', 'file-tree', 'code', 'preview', 'browser', 'diff', 'tasks', 'memory', 'routine', 'logs'])
const providers = new Set(['codex', 'claude', 'gemini', 'qwen', 'kimi', 'local'])
function fail(why: string): never { throw new Error('Invalid session archive: ' + why) }
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : fail('expected an object')
const text = (value: unknown, max = 1000): string => typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : fail('invalid text')
const id = (value: unknown): string => typeof value === 'string' && idPattern.test(value) ? value : fail('invalid identity')
const draftId = (value: unknown): string => typeof value === 'string' && (idPattern.test(value) || documentIdPattern.test(value)) ? value : fail('invalid draft identity')
const machine = (value: unknown): string => id(value)
const list = (value: unknown, max = 10000): any[] => Array.isArray(value) && value.length <= max ? value : fail('invalid list')
const timestamp = (value: unknown): string => Number.isFinite(Date.parse(text(value, 80))) ? value as string : fail('invalid timestamp')
const absolutePath = (value: unknown): string => {
  const path = text(value, 32000)
  if (!isAbsolute(path) && !win32.isAbsolute(path)) fail('project path must be absolute')
  if (/^(?:\\\\[?.]\\|\/\/\?\/)/.test(path)) fail('device paths are not project references')
  return path
}
const relativePath = (value: unknown): string => {
  const path = text(value, 32000).replaceAll('\\', '/')
  if (path.startsWith('/') || win32.isAbsolute(path) || path.split('/').includes('..') || /[:\x00-\x1f]/.test(path)) fail('file path must stay within its project')
  return path
}
const browserUrl = (value: unknown): string => {
  const raw = text(value, 8000)
  if (raw === 'about:blank') return raw
  let parsed: URL
  try { parsed = new URL(raw) } catch { return fail('unsupported browser URL') }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail('unsupported browser URL')
  parsed.username = ''; parsed.password = ''; parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) if (/(?:token|secret|password|passcode|authorization|oauth|api[_-]?key|session|code)/i.test(key)) parsed.searchParams.set(key, '[REDACTED]')
  return parsed.toString()
}
const unique = (values: string[], label: string): void => { if (new Set(values).size !== values.length) fail('duplicate ' + label) }
const samePath = (left: string, right: string): boolean => win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
const activityStatuses = new Set(['preparing', 'running', 'awaiting_approval', 'completed', 'failed', 'rejected', 'interrupted'])

function settings(value: unknown): SessionSettings {
  const v = record(value)
  if (!['default', 'read-only', 'accept-edits', 'auto'].includes(v.permission) || typeof v.plan !== 'boolean') fail('invalid agent settings')
  if (v.sandbox !== undefined && !['inherit', 'read-only', 'workspace-write'].includes(v.sandbox)) fail('invalid sandbox setting')
  if (v.approvalPolicy !== undefined && !['inherit', 'untrusted', 'on-request', 'never'].includes(v.approvalPolicy)) fail('invalid approval setting')
  return {
    // Imported files never carry an authority grant into a provider process.
    permission: 'default',
    plan: v.plan,
    ...(v.model !== undefined ? { model: text(v.model, 200) } : {}),
    ...(v.effort !== undefined ? { effort: text(v.effort, 40) } : {}),
    sandbox: 'read-only',
    approvalPolicy: 'on-request'
  }
}

function timelineData(value: unknown): Record<string, any> {
  const original = record(value)
  const data = record(redactArchive(original))
  const optionalText = (key: string, max = 1000): Record<string, string> => data[key] === undefined ? {} : { [key]: text(data[key], max) }
  const attachment = (value: unknown): Record<string, unknown> => {
    const a = record(value)
    if (!['file', 'selection', 'editor', 'terminal', 'diagnostics', 'image'].includes(a.kind)) fail('invalid history attachment')
    if (a.remoteFile !== undefined) {
      const remote = record(a.remoteFile)
      if (a.kind !== 'file' || a.path !== undefined || a.content !== undefined) fail('invalid remote history attachment')
      return { id: id(a.id), kind: 'file', name: text(a.name, 1000), remoteFile: { machineId: machine(remote.machineId), projectId: id(remote.projectId), path: relativePath(remote.path) } }
    }
    if (a.startLine !== undefined && (!Number.isSafeInteger(a.startLine) || a.startLine < 1)) fail('invalid attachment line')
    if (a.endLine !== undefined && (!Number.isSafeInteger(a.endLine) || a.endLine < 1)) fail('invalid attachment line')
    return { id: id(a.id), kind: a.kind, name: text(a.name, 1000), ...(a.path !== undefined ? { path: relativePath(a.path) } : {}), ...(a.content !== undefined ? { content: text(a.content, MAX_SESSION_ARCHIVE_BYTES) } : {}), ...(a.startLine !== undefined ? { startLine: a.startLine } : {}), ...(a.endLine !== undefined ? { endLine: a.endLine } : {}) }
  }
  switch (data.type) {
    case 'text': {
      if (!['user', 'assistant', 'status'].includes(data.role) || !['delta', 'snapshot'].includes(data.mode)) fail('invalid text history item')
      const origin = data.origin === undefined ? {} : (() => { const o = record(data.origin); return { origin: { agentSessionId: id(o.agentSessionId), label: text(o.label, 1000) } } })()
      return { type: 'text', role: data.role, text: text(data.text, MAX_SESSION_ARCHIVE_BYTES), mode: data.mode, ...(data.attachments === undefined ? {} : { attachments: list(data.attachments, 1000).map(attachment) }), ...origin }
    }
    case 'tool': {
      if (!activityStatuses.has(data.status)) fail('invalid tool history item')
      if (data.exitCode !== undefined && !Number.isSafeInteger(data.exitCode)) fail('invalid tool exit code')
      if (data.durationMs !== undefined && (!Number.isFinite(data.durationMs) || data.durationMs < 0)) fail('invalid tool duration')
      if (data.outputMode !== undefined && !['delta', 'snapshot'].includes(data.outputMode)) fail('invalid tool output mode')
      const safe: Record<string, unknown> = { type: 'tool', name: text(data.name, 1000), status: ['running', 'preparing', 'awaiting_approval'].includes(data.status) ? 'interrupted' : data.status,
        ...optionalText('description', 10000), ...(data.input !== undefined ? { input: data.input } : {}), ...optionalText('inputDelta', MAX_SESSION_ARCHIVE_BYTES),
        ...optionalText('output', MAX_SESSION_ARCHIVE_BYTES), ...(data.outputMode !== undefined ? { outputMode: data.outputMode } : {}), ...optionalText('stderr', MAX_SESSION_ARCHIVE_BYTES),
        ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}), ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}) }
      if (data.outputArtifactId) {
        safe.output = (typeof safe.output === 'string' ? safe.output : '') + '\n[Private output file is not included in this session snapshot.]'
      }
      return safe
    }
    case 'interaction': {
      const interaction = record(data.interaction)
      id(interaction.id)
      if (!['approval', 'question'].includes(interaction.kind) || !['pending', 'resolved', 'expired'].includes(interaction.status)) fail('invalid interaction history item')
      const choices = list(interaction.choices, 1000).map(choice => { const c = record(choice); if (c.disabled !== undefined && typeof c.disabled !== 'boolean') fail('invalid interaction choice'); return { id: id(c.id), label: text(c.label, 1000), ...(c.description !== undefined ? { description: text(c.description, 10000) } : {}), ...(c.disabled !== undefined ? { disabled: c.disabled } : {}) } })
      const questions = interaction.questions === undefined ? undefined : list(interaction.questions, 1000).map(question => {
        const q = record(question)
        if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean' || q.isSecret !== undefined && typeof q.isSecret !== 'boolean' || q.allowCustom !== undefined && typeof q.allowCustom !== 'boolean') fail('invalid interaction question')
        const options = list(q.options, 1000).map(option => { const o = record(option); return { label: text(o.label, 1000), ...(o.description !== undefined ? { description: text(o.description, 10000) } : {}) } })
        return { id: id(q.id), ...(q.header !== undefined ? { header: text(q.header, 1000) } : {}), question: text(q.question, 10000), options, ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}), ...(q.isSecret !== undefined ? { isSecret: q.isSecret } : {}), ...(q.allowCustom !== undefined ? { allowCustom: q.allowCustom } : {}) }
      })
      let answers: Record<string, string | string[]> | undefined
      if (interaction.answers !== undefined) {
        const rawAnswers = record(interaction.answers)
        answers = Object.fromEntries(Object.entries(rawAnswers).map(([key, answer]) => [id(key), Array.isArray(answer) ? answer.map(value => text(value, 10000)) : text(answer, 10000)]))
      }
      return { type: 'interaction', interaction: { id: interaction.id, kind: interaction.kind, title: text(interaction.title, 1000), input: interaction.input, choices, ...(questions ? { questions } : {}), status: 'expired', ...(interaction.outcome !== undefined ? { outcome: text(interaction.outcome, 1000) } : {}), ...(answers ? { answers } : {}) } }
    }
    case 'changes':
      return { type: 'changes', changes: list(data.changes, 10000).map(value => {
        const change = record(value)
        if (!['add', 'update', 'delete', 'rename'].includes(change.kind) || !['proposed', 'applied', 'failed', 'rejected', 'reverted'].includes(change.status)) fail('invalid file change history item')
        for (const key of ['additions', 'deletions']) if (change[key] !== undefined && (!Number.isSafeInteger(change[key]) || change[key] < 0)) fail('invalid file change count')
        return { path: relativePath(change.path), ...(change.oldPath !== undefined ? { oldPath: relativePath(change.oldPath) } : {}), kind: change.kind, status: change.status,
          ...(change.patch !== undefined ? { patch: text(change.patch, MAX_SESSION_ARCHIVE_BYTES) } : {}), ...(change.additions !== undefined ? { additions: change.additions } : {}), ...(change.deletions !== undefined ? { deletions: change.deletions } : {}), limitation: 'Original change artifact is not included in this session snapshot.' }
      }) }
    case 'plan':
      return { type: 'plan', steps: list(data.steps, 10000).map(value => {
        const step = record(value)
        if (!['pending', 'in_progress', 'completed'].includes(step.status)) fail('invalid plan history item')
        return { text: text(step.text, 10000), status: step.status }
      }), ...optionalText('explanation', MAX_SESSION_ARCHIVE_BYTES) }
    case 'usage': {
      if (!['provider', 'estimate'].includes(data.source)) fail('invalid usage history item')
      const safe: Record<string, unknown> = { type: 'usage', source: data.source }
      for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheCreationTokens', 'reasoningTokens', 'totalTokens', 'costUsd']) if (data[key] !== undefined && (!Number.isFinite(data[key]) || data[key] < 0)) fail('invalid usage amount')
      for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheCreationTokens', 'reasoningTokens', 'totalTokens', 'costUsd']) if (data[key] !== undefined) safe[key] = data[key]
      if (data.scope !== undefined) { if (!['session', 'turn', 'message'].includes(data.scope)) fail('invalid usage scope'); safe.scope = data.scope }
      if (data.limits !== undefined) safe.limits = data.limits
      return safe
    }
    case 'error': return { type: 'error', message: text(data.message, MAX_SESSION_ARCHIVE_BYTES), ...optionalText('code', 1000) }
    case 'notice': return { type: 'notice', message: text(data.message, MAX_SESSION_ARCHIVE_BYTES), ...(data.payload !== undefined ? { payload: data.payload } : {}) }
    case 'subagent': {
      if (!activityStatuses.has(data.status)) fail('invalid subagent history item')
      if (data.detached !== undefined && typeof data.detached !== 'boolean' || data.outputTruncated !== undefined && typeof data.outputTruncated !== 'boolean') fail('invalid subagent history item')
      return { type: 'subagent', name: text(data.name, 1000), status: ['running', 'preparing', 'awaiting_approval'].includes(data.status) ? 'interrupted' : data.status,
        ...(data.nativeSessionId !== undefined ? { nativeSessionId: id(data.nativeSessionId) } : {}), ...(data.detached !== undefined ? { detached: data.detached } : {}),
        ...optionalText('output', MAX_SESSION_ARCHIVE_BYTES), ...(data.outputTruncated !== undefined ? { outputTruncated: data.outputTruncated } : {}), ...optionalText('outputError', MAX_SESSION_ARCHIVE_BYTES),
        ...optionalText('model', 200), ...optionalText('effort', 40), ...optionalText('modelProvider', 200) }
    }
    case 'review':
      if (!['kept', 'reverted'].includes(data.outcome)) fail('invalid review history item')
      return { type: 'notice', message: `Saved review result: ${data.outcome}. The private change artifact is not included.` }
    default: fail('invalid history item type')
  }
}

/** Exclude vault data by selecting fields, and redact credentials pasted into retained history. */
export function redactArchive(value: unknown): unknown {
  if (typeof value === 'string') return (sanitizeDiagnostic(value) as string)
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/((?:bearer|control[_-]?token|private[_-]?key|device[_-]?key|client[_-]?secret)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
  if (Array.isArray(value)) return value.map(redactArchive)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:env|environment|authorization|password|secret|credentials?|bearer|controlToken|accessToken|refreshToken|privateKey|deviceKey|grants?|tickets?)$/i.test(key)).map(([key, item]) => [key, redactArchive(item)]))
  return value
}

/** No generic settings table, environment, executable, command, grant or control binding is portable. */
function tab(value: unknown, tabIds: string[]): PaneTab {
  const v = record(value), tabId = id(v.id)
  tabIds.push(tabId)
  if (!kinds.has(v.kind)) fail('unknown tab kind')
  const state = v.state === undefined ? {} : record(v.state)
  const safe: Record<string, unknown> = {}
  for (const key of ['provider', 'model', 'effort']) if (state[key] !== undefined) safe[key] = text(state[key], 200)
  if (state.machineId !== undefined) safe.machineId = machine(state.machineId)
  if (safe.provider && !providers.has(safe.provider as string)) fail('unknown provider')
  if (state.path !== undefined) safe.path = relativePath(state.path)
  if (state.url !== undefined) {
    safe.url = browserUrl(state.url)
  }
  if (state.line !== undefined) { if (!Number.isSafeInteger(state.line) || state.line < 1) fail('invalid editor line'); safe.line = state.line }
  // CLI mounting launches a process; imported conversations always open in history/chat.
  if (v.kind === 'agent') { safe.viewMode = 'visual'; safe.continueOnLimit = false; safe.archiveDormant = true }
  if (v.kind === 'terminal' || v.kind === 'browser') safe.archiveDormant = true
  let resourceId: string | undefined
  if (v.resourceId !== undefined) resourceId = ['agent', 'terminal'].includes(v.kind) ? id(v.resourceId) : ['code', 'preview'].includes(v.kind) ? relativePath(v.resourceId) : text(v.resourceId)
  return { id: tabId, kind: v.kind, title: text(v.title), ...(resourceId ? { resourceId } : {}), state: safe, ...(v.tabGroupId ? { tabGroupId: id(v.tabGroupId) } : {}), ...(v.titleLocked === true ? { titleLocked: true } : {}) }
}
function layout(value: unknown, tabIds: string[]): WorkspaceLayout {
  const v = record(value), nodeIds: string[] = []
  if (v.version !== 1) fail('unsupported layout version')
  const visit = (value: unknown, depth: number): LayoutNode => {
    if (depth > 24) fail('layout is too deep')
    const node = record(value), nodeId = id(node.id); nodeIds.push(nodeId)
    if (node.type === 'group') {
      const tabs = list(node.tabs, 1000).map(item => tab(item, tabIds))
      const activeTabId = text(node.activeTabId, 160)
      if (activeTabId && !tabs.some(tab => tab.id === activeTabId)) fail('active tab is outside its group')
      const tabGroups = node.tabGroups === undefined ? undefined : list(node.tabGroups, 1000).map(value => {
        const group = record(value)
        if (!['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].includes(group.color) || typeof group.collapsed !== 'boolean') fail('invalid tab group')
        return { id: id(group.id), title: text(group.title), color: group.color, collapsed: group.collapsed }
      })
      unique(tabGroups?.map(group => group.id) ?? [], 'tab group')
      if (tabs.some(tab => tab.tabGroupId && !tabGroups?.some(group => group.id === tab.tabGroupId))) fail('missing tab group')
      return { type: 'group', id: nodeId, tabs, activeTabId, ...(tabGroups ? { tabGroups } : {}) }
    }
    if (node.type !== 'split' || !['horizontal', 'vertical'].includes(node.direction) || list(node.children, 2).length !== 2 || list(node.sizes, 2).length !== 2 || !node.sizes.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0)) fail('invalid split')
    return { type: 'split', id: nodeId, direction: node.direction, sizes: node.sizes, children: [visit(node.children[0], depth + 1), visit(node.children[1], depth + 1)] }
  }
  const root = visit(v.root, 0); unique(nodeIds, 'layout node')
  return { version: 1, root }
}

export function parseSessionArchive(raw: string): SessionArchive {
  if (Buffer.byteLength(raw) > MAX_SESSION_ARCHIVE_BYTES) fail('file exceeds 32 MiB')
  let value: unknown
  try { value = JSON.parse(raw) } catch { fail('file is not JSON') }
  const v = record(value)
  if (v.format !== 'conductor-session' || v.version !== 1) fail('unsupported format/version')
  const name = text(v.name, 200).trim(); if (!name) fail('missing name')
  const projects = list(v.projects, 1000).map(value => { const p = record(value), name = text(p.name).trim(); if (!name) fail('project name is empty'); return { id: id(p.id), name, path: absolutePath(p.path), createdAt: timestamp(p.createdAt), updatedAt: timestamp(p.updatedAt) } })
  unique(projects.map(p => p.id), 'project'); unique(projects.map(p => win32.normalize(p.path).toLowerCase()), 'project path')
  const tabIds: string[] = []
  const workspaceGroups = new Map<string, Set<string>>()
  const workspaces = list(v.workspaces).map(value => {
    const s = record(value)
    if (!projects.some(p => p.id === s.projectId)) fail('workspace points to missing project')
    const sessionId = id(s.id), parsedLayout = layout(s.layout, tabIds)
    const groups = new Set<string>()
    const collectGroups = (node: LayoutNode): void => { groups.add(node.id); if (node.type === 'split') node.children.forEach(collectGroups) }
    collectGroups(parsedLayout.root); workspaceGroups.set(sessionId, groups)
    const maximizedGroupId = s.maximizedGroupId === null ? null : id(s.maximizedGroupId)
    if (maximizedGroupId && !groups.has(maximizedGroupId)) fail('maximized group is outside its workspace')
    const name = text(s.name).trim(); if (!name) fail('workspace name is empty')
    return { id: sessionId, projectId: id(s.projectId), name, layout: parsedLayout, maximizedGroupId, closedTabs: list(s.closedTabs, 1000).map(value => tab(value, tabIds)), continueOnLimit: false, createdAt: timestamp(s.createdAt), updatedAt: timestamp(s.updatedAt) }
  })
  unique(workspaces.map(s => s.id), 'workspace')
  const detached = list(v.detached, 1000).map(value => {
    const d = record(value)
    if (!workspaces.some(s => s.id === d.sessionId && s.projectId === d.projectId)) fail('detached window crosses projects')
    const parsedLayout = layout(d.layout, tabIds)
    const groups = new Set<string>()
    const collectGroups = (node: LayoutNode): void => { groups.add(node.id); if (node.type === 'split') node.children.forEach(collectGroups) }
    collectGroups(parsedLayout.root)
    const maximizedGroupId = d.maximizedGroupId === null ? null : id(d.maximizedGroupId)
    if (maximizedGroupId && !groups.has(maximizedGroupId)) fail('detached maximized group is outside its layout')
    return { id: id(d.id), projectId: id(d.projectId), sessionId: id(d.sessionId), layout: parsedLayout, maximizedGroupId, createdAt: timestamp(d.createdAt), updatedAt: timestamp(d.updatedAt) }
  })
  unique(detached.map(d => d.id), 'detached window'); unique(tabIds, 'tab')
  const agents = list(v.agents).map(value => {
    const a = record(value), s = record(a.spec)
    const project = projects.find(p => p.id === s.projectId)
    if (!project || !workspaces.some(w => w.id === s.sessionId && w.projectId === s.projectId) || !providers.has(s.provider)) fail('invalid agent binding')
    const machineId = s.machineId === undefined ? LOCAL_MACHINE_ID : machine(s.machineId)
    const cwd = absolutePath(s.cwd)
    if (machineId === LOCAL_MACHINE_ID && !samePath(cwd, project.path)) fail('local agent cwd differs from project')
    const spec: AgentSpec = { id: id(s.id), projectId: id(s.projectId), sessionId: id(s.sessionId), provider: s.provider, title: text(s.title), cwd, machineId, continueOnLimit: false, ...(s.model ? { model: text(s.model, 200) } : {}), ...(s.effort ? { effort: text(s.effort, 40) as AgentSpec['effort'] } : {}) }
    let projection = a.projection === null ? null : record(a.projection)
    if (projection) {
      if (projection.sessionId !== spec.id || !Number.isSafeInteger(projection.sequence) || projection.sequence < 0) fail('invalid history identity/sequence')
      if (projection.nativeSessionId !== undefined) id(projection.nativeSessionId)
      const retainedSettings = settings(projection.settings)
      const sequence = projection.sequence as number
      const itemIds: string[] = [], itemSequences: number[] = []
      const items = list(projection.items, 100000).map(value => {
        // Timeline item identities are composite reducer keys (JSON tuples), not bare ids.
        const item = record(value), itemId = text(item.id, 600)
        if (!Number.isSafeInteger(item.sequence) || item.sequence < 0 || item.sequence > sequence) fail('invalid history sequence')
        itemIds.push(itemId); itemSequences.push(item.sequence)
        const optional = (key: string): Record<string, string> => item[key] === undefined ? {} : { [key]: text(item[key], 1000) }
        return { id: itemId, runtimeId: '', sequence: item.sequence, timestamp: timestamp(item.timestamp), data: timelineData(item.data), ...optional('turnId'), ...optional('nativeItemId'), ...optional('parentId'), ...optional('requestId') }
      })
      unique(itemIds, 'history item'); unique(itemSequences.map(String), 'history sequence')
      // Retain stored timeline facts, never replay provider events or queued input.
      projection = { sessionId: spec.id, runtimeId: '', ...(projection.nativeSessionId ? { nativeSessionId: id(projection.nativeSessionId) } : {}), phase: 'disconnected', sequence, items, settings: retainedSettings, title: projection.title === undefined ? spec.title : text(projection.title, 1000), archived: projection.archived === true, truncated: projection.truncated === true, view: 'visual', queued: null, queuedPrompts: [], pendingSteering: [] }
    }
    return { spec, projection: projection as SessionArchive['agents'][number]['projection'], transcript: text(redactArchive(a.transcript), MAX_SESSION_ARCHIVE_BYTES) }
  })
  unique(agents.map(a => a.spec.id), 'agent')
  const agentIds = new Set(agents.map(agent => agent.spec.id))
  for (const agent of agents) for (const item of agent.projection?.items ?? []) {
    if (item.data.type === 'text' && item.data.origin && !agentIds.has(item.data.origin.agentSessionId)) delete item.data.origin
    if (item.data.type === 'text') for (const attachment of item.data.attachments ?? []) {
      const remote = (attachment as Record<string, any>).remoteFile
      if (remote && (remote.projectId !== agent.spec.projectId || remote.machineId !== (agent.spec.machineId ?? LOCAL_MACHINE_ID))) fail('remote history attachment crosses project/machine')
    }
  }
  const terminals = list(v.terminals ?? [], 10000).map(value => {
    const terminal = record(value), s = record(terminal.spec)
    const project = projects.find(project => project.id === s.projectId)
    if (!project || !workspaces.some(workspace => workspace.id === s.sessionId && workspace.projectId === s.projectId)) fail('invalid terminal binding')
    const cwd = absolutePath(s.cwd)
    if (!samePath(cwd, project.path)) fail('terminal cwd differs from project')
    const spec: TerminalSpec = { id: id(s.id), projectId: id(s.projectId), sessionId: id(s.sessionId), title: text(s.title), cwd }
    return { spec, transcript: text(redactArchive(terminal.transcript), MAX_SESSION_ARCHIVE_BYTES) }
  })
  unique(terminals.map(terminal => terminal.spec.id), 'terminal')
  const ownedIds = [...projects.map(project => project.id), ...workspaces.map(workspace => workspace.id), ...detached.map(record => record.id), ...agents.map(agent => agent.spec.id), ...terminals.map(terminal => terminal.spec.id)]
  const collectOwnedIds = (node: LayoutNode): void => {
    ownedIds.push(node.id)
    if (node.type === 'split') node.children.forEach(collectOwnedIds)
    else { ownedIds.push(...node.tabs.map(tab => tab.id)); ownedIds.push(...(node.tabGroups?.map(group => group.id) ?? [])) }
  }
  workspaces.forEach(workspace => { collectOwnedIds(workspace.layout.root); ownedIds.push(...workspace.closedTabs.map(tab => tab.id)) })
  detached.forEach(record => collectOwnedIds(record.layout.root))
  unique(ownedIds, 'object identity')
  const tabOwners = new Map<string, { projectId: string; machineId: string; path?: string }>()
  const verifyTab = (t: PaneTab, projectId: string, workspaceId: string): void => {
    const machineId = typeof t.state?.machineId === 'string' ? t.state.machineId : LOCAL_MACHINE_ID
    const path = typeof t.state?.path === 'string' ? t.state.path : t.kind === 'code' && t.resourceId ? t.resourceId : undefined
    tabOwners.set(t.id, { projectId, machineId, ...(path ? { path } : {}) })
    if (t.kind === 'agent' && t.resourceId) {
      const a = agents.find(a => a.spec.id === t.resourceId)
      if (a && (a.spec.projectId !== projectId || a.spec.sessionId !== workspaceId)) fail('agent tab crosses project/workspace')
      if (a) {
        if (machineId !== (a.spec.machineId ?? LOCAL_MACHINE_ID)) fail('agent tab machine differs from its session')
        t.state = { ...t.state, machineId: a.spec.machineId ?? LOCAL_MACHINE_ID }
      }
    }
    if (t.kind === 'terminal' && t.resourceId) {
      const terminal = terminals.find(terminal => terminal.spec.id === t.resourceId)
      if (terminal && (terminal.spec.projectId !== projectId || terminal.spec.sessionId !== workspaceId)) fail('terminal tab crosses project/workspace')
    }
  }
  const verifyTabs = (node: LayoutNode, projectId: string, workspaceId: string): void => {
    if (node.type === 'split') { node.children.forEach(child => verifyTabs(child, projectId, workspaceId)); return }
    for (const t of node.tabs) verifyTab(t, projectId, workspaceId)
  }
  workspaces.forEach(s => { verifyTabs(s.layout.root, s.projectId, s.id); s.closedTabs.forEach(tab => verifyTab(tab, s.projectId, s.id)) })
  detached.forEach(d => verifyTabs(d.layout.root, d.projectId, d.sessionId))
  const documentIds: string[] = []
  const documents: WorkspaceDocumentState[] = list(v.documents ?? [], 10000).map(value => {
    const state = record(value)
    const workspaceId = text(state.workspaceId, 340)
    const projectWorkspace = workspaceId.startsWith('project:') ? workspaceId.slice('project:'.length) : null
    const detachedId = workspaceId.startsWith('detached:') ? workspaceId.slice('detached:'.length) : null
    const projectId = projectWorkspace
      ? projects.find(project => project.id === projectWorkspace)?.id
      : detachedId
        ? detached.find(record => record.id === detachedId)?.projectId
        : workspaces.find(workspace => workspace.id === workspaceId)?.projectId
    if (!projectId) fail('document state points outside the desk')
    const files = list(state.files, 1000).map(value => {
      const file = record(value), fileId = draftId(file.id), fileProjectId = id(file.projectId)
      if (fileProjectId !== projectId) fail('document differs from its owner project')
      const machineId = file.machineId === undefined ? LOCAL_MACHINE_ID : machine(file.machineId)
      const path = relativePath(file.path)
      if (!['editor', 'preview', 'browser'].includes(file.mode)) fail('invalid document mode')
      if (file.line !== undefined && (!Number.isSafeInteger(file.line) || file.line < 1)) fail('invalid document line')
      if (file.allowBinary !== undefined && typeof file.allowBinary !== 'boolean') fail('invalid document binary setting')
      if (ownedIds.includes(fileId)) fail('duplicate object identity')
      documentIds.push(fileId)
      tabOwners.set(fileId, { projectId: fileProjectId, machineId, path })
      return { id: fileId, machineId, projectId: fileProjectId, path, mode: file.mode, ...(file.line !== undefined ? { line: file.line } : {}), ...(file.allowBinary !== undefined ? { allowBinary: file.allowBinary } : {}) }
    })
    const activeId = state.activeId === null ? null : draftId(state.activeId)
    if (activeId && !files.some(file => file.id === activeId)) fail('active document is outside its workspace')
    return { workspaceId, files, activeId }
  })
  unique(documentIds, 'document')
  const drafts = list(v.drafts).map(value => {
    const d = record(value), tabId = draftId(d.tabId)
    if (!projects.some(p => p.id === d.projectId)) fail('draft project missing')
    const projectId = id(d.projectId), machineId = d.machineId === undefined ? LOCAL_MACHINE_ID : machine(d.machineId), path = relativePath(d.path)
    const owner = tabOwners.get(tabId)
    if (owner && (owner.projectId !== projectId || owner.machineId !== machineId || owner.path !== undefined && owner.path !== path)) fail('draft differs from its tab project/path/machine')
    // Drafts are the owner's unsaved source bytes. Credential-looking literals are valid source
    // and must round-trip exactly; archive authority is excluded by selecting schema fields.
    return { tabId, machineId, projectId, path, content: text(d.content, MAX_SESSION_ARCHIVE_BYTES), baseContent: d.baseContent === undefined ? undefined : d.baseContent === null ? null : text(d.baseContent, MAX_SESSION_ARCHIVE_BYTES), viewState: null, updatedAt: timestamp(d.updatedAt) }
  })
  unique(drafts.map(d => d.tabId), 'draft')
  const selection = record(v.selection)
  if (selection.activeProjectId !== null && !projects.some(p => p.id === selection.activeProjectId)) fail('selected project missing')
  if (selection.activeSessionId !== null && !workspaces.some(s => s.id === selection.activeSessionId && s.projectId === selection.activeProjectId)) fail('selected workspace missing')
  const focusedGroupIds = record(selection.focusedGroupIds), sessionIdsByProject = record(selection.sessionIdsByProject)
  for (const [p, s] of Object.entries(sessionIdsByProject)) if (!workspaces.some(w => w.projectId === p && w.id === s)) fail('project selection crosses projects')
  for (const [s, g] of Object.entries(focusedGroupIds)) if (!workspaceGroups.get(s)?.has(id(g))) fail('focused group is outside its workspace')
  return { format: 'conductor-session', version: 1, name, savedAt: timestamp(v.savedAt), projects, workspaces, detached, agents, terminals, documents, drafts, selection: { activeProjectId: selection.activeProjectId, activeSessionId: selection.activeSessionId, focusedGroupIds, sessionIdsByProject } }
}

export async function readSessionArchive(path: string): Promise<SessionArchive> {
  const file = await fs.open(path, 'r')
  try {
    if ((await file.stat()).size > MAX_SESSION_ARCHIVE_BYTES) fail('file exceeds 32 MiB')
    const bytes = Buffer.alloc(MAX_SESSION_ARCHIVE_BYTES + 1)
    let size = 0
    while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead }
    if (size > MAX_SESSION_ARCHIVE_BYTES) fail('file exceeds 32 MiB')
    return parseSessionArchive(bytes.subarray(0, size).toString('utf8'))
  } finally { await file.close() }
}

export async function writeSessionArchive(path: string, archive: SessionArchive): Promise<void> {
  // Parsing constructs a validated archive from an explicit field allowlist. This drops vault,
  // control and runtime-only metadata while preserving source drafts byte-for-byte.
  const selected = parseSessionArchive(JSON.stringify(archive))
  const serialized = JSON.stringify(selected, null, 2)
  if (Buffer.byteLength(serialized) > MAX_SESSION_ARCHIVE_BYTES) fail('file exceeds 32 MiB')
  const temporary = dirname(path) + '/.conductor-session-' + randomUUID() + '.tmp'
  try { await fs.writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, path) }
  finally { await fs.rm(temporary, { force: true }) }
}
