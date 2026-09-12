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
writeFileSync(join(shared, 'unicode.txt'), '€'.repeat(40_000))
writeFileSync(join(shared, 'frame.png'), Buffer.from('0123456789abcdef'))
writeFileSync(join(shared, 'active.svg'), '<svg><script>alert(1)</script></svg>')
writeFileSync(join(private_, 'secrets.env'), 'GITHUB_TOKEN=ghp_realsecret')
// A junction is the escape route a lexical check alone would miss.
let junction = false
try { symlinkSync(private_, join(shared, 'escape'), 'junction'); junction = true } catch { /* needs privilege on some hosts */ }
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const sharedIdentity = { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: shared, name: 'Shared' }
const PROJECTS: RemoteProjectSummary[] = [{ id: 'shared-project', name: 'Shared', path: shared, identity: sharedIdentity, identityError: null }]

const peer: RemotePeerRecord = {
  id: 'peer-1', machineId: 'laptop', machineName: 'Laptop', accountId: 4242, accountLogin: 'Empire024',
  keyFingerprint: 'SHA256:x', publicKey: 'ssh-ed25519 x', grantedProjects: [{ projectId: 'shared-project', identity: sharedIdentity }],
  approvedAt: new Date(0).toISOString(), lastSeenAt: null, revokedAt: null
}

