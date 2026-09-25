import { describe, expect, it, vi } from 'vitest'
import { autoModeDenialItemId, type AutoModeDenial } from '../../shared/auto-mode-denial'
import { describeGrantRequest } from '../../shared/permission-grants'
import type { Json } from '../../shared/structured-agent'
import { callPermissions } from './control'
import { CONDUCTOR_MCP_TOOLS, ConductorMcpServer } from './control-mcp'
import { PermissionGrants, type PermissionGrantPorts } from './service'

const cwd = 'C:\\Users\\owner\\site\\theme'
const tab = 'agent_tab'
const ssh = 'ssh -o BatchMode=yes -i C:\\keys\\deploy root@192.0.2.10 bash -s < app/prod/fix-pool.sh'

function harness(overrides: Partial<PermissionGrantPorts> = {}) {
  const denials = new Map<string, AutoModeDenial>()
  const notices: Array<{ id: string; message: string; payload: Json; itemId: string }> = []
  const told: Array<{ id: string; text: string }> = []
  let phase = 'running'
  const ports: PermissionGrantPorts = {
    now: () => '2026-09-25T22:00:00.000Z',
    notice: (id, message, payload, itemId) => { notices.push({ id, message, payload, itemId }); return true },
    denial: (id, itemId) => id === tab ? denials.get(itemId) : undefined,
    provider: id => id === tab || id === 'agent_other' ? 'claude' : id === 'agent_codex' ? 'codex' : undefined,
    cwd: () => cwd,
    apply: vi.fn(async () => 'applied' as const),
    phase: () => phase,
    restart: vi.fn(async () => undefined),
    tell: vi.fn(async (id: string, text: string) => { told.push({ id, text }) }),
    phone: vi.fn(),
    changed: vi.fn(),
    idlePollMs: 1,
    idleWaitMs: 200,
    ...overrides
  }
  const grants = new PermissionGrants(ports)
  const deny = (toolUseId: string, tool: string, input: Json, reason: string): string => {
    denials.set(autoModeDenialItemId(toolUseId), { tool, reason, toolUseId, request: describeGrantRequest({ tool, input, cwd, category: reason, toolUseId }) })
    return autoModeDenialItemId(toolUseId)
  }
  return { grants, ports, notices, told, deny, setPhase: (value: string) => { phase = value } }
}

