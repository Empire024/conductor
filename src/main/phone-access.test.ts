import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { X509Certificate } from 'node:crypto'
import type { AgentControlUiRequest } from '../shared/agent-control'
import type { AgentActivityPhase, AgentProviderInfo, DetachedWindowRecord, PaneTab, ProjectRecord, SessionRecord } from '../shared/models'
import { LOCAL_CONNECTION, LOCAL_MACHINE_ID, type MachineDescriptor } from '../shared/remote-control'
import type { AgentEventData, SessionProjection, TimelineItem } from '../shared/structured-agent'
import type { PhoneNotification } from '../shared/phone-access'
import { normalizePairingCode, normalizePhoneSettings, PhoneAccessError, PhoneAccessService, recommendEndpoint, trimItem, type PhoneDatabase, type PhoneRemoteSessions, type PhoneSessions } from './phone-access'
import { describeTransition, phoneSessionState } from './phone-notifications'
import { autoModeDenialMessage, autoModeDenialPayload } from '../shared/auto-mode-denial'
import { MemoryVault, type SecretKeyValueStore } from './secret-store'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

const item = (sequence: number, data: AgentEventData, extra: Partial<TimelineItem> = {}): TimelineItem => ({ id: `item-${sequence}`, runtimeId: 'rt-1', sequence, timestamp: new Date(1_700_000_000_000 + sequence * 1000).toISOString(), data, ...extra })

const projection = (sessionId: string, overrides: Partial<SessionProjection> = {}): SessionProjection => ({
  sessionId, runtimeId: 'rt-1', phase: 'idle', sequence: 1, items: [], settings: { permission: 'default', plan: false, model: 'claude-fable-5-1', effort: 'high' }, title: 'Fix the login bug', archived: false, truncated: false,
  capabilities: { provider: 'claude', runtimeVersion: '1', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: false, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: false, plans: false, effort: ['high', 'max'], models: [{ id: 'claude-fable-5-1', label: 'Fable 5.1', effort: ['high', 'max'], defaultEffort: 'high', isDefault: true }], limitations: [], permissions: ['default', 'read-only', 'accept-edits', 'auto'] },
  ...overrides
})

const tab = (id: string, resourceId: string, state: Record<string, unknown> = {}): PaneTab => ({ id, kind: 'agent', title: `Tab ${id}`, resourceId, state: { provider: 'claude', model: 'claude-fable-5-1', ...state } })

const workspace = (id: string, projectId: string, tabs: PaneTab[]): SessionRecord => ({ id, projectId, name: `Workspace ${id}`, layout: { version: 1, root: { type: 'group', id: 'group-' + id, tabs, activeTabId: tabs[0]?.id ?? '' } }, maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: 't', updatedAt: 't' })

interface Fixture {
  store: MapStore
  service: PhoneAccessService
  projections: Map<string, SessionProjection>
  specs: Map<string, { id: string; projectId: string; sessionId: string; provider: string; title: string; cwd: string; machineId?: string }>
  workspaces: SessionRecord[]
  projects: ProjectRecord[]
  detached: DetachedWindowRecord[]
  activity: Map<string, 'idle' | 'working' | 'waiting_input' | 'limited' | 'complete' | 'failed' | 'disconnected' | 'stopped' | 'waiting_background'>
  sessions: { [K in keyof PhoneSessions]: ReturnType<typeof vi.fn> }
  remote: { [K in keyof PhoneRemoteSessions]: ReturnType<typeof vi.fn> }
  ui: ReturnType<typeof vi.fn>
  push: ReturnType<typeof vi.fn>
  machines: MachineDescriptor[]
  changed: ReturnType<typeof vi.fn>
  projectTasks: { create: ReturnType<typeof vi.fn> }
}

