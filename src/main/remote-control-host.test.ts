import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RemotePeerRecord, RemoteProjectSummary } from '../shared/remote-control'
import type { ConductorDatabase } from './database'
import type { ProjectBacklogs } from './project-backlog'
import { RemoteControlHost } from './remote-control-host'
import { RemoteAccessError, type RemotePeers } from './remote-peers'
import type { StructuredSessions } from './structured-sessions'

/**
 * The host is where an authenticated peer's calls meet this machine's disk and its tabs, so these
 * cover what it must refuse even after every signature has already checked out.
 */
const root = mkdtempSync(join(tmpdir(), 'conductor-remote-host-'))
const shared = join(root, 'shared')
const private_ = join(root, 'private')
mkdirSync(shared)
mkdirSync(private_)
writeFileSync(join(shared, 'notes.md'), 'shared notes')
writeFileSync(join(private_, 'secrets.env'), 'GITHUB_TOKEN=ghp_realsecret')
// A junction is the escape route a lexical check alone would miss.
let junction = false
try { symlinkSync(private_, join(shared, 'escape'), 'junction'); junction = true } catch { /* needs privilege on some hosts */ }
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const PROJECTS: RemoteProjectSummary[] = [{ id: 'shared-project', name: 'Shared', path: shared }]

const peer: RemotePeerRecord = {
  id: 'peer-1', machineId: 'laptop', machineName: 'Laptop', accountId: 4242, accountLogin: 'Empire024',
  keyFingerprint: 'SHA256:x', publicKey: 'ssh-ed25519 x', grantedProjectIds: ['shared-project'],
  approvedAt: new Date(0).toISOString(), lastSeenAt: null, revokedAt: null
}

function fixture() {
  const opened: Array<Record<string, unknown>> = []
  const updated: Array<Record<string, unknown>> = []
  const peers = {
    machineId: 'host-machine',
    requireProject: (_peer: RemotePeerRecord, projectId: unknown) => {
      const project = PROJECTS.find(entry => entry.id === projectId)
      if (!project || !peer.grantedProjectIds.includes(project.id)) throw new RemoteAccessError('That project was not shared with this machine.', 403)
      return project
    },
    record: vi.fn()
  } as unknown as RemotePeers
  const database = {
    getProject: (id: string) => PROJECTS.find(entry => entry.id === id) ?? null,
    getSession: (id: string) => id === 'workspace-1' ? { id, projectId: 'shared-project', layout: { version: 1, root: { type: 'group', id: 'group-1', tabs: [] } } } : null,
    listSessions: () => [{ id: 'workspace-1', projectId: 'shared-project', name: 'Main' }],
    listDetachedWindows: () => [],
    structured: { snapshot: () => ({ settings: { model: 'model-a', permission: 'bypass' }, phase: 'idle', items: [] }), events: () => [], update: (id: string, patch: Record<string, unknown>) => { updated.push({ id, ...patch }) } }
  } as unknown as ConductorDatabase
  const host = new RemoteControlHost({
    database,
    sessions: { ensure: () => ({ available: true }), submit: vi.fn(), steer: vi.fn(), interrupt: vi.fn() } as unknown as StructuredSessions,
    backlogs: { get: vi.fn(), edit: vi.fn() } as unknown as ProjectBacklogs,
    peers,
    providers: () => [{ id: 'codex', available: true, models: [{ id: 'model-a', label: 'Model A', isDefault: true }] }],
    ui: async request => { opened.push(request as unknown as Record<string, unknown>); return { ok: true } },
    fileChanged: vi.fn(),
    machineName: () => 'Render Desktop'
  })
  const call = (method: string, args: Record<string, unknown>): Promise<unknown> => host.call(peer, method, args)
  const refusal = (method: string, args: Record<string, unknown>): Promise<string> =>
    call(method, args).then(() => 'ALLOWED', error => (error as Error).message)
  return { host, call, refusal, opened, updated }
}

let fix: ReturnType<typeof fixture>
beforeEach(() => { fix = fixture() })