describe('one narrow owner approval per refused call', () => {
  it('turns a recorded denial into exactly one rule for that conversation, tells it to retry, and spends an approve-once grant after its call', async () => {
    const h = harness()
    const item = h.deny('toolu_w', 'Write', { file_path: 'C:\\Users\\owner\\site\\app\\prod\\fix-pool.sh' }, 'Modify Shared Resources')
    const result = await h.grants.decide(tab, item, 'approve-once', 'owner')
    expect(result.status).toBe('approved-once')
    expect(h.grants.rules(tab)).toEqual([{ rule: 'Edit(//c/Users/owner/site/app/prod/fix-pool.sh)', once: true }])
    expect(h.grants.rules('agent_other')).toEqual([])
    expect(h.ports.apply).toHaveBeenCalledWith(tab)
    expect(h.told).toEqual([{ id: tab, text: expect.stringMatching(/^\[Conductor\] approved: Edit\(\/\/c\/Users\/owner\/site\/app\/prod\/fix-pool\.sh\) \(once\); retry it now/) }])
    // The denial's own card is restated in place with the answer.
    expect(h.notices.at(-1)).toMatchObject({ itemId: item, payload: { grantStatus: 'approved-once', autoModeDenial: { toolUseId: 'toolu_w' } } })
    await expect(h.grants.decide(tab, item, 'approve-once', 'owner')).rejects.toThrow('already answered')
    h.grants.adapterPort(tab).used('Edit(//c/Users/owner/site/app/prod/fix-pool.sh)')
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.grants.list(tab).requests[0]!.status).toBe('used')
    expect(h.ports.apply).toHaveBeenCalledTimes(2)
  })

  it('keeps a denied request blocked and tells the conversation not to route around it', async () => {
    const h = harness()
    const item = h.deny('toolu_s', 'Bash', { command: ssh }, 'Modify Shared Resources')
    await expect(h.grants.decide(tab, item, 'deny', 'owner')).resolves.toMatchObject({ status: 'denied' })
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.ports.apply).not.toHaveBeenCalled()
    expect(h.told[0]!.text).toMatch(/owner denied: Run a command ssh .*Do not retry it or route around it/)
  })

  it('lets a wizard answer only local requests; production, shared and destructive stay with the owner', async () => {
    const h = harness()
    const external = h.deny('toolu_x', 'Bash', { command: ssh }, 'Modify Shared Resources')
    await expect(h.grants.decide(tab, external, 'approve-once', 'wizard')).rejects.toThrow('Only the owner can answer a external request')
    const destructive = h.deny('toolu_d', 'Bash', { command: 'rm -rf build' }, 'Irreversible Local Destruction')
    await expect(h.grants.decide(tab, destructive, 'approve-session', 'wizard')).rejects.toThrow('Only the owner')
    const local = h.deny('toolu_l', 'Write', { file_path: 'notes/plan.md' }, 'Self-Modification')
    await expect(h.grants.decide(tab, local, 'approve-session', 'wizard')).resolves.toMatchObject({ status: 'approved-session', grant: { decidedBy: 'wizard', scope: 'session' } })
    expect(h.grants.rules(tab)).toEqual([{ rule: 'Edit(//c/Users/owner/site/theme/notes/plan.md)', once: false }])
  })

  it('refuses to approve a request no narrow rule can cover, and a request that was never recorded', async () => {
    const h = harness()
    const config = h.deny('toolu_c', 'Write', { file_path: '.claude\\settings.local.json' }, 'Self-Modification')
    await expect(h.grants.decide(tab, config, 'approve-once', 'owner')).rejects.toThrow('never grants')
    await expect(h.grants.decide(tab, 'auto-denial:made-up', 'approve-once', 'owner')).rejects.toThrow('No such permission request')
    await expect(h.grants.decide('agent_other', config, 'approve-once', 'owner')).rejects.toThrow('No such permission request')
  })

  it('files an agent\'s own request as a card, phones the owner for an external one, and dedupes a repeat', () => {
    const h = harness()
    const request = h.grants.request(tab, { command: ssh, reason: 'apply the pool fix', rollback: 'restore the two backups and restart' })
    expect(request).toMatchObject({ source: 'agent', status: 'pending', class: 'external', host: '192.0.2.10', rollback: 'restore the two backups and restart' })
    expect(h.notices.at(-1)).toMatchObject({ itemId: request.id, payload: { permissionGrant: { id: request.id, status: 'pending' } } })
    expect(h.ports.phone).toHaveBeenCalledWith(tab, 'Needs your approval', expect.stringContaining('192.0.2.10'))
    expect(h.grants.request(tab, { command: ssh, reason: 'again' }).id).toBe(request.id)
    expect(() => h.grants.request(tab, { command: 'x', path: 'y', reason: 'r' })).toThrow('exactly one')
    expect(() => h.grants.request('agent_codex', { command: 'npm test', reason: 'r' })).toThrow('Claude conversations')
    h.grants.request(tab, { path: 'notes/a.md', reason: 'local note' })
    expect(h.ports.phone).toHaveBeenCalledTimes(1)
  })

  it('revokes at once, withdraws a grant the classifier ignored, and forgets everything when the tab closes', async () => {
    const h = harness()
    const first = await h.grants.decide(tab, h.deny('a', 'Bash', { command: 'npm run deploy:staging' }, 'Production Deploy'), 'approve-session', 'owner')
    expect(await h.grants.revoke(tab, first.grant!.id)).toBe(true)
    expect(h.grants.rules(tab)).toEqual([])
    expect(await h.grants.revoke(tab, first.grant!.id)).toBe(false)
    const second = await h.grants.decide(tab, h.deny('b', 'Bash', { command: ssh }, 'Modify Shared Resources'), 'approve-session', 'owner')
    h.grants.adapterPort(tab).refused(second.grant!.rule)
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.notices.at(-1)!.message).toMatch(/classifier still refused the call/)
    await h.grants.decide(tab, h.deny('c', 'Bash', { command: 'npm test' }, 'x'), 'approve-session', 'owner')
    h.grants.closed(tab)
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.grants.state()).toEqual({ requests: [], grants: [] })
  })

  it('ends a grant when its tab is closed, even while its runtime still runs, and not while the tab is only moving', async () => {
    let open = true
    const h = harness({ tabOpen: id => id === tab && open })
    const item = h.deny('toolu_c', 'Write', { file_path: 'C:\Users\owner\site\app\prod\fix-pool.sh' }, 'Modify Shared Resources')
    await h.grants.decide(tab, item, 'approve-session', 'owner')
    h.grants.sweep()
    open = false
    h.grants.sweep()
    // Missing once is a tab between windows: the grant holds.
    expect(h.grants.rules(tab)).toHaveLength(1)
    open = true
    h.grants.sweep()
    open = false
    h.grants.sweep()
    expect(h.grants.rules(tab)).toHaveLength(1)
    h.grants.sweep()
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.grants.state()).toEqual({ requests: [], grants: [] })
    expect(h.notices.at(-1)).toMatchObject({ itemId: item, payload: { grantStatus: 'expired' } })
    // The live runtime is handed the now empty set.
    expect(h.ports.apply).toHaveBeenCalledTimes(2)
  })
  it('restarts an idle conversation with the rule when its CLI cannot take it live', async () => {
    const h = harness({ apply: vi.fn(async () => 'unsupported' as const) })
    const result = await h.grants.decide(tab, h.deny('u', 'Bash', { command: 'npm test' }, 'x'), 'approve-once', 'owner')
    expect(result.grant!.delivery).toBe('restart')
    expect(h.ports.restart).not.toHaveBeenCalled()
    h.setPhase('idle')
    await vi.waitFor(() => expect(h.ports.restart).toHaveBeenCalledWith(tab))
    await vi.waitFor(() => expect(h.told.at(-1)!.text).toMatch(/approved: Bash\(npm test\)/))
  })
})