function fixture(options: { now?: () => number } = {}): Fixture {
  const store = new MapStore()
  const projects: ProjectRecord[] = [
    { id: 'project-a', name: 'Conductor', path: 'C:\\work\\conductor', createdAt: 't', updatedAt: 't' },
    { id: 'project-b', name: 'Render farm', path: 'remote:empirium:project-x', createdAt: 't', updatedAt: 't', remote: { machineId: 'empirium', machineName: 'Empirium', remoteProjectId: 'project-x', path: 'D:\\render' } }
  ]
  const projections = new Map<string, SessionProjection>()
  const specs: Fixture['specs'] = new Map()
  const workspaces: SessionRecord[] = [workspace('ws-a', 'project-a', []), workspace('ws-b', 'project-b', [])]
  const detached: DetachedWindowRecord[] = []
  const activity: Fixture['activity'] = new Map()
  const database: PhoneDatabase = {
    listProjects: () => projects,
    getProject: id => projects.find(project => project.id === id) ?? null,
    listSessions: projectId => workspaces.filter(entry => entry.projectId === projectId),
    listDetachedWindows: () => detached,
    listProcesses: () => [...specs.values()].map(spec => ({ id: spec.id, projectId: spec.projectId, sessionId: spec.sessionId, kind: 'agent' as const, title: spec.title, provider: spec.provider as 'claude', status: 'running' as const, activityPhase: (activity.get(spec.id) ?? 'idle') as AgentActivityPhase, needsInput: false, progress: null, updatedAt: '2026-09-21T06:00:00.000Z' })),
    listAgentActivity: () => [...specs.values()].map(spec => ({ id: spec.id, projectId: spec.projectId, sessionId: spec.sessionId, activityPhase: (activity.get(spec.id) ?? 'idle') as AgentActivityPhase })),
    structured: {
      snapshot: id => projections.get(id) ?? null,
      spec: <T>(id: string) => (specs.get(id) ?? null) as T | null,
      history: projectId => [...specs.values()].filter(spec => spec.projectId === projectId).map(spec => ({ id: spec.id, title: spec.title, provider: spec.provider as 'claude', archived: projections.get(spec.id)?.archived ?? false, phase: projections.get(spec.id)?.phase ?? 'idle' })),
      update: (id, values) => { const current = projections.get(id); if (current) projections.set(id, { ...current, ...values }) }
    }
  }
  const sessions = {
    ensure: vi.fn((spec: { id: string; projectId: string; sessionId: string; provider: string; title: string; cwd: string }) => { specs.set(spec.id, spec); projections.set(spec.id, projection(spec.id, { title: spec.title })); return { id: spec.id, available: true, status: 'running' as const, transcript: '' } }),
    connectSession: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined), steer: vi.fn(async () => undefined), queue: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), resume: vi.fn(async () => undefined)
  }
  const remote = {
    isRemote: vi.fn((id: string) => id.startsWith('mirror-')),
    openTab: vi.fn(async (request: { machineId: string }) => { specs.set('mirror-1', { id: 'mirror-1', projectId: 'project-b', sessionId: 'ws-b', provider: 'claude', title: 'Remote', cwd: 'D:\\render', machineId: request.machineId }); projections.set('mirror-1', projection('mirror-1', { title: 'Remote' })); return { localSessionId: 'mirror-1', machineId: request.machineId, machineName: 'Empirium' } }),
    connect: vi.fn(async () => undefined), submit: vi.fn(async () => undefined), queue: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), resume: vi.fn(async () => undefined)
  }
  const ui = vi.fn(async (request: AgentControlUiRequest) => {
    if (request.action === 'tabs.open') {
      const created = request.params.tab as PaneTab
      const target = workspaces.find(entry => entry.id === request.sessionId)!
      const group = target.layout.root as { type: 'group'; tabs: PaneTab[]; activeTabId: string }
      group.tabs.push(created); group.activeTabId = created.id
    }
    return {}
  })
  const push = vi.fn(async () => ({ status: 201, gone: false, retryAfter: null, body: '' }))
  const machines: MachineDescriptor[] = [
    { id: LOCAL_MACHINE_ID, name: 'MAIN', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION },
    { id: 'empirium', name: 'Empirium', kind: 'peer', status: 'online', accountLogin: 'Empire024', projects: [], connection: { ...LOCAL_CONNECTION, transport: 'tailscale' } }
  ]
  const providers: AgentProviderInfo[] = [
    { id: 'claude', displayName: 'Claude Code', available: true, installUrl: '', models: [{ id: 'claude-fable-5-1', label: 'Fable 5.1' }, { id: 'claude-sonnet-5', label: 'Sonnet 5' }], efforts: [{ id: 'auto', label: 'Auto' }, { id: 'high', label: 'High' }, { id: 'max', label: 'Max' }] },
    { id: 'codex', displayName: 'Codex', available: false, installUrl: '', models: [{ id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' }], efforts: [] },
    { id: 'gemini', displayName: 'Gemini CLI', available: true, installUrl: '', models: [{ id: 'gemini-3', label: 'Gemini 3' }], efforts: [] }
  ]
  const changed = vi.fn()
  const projectTasks = { create: vi.fn(async (project: ProjectRecord, input: { title: string; kind: 'task' | 'bug' | 'feature' | 'idea'; priority: 'high' | 'normal' | 'low'; weight: 'heavy' | 'medium' | 'light' }) => ({ id: 'task-created', projectId: project.id, ...input })) }
  const service = new PhoneAccessService({
    store, vault: new MemoryVault(), database, sessions, remote, providers: () => providers, machines: () => machines, machineName: () => 'MAIN', version: '0.1.3',
    ui, metrics: async () => ({ sampledAt: 'now', cpuPercent: 12, cpuCores: 16, memoryUsedBytes: 8e9, memoryTotalBytes: 32e9, gpus: [], processes: [], localServers: [], unavailable: [] }),
    projectTasks, push, changed, log: () => undefined, ...(options.now ? { now: options.now } : {})
  })
  return { store, service, projections, specs, workspaces, projects, detached, activity, sessions, remote, ui, push, machines, changed, projectTasks }
}

/** Puts the listener in the "up" state the pairing code needs, without a socket. */
const listening = (service: PhoneAccessService, endpoint = 'https://192.168.0.205:51841'): void => {
  service.updateSettings({ enabled: true })
  service.setListenerStatus({ listening: true, endpoints: [endpoint], message: null, tailscaleCertificate: 'off', tailscaleMessage: null, tailscaleAddress: null, tailscaleDnsName: null })
}

const pairPhone = (service: PhoneAccessService, name = 'iPhone'): { token: string; id: string } => {
  listening(service)
  const offer = service.createPairing()
  const paired = service.redeemPairing({ code: offer.code, name, userAgent: 'Safari', address: '192.168.0.50' })
  return { token: paired.token, id: paired.device.id }
}

const openConversation = (fix: Fixture, id: string, overrides: Partial<SessionProjection> = {}, state: Record<string, unknown> = {}): void => {
  fix.specs.set(id, { id, projectId: 'project-a', sessionId: 'ws-a', provider: 'claude', title: 'Fix the login bug', cwd: 'C:\\work\\conductor' })
  fix.projections.set(id, projection(id, overrides))
  ;(fix.workspaces[0]!.layout.root as { tabs: PaneTab[] }).tabs.push(tab('tab-' + id, id, state))
}

describe('settings', () => {
  it('normalises stored settings and rejects a port outside the usable range', () => {
    expect(normalizePhoneSettings(null)).toEqual({ enabled: false, exposure: 'network', port: 51841, notifications: true, tailscaleCertificate: false })
    expect(normalizePhoneSettings({ enabled: true, exposure: 'tailscale', port: 0, notifications: false })).toMatchObject({ enabled: true, exposure: 'tailscale', port: 0, notifications: false })
    expect(normalizePhoneSettings({ port: 80 }).port).toBe(51841)
    const fix = fixture()
    expect(() => fix.service.updateSettings({ port: 80 })).toThrow(/between 1024 and 65535/)
    fix.service.updateSettings({ enabled: true, port: 52000 })
    expect(JSON.parse(fix.store.getSetting('phone-access.settings')!)).toMatchObject({ enabled: true, port: 52000 })
    expect(fix.changed).toHaveBeenCalled()
  })
})

describe('the address a phone should keep', () => {
  const status = (over: Partial<Parameters<typeof recommendEndpoint>[0]> = {}): Parameters<typeof recommendEndpoint>[0] => ({
    listening: true, endpoints: ['https://192.168.0.205:51841', 'https://100.72.193.87:51841', 'https://e-box.tail8216c8.ts.net:51841'],
    tailscaleAddress: '100.72.193.87', tailscaleDnsName: 'e-box.tail8216c8.ts.net', tailscaleCertificate: 'off', ...over
  })

  it('prefers the tailnet address over the Wi-Fi one, and the MagicDNS name only once a public certificate serves it', () => {
    expect(recommendEndpoint(status())).toBe('https://100.72.193.87:51841')
    expect(recommendEndpoint(status({ tailscaleCertificate: 'active' }))).toBe('https://e-box.tail8216c8.ts.net:51841')
    expect(recommendEndpoint(status({ tailscaleCertificate: 'pending' }))).toBe('https://100.72.193.87:51841')
    expect(recommendEndpoint(status({ tailscaleAddress: null, tailscaleDnsName: null, endpoints: ['https://192.168.0.205:51841'] }))).toBe('https://192.168.0.205:51841')
    expect(recommendEndpoint(status({ listening: false, endpoints: [] }))).toBeNull()
  })

  it('is what the desktop state and a pairing code name unless the owner picks another address this machine answers on', () => {
    const fix = fixture()
    fix.service.updateSettings({ enabled: true })
    fix.service.setListenerStatus({ ...status(), message: null, tailscaleMessage: null, tailnet: { installed: true, backendState: 'Running', loginName: 'Empire024@github', httpsEnabled: false, phones: [{ hostName: 'iphone', os: 'ios', online: true, addresses: ['100.72.9.9'] }], checkedAt: '2026-09-23T00:00:00.000Z' } })
    const desktop = fix.service.desktopState()
    expect(desktop.recommendedEndpoint).toBe('https://100.72.193.87:51841')
    expect(desktop.tailscale).toMatchObject({ address: '100.72.193.87', loginName: 'Empire024@github', httpsEnabled: false, installed: true, phones: [{ hostName: 'iphone', os: 'ios' }] })
    const recommended = fix.service.createPairing()
    expect(recommended.endpoint).toBe('https://100.72.193.87:51841')
    expect(recommended.url).toBe(`https://100.72.193.87:51841/#pair=${recommended.code}`)
    const wifi = fix.service.createPairing('https://192.168.0.205:51841/')
    expect(wifi.endpoint).toBe('https://192.168.0.205:51841')
    expect(fix.service.desktopState().pairing).toMatchObject({ code: wifi.code, endpoint: 'https://192.168.0.205:51841' })
    // A code naming an address this machine does not serve would be the blank phone screen again.
    expect(() => fix.service.createPairing('https://10.0.0.1:51841')).toThrow(/does not answer at that address/)
  })

  it('reads as nothing known about the tailnet when the listener never looked', () => {
    const fix = fixture()
    expect(fix.service.desktopState().tailscale).toEqual({ address: null, dnsName: null, certificate: 'off', message: null, installed: false, backendState: null, loginName: null, httpsEnabled: null, phones: [], checkedAt: null })
    expect(fix.service.desktopState().recommendedEndpoint).toBeNull()
  })
})

describe('pairing a phone', () => {
  it('needs the listener up, hands out a readable single-use code, and the code becomes one device token', () => {
    const fix = fixture()
    expect(() => fix.service.createPairing()).toThrow(PhoneAccessError)
    listening(fix.service)
    const offer = fix.service.createPairing()
    expect(offer.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(offer.code).not.toMatch(/[01IO]/)
    expect(offer.url).toBe(`https://192.168.0.205:51841/#pair=${offer.code}`)
    expect(fix.service.desktopState().pairing?.code).toBe(offer.code)
    const paired = fix.service.redeemPairing({ code: offer.code.toLowerCase().replace('-', ' '), name: '  My  iPhone ', userAgent: 'Safari', address: '10.0.0.2' })
    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(paired.device).toMatchObject({ name: 'My iPhone', machineName: 'MAIN', pushEnabled: false, notificationsAllowed: true, version: '0.1.3' })
    expect(paired.device.vapidPublicKey).toBeTruthy()
    // Spent: the same code cannot pair a second phone.
    expect(() => fix.service.redeemPairing({ code: offer.code, name: 'Again', address: '10.0.0.3' })).toThrow(/No pairing code is active/)
    expect(fix.service.authenticate(paired.token)).toMatchObject({ id: paired.device.id, name: 'My iPhone' })
    expect(fix.service.authenticate('nope')).toBeNull()
    expect(fix.service.authenticate(undefined)).toBeNull()
    // The token itself is never stored, only its hash.
    expect(fix.store.getSetting('phone-access.devices')).not.toContain(paired.token)
  })

  it('locks an address out after repeated wrong codes and expires an unused code', () => {
    let clock = 1_700_000_000_000
    const fix = fixture({ now: () => clock })
    listening(fix.service)
    const offer = fix.service.createPairing()
    for (let attempt = 0; attempt < 5; attempt += 1) expect(() => fix.service.redeemPairing({ code: 'AAAA-AAAA', name: 'x', address: '10.0.0.9' })).toThrow(/did not match/)
    expect(() => fix.service.redeemPairing({ code: offer.code, name: 'x', address: '10.0.0.9' })).toThrow(/Too many failed/)
    // A different address is not punished for that one's guessing.
    clock += 11 * 60 * 1000
    expect(() => fix.service.redeemPairing({ code: offer.code, name: 'x', address: '10.0.0.10' })).toThrow(/No pairing code is active/)
    expect(fix.service.desktopState().pairing).toBeNull()
  })

  it('revokes a phone so its token stops working, and renames one', () => {
    const fix = fixture()
    const phone = pairPhone(fix.service)
    fix.service.rename(phone.id, 'Pixel')
    expect(fix.service.self(phone.id).name).toBe('Pixel')
    fix.service.revoke(phone.id)
    expect(fix.service.authenticate(phone.token)).toBeNull()
    expect(fix.service.desktopState().devices).toEqual([])
    expect(() => fix.service.revoke(phone.id)).toThrow(/not paired/)
  })

  it('normalises typed codes', () => {
    expect(normalizePairingCode(' ab-cd ef ')).toBe('ABCDEF')
  })
})

describe('the certificate chain', () => {
  it('mints a CA once, re-issues the server certificate only when its addresses change, and chains them', () => {
    const fix = fixture()
    const first = fix.service.serverIdentity(['192.168.0.205'])
    const again = fix.service.serverIdentity(['192.168.0.205'])
    expect(again.certificatePem).toBe(first.certificatePem)
    const moved = fix.service.serverIdentity(['192.168.0.42'])
    expect(moved.certificatePem).not.toBe(first.certificatePem)
    expect(moved.hosts).toEqual(['localhost', '127.0.0.1', '192.168.0.42'])
    const authority = fix.service.certificateAuthority()
    expect(fix.service.desktopState().caFingerprint).toBe(authority.fingerprint)
    const leaf = new X509Certificate(moved.certificatePem.split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----\n')
    expect(leaf.checkIssued(new X509Certificate(authority.certificatePem))).toBe(true)
    expect(moved.certificatePem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2)
  })
})

describe('what the phone sees', () => {
  it('lists every open conversation with the state a tab shows, plus history without a tab', () => {
    const fix = fixture()
    openConversation(fix, 'agent-1', { phase: 'running', items: [item(1, { type: 'text', role: 'user', text: 'Fix the bug', mode: 'snapshot' }), item(2, { type: 'text', role: 'assistant', text: 'Looking at it now.', mode: 'snapshot' })] })
    fix.activity.set('agent-1', 'working')
    openConversation(fix, 'agent-2', { phase: 'waiting_input', items: [item(3, { type: 'interaction', interaction: { id: 'q-1', kind: 'question', title: 'Which database?', input: null, choices: [], questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }], status: 'pending' } }, { runtimeId: 'rt-1' })] })
    fix.activity.set('agent-2', 'waiting_input')
    openConversation(fix, 'agent-3', { phase: 'completed', items: [item(4, { type: 'text', role: 'assistant', text: 'All done. ```code```', mode: 'snapshot' }), item(5, { type: 'usage', source: 'provider', totalTokens: 1234, costUsd: 0.5, limits: { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 12, windowDurationMins: 10080 } } } })] })
    fix.activity.set('agent-3', 'complete')
    // History only: a conversation whose tab was closed keeps its record but asks nothing.
    fix.specs.set('agent-old', { id: 'agent-old', projectId: 'project-a', sessionId: 'ws-a', provider: 'claude', title: 'Old work', cwd: 'C:\\work\\conductor' })
    fix.projections.set('agent-old', projection('agent-old', { phase: 'completed', title: 'Old work' }))
    // A tab in a detached window still counts as open.
    fix.specs.set('agent-detached', { id: 'agent-detached', projectId: 'project-a', sessionId: 'ws-a', provider: 'claude', title: 'Detached', cwd: 'C:\\work\\conductor' })
    fix.projections.set('agent-detached', projection('agent-detached', { phase: 'running', title: 'Detached' }))
    fix.detached.push({ id: 'win-1', projectId: 'project-a', sessionId: 'ws-a', layout: { version: 1, root: { type: 'group', id: 'g', tabs: [tab('tab-d', 'agent-detached')], activeTabId: 'tab-d' } }, maximizedGroupId: null, createdAt: 't', updatedAt: 't' })
    const state = fix.service.phoneState()
    expect(state.machineName).toBe('MAIN')
    expect(state.projects.map(project => [project.id, project.machineId])).toEqual([['project-a', LOCAL_MACHINE_ID], ['project-b', 'empirium']])
    expect(state.machines.find(machine => machine.id === LOCAL_MACHINE_ID)?.projectIds).toEqual(['project-a'])
    expect(state.machines.find(machine => machine.id === 'empirium')?.projectIds).toEqual(['project-b'])
    // Only the providers a phone can drive, and the runtime catalog when a tab already has one.
    expect(state.providers.map(provider => provider.id)).toEqual(['claude', 'codex'])
    expect(state.providers[0]?.models).toEqual([{ id: 'claude-fable-5-1', label: 'Fable 5.1', effort: ['high', 'max'], defaultEffort: 'high', isDefault: true }])
    expect(state.providers[1]?.models[0]).toMatchObject({ id: 'gpt-5.5-codex', effort: [] })
    const byId = new Map(state.sessions.map(session => [session.id, session]))
    expect(byId.get('agent-1')).toMatchObject({ state: 'working', phase: 'running', activity: 'working', tabId: 'tab-agent-1', lastText: 'Looking at it now.', lastRole: 'assistant', turnStartedAt: item(1, { type: 'text', role: 'user', text: '', mode: 'snapshot' }).timestamp, machineId: LOCAL_MACHINE_ID, machineName: 'MAIN', projectName: 'Conductor', workspaceName: 'Workspace ws-a', model: 'claude-fable-5-1', effort: 'high' })
    expect(byId.get('agent-2')).toMatchObject({ state: 'attention', needs: 'question', pendingId: 'q-1', pendingTitle: 'Which database?' })
    expect(byId.get('agent-3')).toMatchObject({ state: 'done', lastText: 'All done. [code]', usage: { totalTokens: 1234, costUsd: 0.5, estimated: false } })
    expect(byId.get('agent-old')).toMatchObject({ state: 'done', tabId: null })
    expect(byId.get('agent-detached')).toMatchObject({ state: 'working', tabId: 'tab-d' })
    // Layout order is stable while activity changes, so rows never jump under the owner's finger.
    expect(state.sessions.map(session => session.id)).toEqual(['agent-1', 'agent-2', 'agent-3', 'agent-detached', 'agent-old'])
    expect(state.counts).toEqual({ attention: 1, working: 2 })
    expect(state.usage).toEqual([
      expect.objectContaining({ provider: 'claude', kind: 'weekly', usedPercent: 12 }),
      expect.objectContaining({ provider: 'claude', kind: 'short', usedPercent: 40, resetsAt: new Date(1_800_000_000 * 1000).toISOString() })
    ])
    fix.store.setSetting('agentControlParent:agent-2', JSON.stringify({ controllerAgentSessionId: 'agent-1' }))
    expect(fix.service.phoneState().sessions.find(session => session.id === 'agent-2')?.controllerId).toBe('agent-1')
  })

  it('trims a conversation to what a phone can show and reports what it may do next', () => {
    const fix = fixture()
    const long = 'x'.repeat(10_000)
    openConversation(fix, 'agent-1', {
      phase: 'interrupted', nativeSessionId: 'native-1', queuedPrompts: [{ id: 'q', text: 'later', settings: { permission: 'default', plan: false }, attachments: [] }],
      items: [
        item(1, { type: 'text', role: 'user', text: 'Start', mode: 'snapshot' }),
        item(2, { type: 'tool', name: 'Bash', status: 'completed', input: { command: long }, output: long, stderr: '' }),
        item(3, { type: 'text', role: 'assistant', text: 'child', mode: 'snapshot' }, { parentId: 'item-2' }),
        item(4, { type: 'steering', prompts: [] }),
        item(5, { type: 'changes', changes: [{ path: 'a.ts', kind: 'update', status: 'applied', patch: long }] }),
        item(6, { type: 'text', role: 'assistant', text: long, mode: 'snapshot' })
      ]
    })
    const conversation = fix.service.conversation('agent-1')
    expect(conversation.items.map(entry => entry.data.type)).toEqual(['text', 'tool', 'changes', 'text'])
    const tool = conversation.items[1]!.data as Extract<AgentEventData, { type: 'tool' }>
    expect(tool.input).toMatchObject({ truncated: true })
    expect(tool.output!.length).toBeLessThanOrEqual(1201)
    expect((conversation.items[2]!.data as Extract<AgentEventData, { type: 'changes' }>).changes[0]!.patch).toBeUndefined()
    expect((conversation.items[3]!.data as Extract<AgentEventData, { type: 'text' }>).text.length).toBeLessThanOrEqual(6002)
    expect(conversation).toMatchObject({ needsResume: true, canSteer: true, truncated: false, queued: [{ id: 'q', text: 'later' }], sequence: 1 })
    expect(() => fix.service.conversation('missing')).toThrow(/not open/)
    expect(trimItem(item(1, { type: 'notice', message: 'm', payload: { big: true } })).data).toEqual({ type: 'notice', message: 'm', payload: undefined })
  })

  it('reports host load with the runtimes named by project and workspace', async () => {
    const fix = fixture()
    openConversation(fix, 'agent-1')
    const metrics = await fix.service.metrics()
    expect(metrics.system.cpuCores).toBe(16)
    expect(metrics.runtimes).toEqual([expect.objectContaining({ id: 'agent-1', projectName: 'Conductor', workspaceName: 'Workspace ws-a' })])
  })
})