/** Every shape of "somewhere else on this disk" a remote caller could name. */
const escapes: Array<[string, string]> = [
  ['a parent-relative path', '../private/secrets.env'],
  ['a Windows parent-relative path', '..\\private\\secrets.env'],
  ['a path that climbs through a real file', 'notes.md/../../private/secrets.env'],
  ['a doubled-separator path', './/..//private//secrets.env'],
  ['an absolute path', join(private_, 'secrets.env')],
  ['a POSIX-rooted path', '/etc/passwd'],
  ['a drive-relative path', 'C:secrets.env'],
  ['a UNC path', '\\\\127.0.0.1\\C$\\Windows\\win.ini'],
  ['a drive-root path', '\\Windows\\win.ini'],
  ...(junction ? [['a junction out of the project', 'escape/secrets.env'] as [string, string]] : [])
]

describe('what a paired machine may read and write', () => {
  it('reads a file inside the project it was granted', async () => {
    await expect(fix.call('files.read', { projectId: 'shared-project', path: 'notes.md' }))
      .resolves.toMatchObject({ path: 'notes.md', content: 'shared notes' })
  })

  it.each(escapes)('refuses to read through %s', async (_label, path) => {
    const message = await fix.refusal('files.read', { projectId: 'shared-project', path })
    expect(message).not.toBe('ALLOWED')
    expect(message).toMatch(/outside the session workspace|Invalid workspace path|leaves the session workspace/)
  })

  it.each(escapes)('refuses to write through %s', async (_label, path) => {
    const message = await fix.refusal('files.write', { projectId: 'shared-project', path, content: 'owned', expectedContent: null })
    expect(message).not.toBe('ALLOWED')
    expect(readFileSync(join(private_, 'secrets.env'), 'utf8')).toBe('GITHUB_TOKEN=ghp_realsecret')
  })

  it.each(escapes)('refuses to open %s in the owner editor', async (_label, path) => {
    expect(await fix.refusal('files.open', { projectId: 'shared-project', sessionId: 'workspace-1', path })).not.toBe('ALLOWED')
    expect(fix.opened).toHaveLength(0)
  })

  it('refuses every file method for a project that was never shared', async () => {
    for (const method of ['files.read', 'files.list', 'files.write', 'files.open']) {
      expect(await fix.refusal(method, { projectId: 'other-project', sessionId: 'workspace-1', path: 'notes.md', content: '', expectedContent: null }))
        .toMatch(/not shared with this machine/)
    }
  })

  it('refuses a path carrying a NUL byte', async () => {
    expect(await fix.refusal('files.read', { projectId: 'shared-project', path: 'notes.md\0.png' })).toMatch(/Invalid path/)
  })
})

describe('what a paired machine may open', () => {
  it('opens an agent tab with the default permission, never the one the tab already had', async () => {
    await fix.call('tabs.open', { projectId: 'shared-project', sessionId: 'workspace-1' })
      .catch(() => { /* the stub UI does not really add the tab; the settings write is the point */ })
    expect(fix.updated[0]).toMatchObject({ settings: { permission: 'default' } })
  })

  it('refuses to spawn a terminal, which the approval prompt promises it cannot', async () => {
    expect(await fix.refusal('tabs.open', { projectId: 'shared-project', sessionId: 'workspace-1', kind: 'terminal' }))
      .toMatch(/Unsupported remote tab kind/)
    expect(fix.opened).toHaveLength(0)
  })

  it('refuses a workspace that belongs to a project it was not granted', async () => {
    expect(await fix.refusal('tabs.list', { projectId: 'shared-project', sessionId: 'someone-elses-workspace' }))
      .toMatch(/not in the shared project/)
  })
})

describe('which method names reach the host at all', () => {
  it('refuses names inherited from Object.prototype, which `in` would have accepted', async () => {
    for (const method of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(await fix.refusal(method, { projectId: 'shared-project', sessionId: 'workspace-1' })).toMatch(/Unknown remote method/)
    }
  })

  it('lists exactly the methods it will answer', async () => {
    const listed = await fix.call('tools.list', {}) as Record<string, string>
    expect(Object.keys(listed)).not.toContain('terminal.write')
    expect(await fix.refusal('shell.exec', { projectId: 'shared-project' })).toMatch(/Unknown remote method/)
  })
})