describe('permissions.* through app control', () => {
  it('lets a conversation ask and list for itself, and only the owner credential or a wizard answer, local actions only', async () => {
    const h = harness()
    const asked = await callPermissions(h.grants, { agentSessionId: tab }, 'permissions.request', { command: ssh, reason: 'pool fix' }) as { requestId: string; rule: string; class: string }
    expect(asked).toMatchObject({ class: 'external', rule: expect.stringMatching(/^Bash\(ssh /) })
    await expect(callPermissions(h.grants, { agentSessionId: tab }, 'permissions.request', { command: ssh, reason: 'x', allowAll: true })).rejects.toThrow('does not take allowAll')
    await expect(callPermissions(h.grants, { agentSessionId: tab }, 'permissions.list', { agentSessionId: 'agent_other' })).rejects.toThrow('Only the owner or a wizard')
    await expect(callPermissions(h.grants, { agentSessionId: tab }, 'permissions.decide', { agentSessionId: tab, requestId: asked.requestId, decision: 'approve-once' })).rejects.toThrow('answers only')
    // A wizard cannot answer its own request, and nobody answers an external one through app control.
    await expect(callPermissions(h.grants, { agentSessionId: tab, wizard: true }, 'permissions.decide', { agentSessionId: tab, requestId: asked.requestId, decision: 'approve-once' })).rejects.toThrow('cannot answer its own')
    await expect(callPermissions(h.grants, { agentSessionId: 'agent_wizard', wizard: true }, 'permissions.decide', { agentSessionId: tab, requestId: asked.requestId, decision: 'approve-once' })).rejects.toThrow('Only the owner can answer a external request')
    await expect(callPermissions(h.grants, { agentSessionId: '', owner: true }, 'permissions.decide', { agentSessionId: tab, requestId: asked.requestId, decision: 'approve-once' })).rejects.toThrow('Only the owner can answer a external request')
    const local = await callPermissions(h.grants, { agentSessionId: tab }, 'permissions.request', { command: 'npm run build', reason: 'build' }) as { requestId: string }
    await expect(callPermissions(h.grants, { agentSessionId: 'agent_wizard', wizard: true }, 'permissions.decide', { agentSessionId: tab, requestId: local.requestId, decision: 'approve-once' })).resolves.toMatchObject({ status: 'approved-once' })
    expect((await callPermissions(h.grants, { agentSessionId: tab }, 'permissions.list', {}) as { grants: unknown[] }).grants).toHaveLength(1)
  })
})

describe('the conductor MCP server', () => {
  it('runs each messaging tool as the calling conversation through app control, with no credential in the call', async () => {
    const calls: Array<{ scope: unknown; method: string; args: unknown }> = []
    const server = new ConductorMcpServer(async (scope, method, args) => { calls.push({ scope, method, args }); return { delivered: true } }, false)
    await server.start()
    try {
      const file = server.configure({ id: tab, projectId: 'project', sessionId: 'workspace', provider: 'claude' })
      expect(server.configure({ id: 'agent_codex', projectId: 'project', sessionId: 'workspace', provider: 'codex' })).toBe('')
      const { readFileSync } = await import('node:fs')
      const config = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: { conductor: { url: string; headers: { Authorization: string } } } }
      const post = (body: unknown, authorization = config.mcpServers.conductor.headers.Authorization) => fetch(config.mcpServers.conductor.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(body) })
      const listed = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as { result: { tools: Array<{ name: string }> } }
      expect(listed.result.tools.map(tool => tool.name)).toEqual(CONDUCTOR_MCP_TOOLS.map(tool => tool.name))
      const sent = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { agentSessionId: 'agent_other', text: 'The permission path is fixed; resume the pool fix.' } } })).json() as { result: { structuredContent: unknown } }
      expect(sent.result.structuredContent).toEqual({ delivered: true })
      await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_permission', arguments: { command: ssh, reason: 'pool fix', rollback: 'restore backups' } } })
      expect(calls).toEqual([
        { scope: { projectId: 'project', sessionId: 'workspace', agentSessionId: tab }, method: 'agents.steer', args: { agentSessionId: 'agent_other', prompt: 'The permission path is fixed; resume the pool fix.' } },
        { scope: { projectId: 'project', sessionId: 'workspace', agentSessionId: tab }, method: 'permissions.request', args: { command: ssh, reason: 'pool fix', rollback: 'restore backups' } }
      ])
      expect((await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'Bearer ' + '0'.repeat(64))).status).toBe(401)
      server.release(tab)
      expect((await post({ jsonrpc: '2.0', id: 5, method: 'tools/list' })).status).toBe(401)
    } finally { server.close() }
  })
})