describe('driving a conversation', () => {
  it('submits when idle, steers a running turn when the provider allows it, queues otherwise', async () => {
    const fix = fixture()
    openConversation(fix, 'agent-1')
    await expect(fix.service.sendMessage('agent-1', { text: '  Ship it ' })).resolves.toMatchObject({ mode: 'submit' })
    expect(fix.sessions.submit).toHaveBeenCalledWith('agent-1', 'Ship it', expect.objectContaining({ model: 'claude-fable-5-1' }), [])
    fix.projections.set('agent-1', projection('agent-1', { phase: 'running' }))
    await expect(fix.service.sendMessage('agent-1', { text: 'Also tests' })).resolves.toMatchObject({ mode: 'steer' })
    expect(fix.sessions.steer).toHaveBeenCalledTimes(1)
    const noSteering = projection('agent-1', { phase: 'running' })
    noSteering.capabilities = { ...noSteering.capabilities!, steering: false }
    fix.projections.set('agent-1', noSteering)
    await expect(fix.service.sendMessage('agent-1', { text: 'Later' })).resolves.toMatchObject({ mode: 'queue' })
    expect(fix.sessions.queue).toHaveBeenCalledTimes(1)
    await expect(fix.service.sendMessage('agent-1', { text: 'x', mode: 'steer' })).rejects.toThrow(/cannot be steered/)
    await expect(fix.service.sendMessage('agent-1', { text: '   ' })).rejects.toThrow(/Write a message/)
  })

  it('resumes an interrupted conversation before a fresh message, and drives a mirrored one through its machine', async () => {
    const fix = fixture()
    openConversation(fix, 'agent-1', { phase: 'disconnected', nativeSessionId: 'native' })
    await fix.service.sendMessage('agent-1', { text: 'Continue' })
    expect(fix.sessions.resume).toHaveBeenCalledWith('agent-1', expect.anything())
    expect(fix.sessions.submit).toHaveBeenCalledTimes(1)
    fix.specs.set('mirror-1', { id: 'mirror-1', projectId: 'project-b', sessionId: 'ws-b', provider: 'claude', title: 'Remote', cwd: 'D:\\render', machineId: 'empirium' })
    fix.projections.set('mirror-1', projection('mirror-1', { phase: 'running' }))
    ;(fix.workspaces[1]!.layout.root as { tabs: PaneTab[] }).tabs.push(tab('tab-m', 'mirror-1', { machineId: 'empirium' }))
    await expect(fix.service.sendMessage('mirror-1', { text: 'Faster' })).resolves.toMatchObject({ mode: 'steer' })
    expect(fix.remote.submit).toHaveBeenCalledWith('mirror-1', 'Faster', 'agents.steer', expect.anything())
    expect(fix.sessions.steer).not.toHaveBeenCalled()
    await fix.service.interrupt('mirror-1')
    expect(fix.remote.interrupt).toHaveBeenCalledWith('mirror-1')
    const summary = fix.service.phoneState().sessions.find(session => session.id === 'mirror-1')
    expect(summary).toMatchObject({ machineId: 'empirium', machineName: 'Empirium' })
  })

  it('answers only a question that is still pending, with the runtime it belongs to', async () => {
    const fix = fixture()
    openConversation(fix, 'agent-1', { phase: 'waiting_input', runtimeId: 'rt-9', items: [item(1, { type: 'interaction', interaction: { id: 'q-1', kind: 'approval', title: 'Run rm -rf build?', input: null, choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], status: 'pending' } })] })
    await fix.service.respond('agent-1', { requestId: 'q-1', decision: 'yes' })
    expect(fix.sessions.respond).toHaveBeenCalledWith({ sessionId: 'agent-1', runtimeId: 'rt-9', requestId: 'q-1', decision: 'yes' })
    await fix.service.respond('agent-1', { requestId: 'q-1', answers: { db: 'Postgres', extra: ['a', 5, 'b'] } })
    expect(fix.sessions.respond).toHaveBeenLastCalledWith(expect.objectContaining({ answers: { db: ['Postgres'], extra: ['a', 'b'] } }))
    await expect(fix.service.respond('agent-1', { requestId: 'q-2' })).rejects.toThrow(/no longer waiting/)
    await expect(fix.service.respond('agent-1', { requestId: '' })).rejects.toThrow(/Name the question/)
  })

  it('refuses to drive a provider the structured backend does not journal', async () => {
    const fix = fixture()
    fix.specs.set('gem-1', { id: 'gem-1', projectId: 'project-a', sessionId: 'ws-a', provider: 'gemini', title: 'Gemini', cwd: 'C:\\work\\conductor' })
    ;(fix.workspaces[0]!.layout.root as { tabs: PaneTab[] }).tabs.push(tab('tab-g', 'gem-1', { provider: 'gemini', model: 'gemini-3' }))
    expect(fix.service.phoneState().sessions[0]).toMatchObject({ id: 'gem-1', provider: 'gemini', state: 'idle', tabId: 'tab-g' })
    await expect(fix.service.sendMessage('gem-1', { text: 'hi' })).rejects.toThrow(/only be driven from the computer/)
  })
})