function fixture() {
  const opened: Array<Record<string, unknown>> = []
  const updated: Array<Record<string, unknown>> = []
  let currentAuthority = true
  let authorityRevision = 0
  const requireProject = (_peer: RemotePeerRecord, projectId: unknown) => {
    const project = PROJECTS.find(entry => entry.id === projectId)
    if (!project || !peer.grantedProjects.some(granted => granted.projectId === project.id)) throw new RemoteAccessError('That project was not shared with this machine.', 403)
    return project
  }
  const peers = {
    machineId: 'host-machine',
    requireProject,
    requireCurrentProject: (subject: RemotePeerRecord, projectId: unknown, expectedRevision?: number) => {
      if (!currentAuthority || expectedRevision !== undefined && expectedRevision !== authorityRevision) throw new RemoteAccessError('Remote access changed while this request was pending.', 403, 'peer-revoked')
      return requireProject(subject, projectId)
    },
    captureProjectAuthority: (subject: RemotePeerRecord, projectId: unknown) => ({ project: requireProject(subject, projectId), revision: authorityRevision }),
    sharedProjects: (subject: RemotePeerRecord) => PROJECTS.filter(project => subject.grantedProjects.some(granted => granted.projectId === project.id)),
    record: vi.fn()
  } as unknown as RemotePeers
  const database = {
    getProject: (id: string) => PROJECTS.find(entry => entry.id === id) ?? null,
    getSession: (id: string) => id === 'workspace-1' ? { id, projectId: 'shared-project', layout: { version: 1, root: { type: 'group', id: 'group-1', activeTabId: 'agent-tab', tabs: [{ id: 'agent-tab', kind: 'agent', title: 'Remote agent', resourceId: 'agent-remote', state: { provider: 'codex' } }] } } } : null,
    listSessions: () => [{ id: 'workspace-1', projectId: 'shared-project', name: 'Main' }],
    listDetachedWindows: () => [],
    structured: { snapshot: () => ({ sessionId: 'agent-remote', runtimeId: 'runtime-remote', settings: { model: 'model-a', permission: 'default', plan: false }, phase: 'idle', items: [], sequence: 0, title: '', archived: false, truncated: false }), events: () => [], update: (id: string, patch: Record<string, unknown>) => { updated.push({ id, ...patch }) } }
  } as unknown as ConductorDatabase
  const sessions = {
    ensure: vi.fn(() => ({ available: true })), submit: vi.fn(), steer: vi.fn(), queue: vi.fn(), cancelQueued: vi.fn(() => null),
    interrupt: vi.fn(), resume: vi.fn(), discover: vi.fn(async () => ({ commands: ['remote'] })), saveSettings: vi.fn(),
    respond: vi.fn(), rename: vi.fn(), archive: vi.fn()
  }
  const host = new RemoteControlHost({
    database,
    sessions: sessions as unknown as StructuredSessions,
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
  return {
    host, call, refusal, opened, updated, sessions,
    revoke: () => { currentAuthority = false; authorityRevision++ },
    cycleAuthority: () => { authorityRevision++ }
  }
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

  it('rechecks current authority after asynchronous path resolution before reading', async () => {
    const pending = fix.call('files.read', { projectId: 'shared-project', path: 'notes.md' })
    fix.revoke()
    await expect(pending).rejects.toThrow(/access changed/)
  })

  it('rechecks current authority before a write and leaves the host file unchanged', async () => {
    writeFileSync(join(shared, 'race.md'), 'before')
    const pending = fix.call('files.write', { projectId: 'shared-project', path: 'race.md', content: 'after', expectedContent: 'before' })
    fix.revoke()
    await expect(pending).rejects.toThrow(/access changed/)
    expect(readFileSync(join(shared, 'race.md'), 'utf8')).toBe('before')
  })

  it('rejects an exact disable/re-enable generation change during path resolution', async () => {
    const pending = fix.call('files.read', { projectId: 'shared-project', path: 'notes.md' })
    fix.cycleAuthority()
    await expect(pending).rejects.toThrow(/access changed/)
  })

  it('lists and stats only relative host paths without disclosing its absolute root', async () => {
    await expect(fix.call('files.list', { projectId: 'shared-project', path: '' })).resolves.toContainEqual({ name: 'notes.md', path: 'notes.md', kind: 'file' })
    const result = await fix.call('files.stat', { projectId: 'shared-project', path: 'notes.md' }) as Record<string, unknown>
    expect(result).toMatchObject({ size: 12, isFile: true })
    expect(result.modifiedAt).toEqual(expect.any(String))
  })

  it('serves allowlisted media only through bounded chunks tied to one stable file version', async () => {
    const described = await fix.call('files.describe', { projectId: 'shared-project', path: 'frame.png' }) as Record<string, unknown>
    expect(described).toMatchObject({ path: 'frame.png', size: 16, kind: 'image', mimeType: 'image/png' })
    expect(described.version).toMatch(/^[a-f0-9]{64}$/)
    const first = await fix.call('files.readChunk', {
      projectId: 'shared-project', path: 'frame.png', offset: 0, length: 6, version: described.version
    }) as Record<string, unknown>
    const second = await fix.call('files.readChunk', {
      projectId: 'shared-project', path: 'frame.png', offset: 6, length: 20, version: described.version
    }) as Record<string, unknown>
    expect(Buffer.concat([
      Buffer.from(String(first.bytesBase64), 'base64'), Buffer.from(String(second.bytesBase64), 'base64')
    ]).toString()).toBe('0123456789abcdef')
    expect(first).toMatchObject({ offset: 0, length: 6, totalSize: 16, eof: false })
    expect(second).toMatchObject({ offset: 6, length: 10, totalSize: 16, eof: true })
  })

  it('refuses active media and invalid or stale ranges', async () => {
    await expect(fix.call('files.describe', { projectId: 'shared-project', path: 'active.svg' })).rejects.toThrow(/safe raster images/)
    const described = await fix.call('files.describe', { projectId: 'shared-project', path: 'frame.png' }) as Record<string, unknown>
    await expect(fix.call('files.readChunk', {
      projectId: 'shared-project', path: 'frame.png', offset: 0, length: 256 * 1024 + 1, version: described.version
    })).rejects.toThrow(/range or version/)
    writeFileSync(join(shared, 'frame.png'), Buffer.from('changed-and-longer-content'))
    await expect(fix.call('files.readChunk', {
      projectId: 'shared-project', path: 'frame.png', offset: 0, length: 4, version: described.version
    })).rejects.toThrow(/range or version/)
    writeFileSync(join(shared, 'frame.png'), Buffer.from('0123456789abcdef'))
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
    for (const method of ['files.read', 'files.list', 'files.stat', 'files.write', 'files.open']) {
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

describe('remote structured conversation operations', () => {
  const base = { projectId: 'shared-project', sessionId: 'workspace-1', agentSessionId: 'agent-remote' }
  const settings = { model: 'model-a', permission: 'default', plan: false }

  it('executes every supported lifecycle operation on the host session with the remote origin', async () => {
    await fix.call('agents.submit', {
      ...base, prompt: 'now', settings,
      origin: { authority: { kind: 'remote-peer', peerId: 'attacker', projectId: 'other-project' } }
    })
    await fix.call('agents.steer', { ...base, prompt: 'next', settings })
    await fix.call('agents.queue', { ...base, prompt: 'later', settings })
    await fix.call('agents.cancelQueued', { ...base, promptId: 'queued-1' })
    await fix.call('agents.interrupt', { ...base, expediteSubmittedInput: true })
    await fix.call('agents.resume', { ...base, settings })
    await expect(fix.call('agents.discover', base)).resolves.toEqual({ commands: ['remote'] })
    await fix.call('agents.settings', { ...base, settings })
    await fix.call('agents.respond', { ...base, response: { sessionId: 'controller-copy', runtimeId: 'runtime-remote', requestId: 'approval', decision: 'allow' } })
    await fix.call('agents.rename', { ...base, title: 'New title' })
    await fix.call('agents.archive', { ...base, archived: true })

    expect(fix.sessions.submit).toHaveBeenCalledWith('agent-remote', 'now', settings, [], expect.objectContaining({ label: 'Laptop (remote)' }))
    expect(fix.sessions.submit).toHaveBeenCalledWith('agent-remote', 'now', settings, [], expect.objectContaining({
      authority: { kind: 'remote-peer', peerId: peer.id, projectId: 'shared-project' }
    }))
    expect(fix.sessions.steer).toHaveBeenCalledWith('agent-remote', 'next', settings, [], expect.any(Object))
    expect(fix.sessions.queue).toHaveBeenCalledWith('agent-remote', 'later', settings, [], expect.any(Object))
    expect(fix.sessions.interrupt).toHaveBeenCalledWith('agent-remote', true)
    expect(fix.sessions.resume).toHaveBeenCalledWith('agent-remote', settings)
    expect(fix.sessions.saveSettings).toHaveBeenCalledWith('agent-remote', settings)
    expect(fix.sessions.respond).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'agent-remote', requestId: 'approval' }))
    expect(fix.sessions.rename).toHaveBeenCalledWith('agent-remote', 'New title')
    expect(fix.sessions.archive).toHaveBeenCalledWith('agent-remote', true)
  })

  it('rejects malformed lifecycle arguments at the host boundary', async () => {
    await expect(fix.call('agents.cancelQueued', { ...base, promptId: 42 })).rejects.toThrow(/Invalid promptId/)
    await expect(fix.call('agents.archive', { ...base, archived: 'yes' })).rejects.toThrow(/Invalid archived/)
    await expect(fix.call('agents.respond', { ...base, response: null })).rejects.toThrow(/Invalid response/)
  })

  it('reads remote prompt context from the host project and never accepts controller-supplied bytes or paths', async () => {
    await fix.call('agents.submit', {
      ...base, prompt: 'use host notes', settings,
      attachments: [{
        id: 'remote-notes', kind: 'file', name: 'notes.md',
        remoteFile: { machineId: 'host-machine', projectId: 'shared-project', path: 'notes.md' }
      }]
    })
    expect(fix.sessions.submit).toHaveBeenLastCalledWith('agent-remote', 'use host notes', settings, [{
      id: 'remote-notes', kind: 'file', name: 'notes.md', content: 'shared notes'
    }], expect.objectContaining({ label: 'Laptop (remote)' }))

    await expect(fix.call('agents.submit', {
      ...base, prompt: 'supplied bytes', settings,
      attachments: [{
        id: 'bad', kind: 'file', name: 'notes.md', content: 'controller bytes',
        remoteFile: { machineId: 'host-machine', projectId: 'shared-project', path: 'notes.md' }
      }]
    })).rejects.toThrow(/without supplied content/)
    await expect(fix.call('agents.submit', {
      ...base, prompt: 'escape', settings,
      attachments: [{
        id: 'bad-path', kind: 'file', name: 'secret',
        remoteFile: { machineId: 'host-machine', projectId: 'shared-project', path: '../private/secrets.env' }
      }]
    })).rejects.toThrow(/outside the session workspace|Invalid workspace path/)
  })

  it('lets revocation win while host attachment bytes are being resolved', async () => {
    const pending = fix.call('agents.submit', {
      ...base, prompt: 'must not dispatch', settings,
      attachments: [{
        id: 'remote-notes', kind: 'file', name: 'notes.md',
        remoteFile: { machineId: 'host-machine', projectId: 'shared-project', path: 'notes.md' }
      }]
    })
    fix.revoke()
    await expect(pending).rejects.toThrow(/access changed/)
    expect(fix.sessions.submit).not.toHaveBeenCalled()
  })

  it('bounds aggregate remote attachment context by UTF-8 bytes', async () => {
    const attachments = ['one', 'two', 'three'].map(id => ({
      id, kind: 'file', name: 'unicode.txt',
      remoteFile: { machineId: 'host-machine', projectId: 'shared-project', path: 'unicode.txt' }
    }))
    await expect(fix.call('agents.submit', {
      ...base, prompt: 'too much context', settings, attachments
    })).rejects.toThrow(/Total remote file context exceeds 250 KB/)
    expect(fix.sessions.submit).not.toHaveBeenCalled()
  })
})
