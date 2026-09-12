import { describe, expect, it, vi } from 'vitest'
import type { RemoteConnection, RemoteProjectSummary } from '../shared/remote-control'
import type { RemoteControlClient } from './remote-control-client'
import { RemoteFiles } from './remote-files'

describe('remote files retain current controller identity authority', () => {
  it.each(['removed', 'unreadable'] as const)('rejects a pending host read when controller identity becomes %s', async failure => {
    const localIdentity = { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: 'C:/controller/project', name: 'Project' }
    const remoteIdentity = { key: 'b'.repeat(32), keyCreatedAt: '2026-02-01T00:00:00.000Z', path: 'D:/host/project', name: 'Project' }
    const advertised: RemoteProjectSummary = { id: 'host-project', name: 'Project', path: remoteIdentity.path, identity: remoteIdentity, identityError: null }
    let local: RemoteProjectSummary | null = { id: 'local-project', name: 'Project', path: localIdentity.path, identity: localIdentity, identityError: null }
    const connection: RemoteConnection = {
      machineId: 'host-machine', machineName: 'Host', accountLogin: 'owner', host: '127.0.0.1', port: 51840,
      fingerprint: 'AA', peerId: 'peer-1', projectGrants: [{ localProjectId: 'local-project', local: localIdentity, remoteProjectId: 'host-project', remote: remoteIdentity, confirmedAt: '2026-02-02T00:00:00.000Z' }],
      remoteProjects: [advertised], remoteProjectsAt: null, unconfirmedRemoteProjectIds: [], connectedAt: new Date(0).toISOString(), lastContactAt: null, status: 'connected', message: null
    }
    let reply!: (value: unknown) => void
    const body = new Promise<unknown>(resolve => { reply = resolve })
    const call = vi.fn(async (_machine: string, method: string) => method === 'projects.list' ? [advertised] : body)
    const client = { get: () => connection, authorityRevision: () => 0, call } as unknown as RemoteControlClient
    const files = new RemoteFiles({ client, project: () => local })
    const pending = files.read({ machineId: 'host-machine', projectId: 'local-project', path: 'secret.txt' })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    local = failure === 'removed' ? null : { ...local!, identity: null, identityError: 'Project identity is unreadable' }
    reply({ content: 'host bytes returned after the local authority disappeared' })
    await expect(pending).rejects.toThrow(/identity|project|access/i)
  })
})