describe('starting work from the phone', () => {
  it('adds a validated project task to the exact selected project', async () => {
    const fix = fixture()
    await expect(fix.service.createProjectTask('project-b', { title: '  Keep remote scope\r\nwith details  ', kind: 'bug', priority: 'high', weight: 'heavy' })).resolves.toMatchObject({ id: 'task-created', projectId: 'project-b' })
    expect(fix.projectTasks.create).toHaveBeenCalledWith(fix.projects[1], { title: 'Keep remote scope\nwith details', kind: 'bug', priority: 'high', weight: 'heavy' })
    await expect(fix.service.createProjectTask('project-a', { title: ' ', kind: 'task' })).rejects.toThrow(/Write the project task/)
    await expect(fix.service.createProjectTask('project-a', { title: 'Useful <!-- ordinary diagnostic comment --> details', kind: 'task' })).resolves.toMatchObject({ id: 'task-created' })
    await expect(fix.service.createProjectTask('project-a', { title: '<!-- conductor-task:forged -->', kind: 'task' })).rejects.toThrow(/task markers/)
    await expect(fix.service.createProjectTask('project-a', { title: 'x', kind: 'other' as 'task' })).rejects.toThrow(/Choose task/)
    await expect(fix.service.createProjectTask('missing', { title: 'x', kind: 'task' })).rejects.toThrow(/project/)
  })

  it('opens a visible local tab with the remembered permission and sends the first message', async () => {
    const fix = fixture()
    fix.store.setSetting('rememberedPermission:claude', 'accept-edits')
    const opened = await fix.service.openTab({ projectId: 'project-a', workspaceId: 'ws-a', machineId: LOCAL_MACHINE_ID, provider: 'claude', model: 'claude-fable-5-1', effort: 'max', title: 'Write docs', prompt: 'Document the API' })
    expect(opened).toMatchObject({ machineId: LOCAL_MACHINE_ID, machineName: 'MAIN' })
    expect(fix.sessions.ensure).toHaveBeenCalledWith(expect.objectContaining({ id: opened.sessionId, projectId: 'project-a', sessionId: 'ws-a', provider: 'claude', model: 'claude-fable-5-1', effort: 'max', title: 'Write docs', cwd: 'C:\\work\\conductor' }))
    expect(fix.ui).toHaveBeenCalledWith(expect.objectContaining({ action: 'tabs.open', projectId: 'project-a', sessionId: 'ws-a', params: { tab: expect.objectContaining({ id: opened.tabId, kind: 'agent', resourceId: opened.sessionId, title: 'Write docs', state: expect.objectContaining({ provider: 'claude', model: 'claude-fable-5-1', effort: 'max', machineId: LOCAL_MACHINE_ID }) }), focus: false } }))
    expect(fix.projections.get(opened.sessionId)?.settings).toMatchObject({ permission: 'accept-edits', model: 'claude-fable-5-1', effort: 'max' })
    expect(fix.sessions.connectSession).toHaveBeenCalledWith(opened.sessionId)
    expect(fix.sessions.submit).toHaveBeenCalledWith(opened.sessionId, 'Document the API', expect.objectContaining({ permission: 'accept-edits' }), [])
    // The tab the UI added is now in the phone's list.
    expect(fix.service.phoneState().sessions.find(session => session.id === opened.sessionId)).toMatchObject({ tabId: opened.tabId, title: 'Write docs' })
  })

  it('places work for a project that lives on a paired machine on that machine, and refuses any other', async () => {
    const fix = fixture()
    await expect(fix.service.openTab({ projectId: 'project-b', workspaceId: 'ws-b', machineId: LOCAL_MACHINE_ID, provider: 'claude', model: 'claude-fable-5-1' })).rejects.toThrow(/lives on Empirium/)
    await expect(fix.service.openTab({ projectId: 'project-a', workspaceId: 'ws-a', machineId: 'empirium', provider: 'claude', model: 'claude-fable-5-1' })).rejects.toThrow(/is on MAIN/)
    const opened = await fix.service.openTab({ projectId: 'project-b', workspaceId: 'ws-b', machineId: 'empirium', provider: 'claude', model: 'claude-fable-5-1', prompt: 'Render scene 4' })
    expect(fix.remote.openTab).toHaveBeenCalledWith({ machineId: 'empirium', projectId: 'project-b', sessionId: 'ws-b', provider: 'claude', model: 'claude-fable-5-1' })
    expect(opened).toMatchObject({ sessionId: 'mirror-1', machineId: 'empirium', machineName: 'Empirium' })
    expect(fix.ui).toHaveBeenCalledWith(expect.objectContaining({ action: 'tabs.open', sessionId: 'ws-b', params: expect.objectContaining({ tab: expect.objectContaining({ resourceId: 'mirror-1', title: 'Claude · Empirium', state: expect.objectContaining({ machineId: 'empirium' }) }) }) }))
    expect(fix.remote.connect).toHaveBeenCalledWith('mirror-1')
    expect(fix.remote.submit).toHaveBeenCalledWith('mirror-1', 'Render scene 4', 'agents.submit', expect.anything())
    fix.machines[1]!.status = 'offline'
    await expect(fix.service.openTab({ projectId: 'project-b', workspaceId: 'ws-b', machineId: 'empirium', provider: 'claude', model: 'claude-fable-5-1' })).rejects.toThrow(/not reachable/)
  })

  it('validates provider, model and effort against the catalog', async () => {
    const fix = fixture()
    await expect(fix.service.openTab({ projectId: 'project-a', workspaceId: 'ws-a', machineId: LOCAL_MACHINE_ID, provider: 'codex', model: 'gpt-5.5-codex' })).rejects.toThrow(/available provider/)
    await expect(fix.service.openTab({ projectId: 'project-a', workspaceId: 'ws-a', machineId: LOCAL_MACHINE_ID, provider: 'claude', model: 'nope' })).rejects.toThrow(/listed models/)
    await expect(fix.service.openTab({ projectId: 'project-a', workspaceId: 'ws-a', machineId: LOCAL_MACHINE_ID, provider: 'claude', model: 'claude-fable-5-1', effort: 'silly' })).rejects.toThrow(/effort/)
    await expect(fix.service.openTab({ projectId: 'nope', workspaceId: 'ws-a', machineId: LOCAL_MACHINE_ID, provider: 'claude', model: 'claude-fable-5-1' })).rejects.toThrow(/project/)
  })
})

describe('notifications', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('derives the phone state word from the projection and the persisted phase', () => {
    expect(phoneSessionState({ phase: 'completed' }, 'working')).toBe('working')
    expect(phoneSessionState({ phase: 'completed' }, 'waiting_background')).toBe('working')
    expect(phoneSessionState({ phase: 'completed' }, 'complete')).toBe('done')
    expect(phoneSessionState({ phase: 'idle', limitResumeAt: '2026-09-21T10:00:00Z' }, 'idle')).toBe('limited')
    expect(phoneSessionState({ phase: 'waiting_approval' }, 'working')).toBe('attention')
    expect(phoneSessionState({ phase: 'failed' }, 'failed')).toBe('failed')
    expect(phoneSessionState({ phase: 'disconnected' }, 'disconnected')).toBe('disconnected')
    expect(phoneSessionState({ phase: 'interrupted' }, 'stopped')).toBe('stopped')
    expect(phoneSessionState(null, undefined)).toBe('idle')
  })

  it('announces only the transitions worth a buzz', () => {
    const base = { id: 'a', projectId: 'p', projectName: 'P', workspaceId: 'w', workspaceName: 'W', tabId: 't', title: 'Fix it', provider: 'claude' as const, machineId: 'local', machineName: 'MAIN', phase: 'completed' as const, activity: 'complete' as const, state: 'done' as const, needs: null, updatedAt: 'now', queued: 0, archived: false }
    expect(describeTransition(undefined, base, 'now', 'n1')).toBeNull()
    expect(describeTransition({ state: 'working' }, base, 'now', 'n1')).toMatchObject({ kind: 'done', title: 'Done: Fix it', url: '/#/session/a' })
    expect(describeTransition({ state: 'done' }, base, 'now', 'n1')).toBeNull()
    expect(describeTransition({ state: 'done' }, { ...base, state: 'working' }, 'now', 'n1')).toBeNull()
    const asking = { ...base, state: 'attention' as const, needs: 'question' as const, pendingId: 'q-2', pendingTitle: 'Which one?' }
    expect(describeTransition({ state: 'attention', pendingId: 'q-1' }, asking, 'now', 'n1')).toMatchObject({ kind: 'attention', body: 'Which one?' })
    expect(describeTransition({ state: 'attention', pendingId: 'q-2' }, asking, 'now', 'n1')).toBeNull()
    expect(describeTransition({ state: 'working' }, { ...base, state: 'failed', lastText: 'boom' }, 'now', 'n1')).toMatchObject({ kind: 'failed', body: 'boom' })
    expect(describeTransition({ state: 'working' }, { ...base, state: 'limited', limitResumeAt: '2026-09-21T10:00:00.000Z' }, 'now', 'n1')).toMatchObject({ kind: 'limited' })
  })

  it('pushes to every subscribed phone when a watched conversation finishes or asks, never on first sight', async () => {
    const fix = fixture()
    const phone = pairPhone(fix.service)
    fix.service.setSubscription(phone.id, { endpoint: 'https://push.example/sub', keys: { p256dh: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } })
    const events: Array<[string, unknown]> = []
    const unsubscribe = fix.service.subscribe(phone.id, (event, data) => events.push([event, data]))
    expect(events[0]?.[0]).toBe('state')
    openConversation(fix, 'agent-1', { phase: 'running' })
    fix.activity.set('agent-1', 'working')
    fix.service.observeEvents([{ sessionId: 'agent-1', sequence: 1, data: { type: 'session' } }])
    await vi.advanceTimersByTimeAsync(500)
    expect(fix.push).not.toHaveBeenCalled()
    expect(events.some(([event]) => event === 'session')).toBe(true)
    fix.projections.set('agent-1', projection('agent-1', { phase: 'completed', items: [item(1, { type: 'text', role: 'assistant', text: 'Done and dusted.', mode: 'snapshot' })] }))
    fix.activity.set('agent-1', 'complete')
    fix.service.noteActivity('agent-1')
    await vi.advanceTimersByTimeAsync(500)
    expect(fix.push).toHaveBeenCalledTimes(1)
    const [subscription, payload, options] = fix.push.mock.calls[0] as [unknown, string, { urgency: string; topic?: string }]
    expect(subscription).toMatchObject({ endpoint: 'https://push.example/sub' })
    expect(JSON.parse(payload) as PhoneNotification).toMatchObject({ kind: 'done', sessionId: 'agent-1', title: 'Done: Tab tab-agent-1', body: 'Done and dusted.' })
    expect(options.urgency).toBe('normal')
    expect(options.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(events.filter(([event]) => event === 'notification')).toHaveLength(1)
    // A question arriving is high urgency; the same question again is not repeated.
    fix.projections.set('agent-1', projection('agent-1', { phase: 'waiting_input', items: [item(2, { type: 'interaction', interaction: { id: 'q-1', kind: 'question', title: 'Deploy?', input: null, choices: [], status: 'pending' } })] }))
    fix.service.observeEvents([{ sessionId: 'agent-1', sequence: 2, data: { type: 'interaction' } }])
    await vi.advanceTimersByTimeAsync(500)
    fix.service.observeEvents([{ sessionId: 'agent-1', sequence: 2, data: { type: 'text' } }])
    await vi.advanceTimersByTimeAsync(500)
    expect(fix.push).toHaveBeenCalledTimes(2)
    expect((fix.push.mock.calls[1] as [unknown, string, { urgency: string }])[2].urgency).toBe('high')
    unsubscribe()
    expect(fix.service.streamCount()).toBe(0)
  })

  it('pushes once per claude auto-mode classifier denial while the turn keeps working, and never repeats it', async () => {
    const fix = fixture()
    const phone = pairPhone(fix.service)
    fix.service.setSubscription(phone.id, { endpoint: 'https://push.example/sub', keys: { p256dh: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } })
    openConversation(fix, 'agent-1', { phase: 'running' })
    fix.activity.set('agent-1', 'working')
    fix.service.observeEvents([{ sessionId: 'agent-1', sequence: 1, data: { type: 'session' } }])
    await vi.advanceTimersByTimeAsync(500)
    expect(fix.push).not.toHaveBeenCalled()
    // The classifier refused a tool mid-turn: no interaction, no phase change, only the notice item.
    const denial = { tool: 'Edit', reason: 'Security Weaken', toolUseId: 'toolu_1' }
    const denied = item(2, { type: 'notice', message: autoModeDenialMessage(denial), payload: autoModeDenialPayload(denial) }, { id: 'auto-denial:toolu_1', nativeItemId: 'auto-denial:toolu_1' })
    fix.projections.set('agent-1', projection('agent-1', { phase: 'running', items: [denied] }))
    fix.service.observeEvents([{ sessionId: 'agent-1', sequence: 2, data: { type: 'notice' } }])
    await vi.advanceTimersByTimeAsync(500)
    expect(fix.push).toHaveBeenCalledTimes(1)
    const [, payload, options] = fix.push.mock.calls[0] as [unknown, string, { urgency: string }]
    expect(JSON.parse(payload) as PhoneNotification).toMatchObject({ kind: 'attention', sessionId: 'agent-1', title: 'Needs you: Tab tab-agent-1', body: 'Auto mode refused Edit: Security Weaken' })
    expect(options.urgency).toBe('high')
    expect(fix.service.phoneState().sessions.find(session => session.id === 'agent-1')).toMatchObject({ state: 'working', autoModeDenials: [{ id: 'auto-denial:toolu_1', tool: 'Edit', reason: 'Security Weaken' }] })
    // The result frame confirms the same item and the turn finishes: the finish is announced, the denial is not repeated.
    fix.projections.set('agent-1', projection('agent-1', { phase: 'completed', items: [{ ...denied, data: { type: 'notice', message: autoModeDenialMessage(denial), payload: autoModeDenialPayload(denial, true) } }] }))
    fix.activity.set('agent-1', 'complete')
    fix.service.observeEvents([{ sessionId: 'agent-1', sequence: 3, data: { type: 'notice' } }])
    await vi.advanceTimersByTimeAsync(500)
    expect(fix.push.mock.calls.map(call => (JSON.parse(call[1] as string) as PhoneNotification).kind)).toEqual(['attention', 'done'])
  })

  it('drops a subscription the push service says is gone and respects the master switch', async () => {
    const fix = fixture()
    const phone = pairPhone(fix.service)
    fix.service.setSubscription(phone.id, { endpoint: 'https://push.example/sub', keys: { p256dh: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } })
    fix.push.mockResolvedValueOnce({ status: 410, gone: true, retryAfter: null, body: '' })
    const result = await fix.service.testNotification(phone.id)
    expect(result).toEqual({ sent: 0, message: expect.stringContaining('dropped its subscription') })
    expect(fix.service.desktopState().devices[0]?.pushEnabled).toBe(false)
    expect(await fix.service.testNotification(phone.id)).toEqual({ sent: 0, message: 'That phone has not turned notifications on.' })
    fix.service.setSubscription(phone.id, { endpoint: 'https://push.example/sub2', keys: { p256dh: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } })
    fix.service.updateSettings({ notifications: false })
    expect(await fix.service.sendNotification({ id: 'n', kind: 'done', sessionId: 'a', title: 't', body: 'b', at: 'now', url: '/' })).toEqual({ sent: 0, message: 'Notifications are switched off.' })
    // A test still goes out, so the owner can check the pipe even while quiet.
    expect(await fix.service.testNotification(phone.id)).toEqual({ sent: 1, message: null })
    expect(fix.service.self(phone.id).vapidPublicKey).toBeNull()
  })
})
