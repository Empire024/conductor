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
  const deny = (toolUseId: string, tool: string, input: Json, reason: string, shown = false): string => {
    const denial = { tool, reason, toolUseId, request: describeGrantRequest({ tool, input, cwd, category: reason, toolUseId }) }
    denials.set(autoModeDenialItemId(toolUseId), denial)
    // shown: the adapter shows the card and reports it (adapterPort.denied), as the Claude adapter does.
    if (shown) grants.adapterPort(tab).denied(autoModeDenialItemId(toolUseId), denial.request)
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

describe('a pending owner approval survives a handoff (grant-survives-handoff)', () => {
  const successor = 'agent_other'
  const script = 'app/prod/fix-pool.sh'

  it('moves a pending request to the successor: its list and card show it with the holder, the approval tells the successor, and it consumes it exactly once', async () => {
    const h = harness({ title: id => id === successor ? 'Wizard (continued)' : 'Wizard' })
    const asked = h.grants.request(tab, { command: `bash ${script}`, reason: 'B5 lsphp pool fix' })
    const moved = await h.grants.transfer(tab, successor)
    expect(moved).toEqual({ requests: 1, grants: 0 })
    expect(h.grants.list(tab).requests).toEqual([])
    expect(h.grants.list(successor).requests).toEqual([expect.objectContaining({ id: asked.id, status: 'pending', holder: { agentSessionId: successor, title: 'Wizard (continued)' } })])
    expect(h.grants.state().requests).toEqual([expect.objectContaining({ id: asked.id, agentSessionId: successor })])
    // The predecessor's card stops asking and names where it went; the successor's tab gets the live card.
    expect(h.notices.filter(entry => entry.id === tab).at(-1)).toMatchObject({ itemId: asked.id, payload: { permissionGrant: { status: 'moved', holder: { agentSessionId: successor } } } })
    expect(h.notices.filter(entry => entry.id === successor).at(-1)).toMatchObject({ itemId: asked.id, payload: { permissionGrant: { status: 'pending', holder: { agentSessionId: successor } } } })
    // The owner answers the card in either tab: the old conversation's id still reaches the moved request.
    await expect(h.grants.decide(tab, asked.id, 'approve-once', 'owner')).resolves.toMatchObject({ status: 'approved-once', grant: { agentSessionId: successor } })
    expect(h.told).toEqual([{ id: successor, text: expect.stringMatching(/^\[Conductor\] approved: Bash\(bash app\/prod\/fix-pool\.sh\) \(once\); retry it now/) }])
    expect(h.grants.rules(successor)).toEqual([{ rule: `Bash(bash ${script})`, once: true }])
    expect(h.grants.rules(tab)).toEqual([])
    await expect(h.grants.decide(successor, asked.id, 'approve-once', 'owner')).rejects.toThrow('already answered')
    h.grants.adapterPort(successor).used(`Bash(bash ${script})`)
    expect(h.grants.rules(successor)).toEqual([])
    expect(h.grants.list(successor).requests[0]!.status).toBe('used')
  })

  it('moves an approved grant not yet used: taken out of the predecessor first, handed to the successor, told to it, spent once', async () => {
    const h = harness()
    const asked = h.grants.request(tab, { command: `bash ${script}`, reason: 'fix' })
    await h.grants.decide(tab, asked.id, 'approve-once', 'owner')
    const applied = h.ports.apply as ReturnType<typeof vi.fn>
    applied.mockClear()
    await expect(h.grants.transfer(tab, successor)).resolves.toEqual({ requests: 0, grants: 1 })
    expect(applied.mock.calls.map(call => call[0])).toEqual([tab, successor])
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.grants.rules(successor)).toEqual([{ rule: `Bash(bash ${script})`, once: true }])
    expect(h.grants.list(successor).grants).toEqual([expect.objectContaining({ agentSessionId: successor, requestId: asked.id, delivery: 'live' })])
    expect(h.told.at(-1)).toEqual({ id: successor, text: expect.stringMatching(/^\[Conductor\] approved: Bash\(bash app\/prod\/fix-pool\.sh\) \(once\); retry it now/) })
    // The predecessor's runtime no longer holds the rule and it cannot revoke it; the successor spends it once.
    expect(h.grants.adapterPort(tab).rules()).toEqual([])
    await expect(h.grants.revoke(tab, h.grants.list(successor).grants[0]!.id)).resolves.toBe(false)
    h.grants.adapterPort(successor).used(`Bash(bash ${script})`)
    h.grants.adapterPort(successor).used(`Bash(bash ${script})`)
    expect(h.grants.rules(successor)).toEqual([])
    expect(h.grants.list(successor).requests[0]!.status).toBe('used')
  })

  it('spends a moved grant once even if the predecessor CLI still held the rule and ran it', async () => {
    // Its runtime took the rule at launch through --settings, so taking it back live is unsupported.
    const once = harness({ apply: vi.fn(async (id: string) => id === tab ? 'unsupported' as const : 'applied' as const), idleWaitMs: 1 })
    const request = once.grants.request(tab, { command: `bash ${script}`, reason: 'fix' })
    await once.grants.decide(tab, request.id, 'approve-once', 'owner')
    await once.grants.transfer(tab, successor)
    once.grants.adapterPort(tab).used(`Bash(bash ${script})`)
    expect(once.grants.rules(successor)).toEqual([])
    expect(once.grants.list(successor).requests[0]!.status).toBe('used')
  })

  it('never hands a grant to a conversation that cannot hold one, and a handoff with nothing held is a no-op', async () => {
    const h = harness()
    await expect(h.grants.transfer(tab, successor)).resolves.toEqual({ requests: 0, grants: 0 })
    h.grants.request(tab, { command: `bash ${script}`, reason: 'fix' })
    await expect(h.grants.transfer(tab, 'agent_codex')).resolves.toEqual({ requests: 0, grants: 0 })
    expect(h.grants.list(tab).requests).toHaveLength(1)
    await expect(h.grants.transfer(tab, tab)).resolves.toEqual({ requests: 0, grants: 0 })
  })

  it('moves a classifier denial left unanswered at handoff: the successor holds it, the old card stops asking, the approval tells the successor', async () => {
    const h = harness({ title: id => id === successor ? 'Wizard (continued)' : 'Wizard' })
    const item = h.deny('toolu_ssh', 'Bash', { command: ssh }, 'External System Write', true)
    // A pending request from the moment the card is shown, before anyone answers it.
    expect(h.grants.list(tab).requests).toEqual([expect.objectContaining({ id: item, source: 'denial', status: 'pending', class: 'external' })])
    const rule = h.grants.list(tab).requests[0]!.rule!
    await expect(h.grants.transfer(tab, successor)).resolves.toEqual({ requests: 1, grants: 0 })
    expect(h.grants.list(tab).requests).toEqual([])
    expect(h.grants.list(successor).requests).toEqual([expect.objectContaining({ id: item, status: 'pending', holder: { agentSessionId: successor, title: 'Wizard (continued)' } })])
    // A's denial card is restated as moved, naming the holder; B gets the same card, live, under the same id.
    expect(h.notices.filter(entry => entry.id === tab).at(-1)).toMatchObject({ itemId: item, payload: { grantStatus: 'moved', autoModeDenial: { toolUseId: 'toolu_ssh', request: { holder: { agentSessionId: successor } } } } })
    expect(h.notices.filter(entry => entry.id === successor).at(-1)).toMatchObject({ itemId: item, message: expect.stringContaining('Auto mode refused Bash'), payload: { grantStatus: 'pending', autoModeDenial: { toolUseId: 'toolu_ssh', request: { rule, holder: { agentSessionId: successor } } } } })
    // The turn's result confirms the denial in A after the move: the notice it re-emits is restated as moved.
    h.grants.adapterPort(tab).denied(item, h.grants.list(successor).requests[0]!)
    expect(h.notices.filter(entry => entry.id === tab).at(-1)).toMatchObject({ itemId: item, payload: { grantStatus: 'moved' } })
    // Answered on A's old id, it still reaches B: B is told and holds the rule, A never does.
    await expect(h.grants.decide(tab, item, 'approve-once', 'owner')).resolves.toMatchObject({ status: 'approved-once', grant: { agentSessionId: successor } })
    expect(h.told).toEqual([{ id: successor, text: expect.stringMatching(/^\[Conductor\] approved: Bash\(ssh /) }])
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.grants.rules(successor)).toEqual([{ rule, once: true }])
    await expect(h.grants.decide(successor, item, 'approve-once', 'owner')).rejects.toThrow('already answered')
    h.grants.adapterPort(successor).used(rule)
    expect(h.grants.rules(successor)).toEqual([])
    expect(h.grants.list(successor).requests[0]!.status).toBe('used')
  })

  it('files a denial the superseded tab gets after the handoff as its own, even when its id repeats one its successor holds', async () => {
    const h = harness()
    h.grants.request(tab, { command: `bash ${script}`, reason: 'fix' })
    await h.grants.transfer(tab, successor)
    // A denial id is per CLI process (the fixture's auto-denial:classified-1), so two tabs can share one.
    const described = describeGrantRequest({ tool: 'Bash', input: { command: ssh }, cwd, category: 'External System Write', toolUseId: 'classified-1' })
    h.grants.adapterPort(successor).denied('auto-denial:classified-1', described)
    h.grants.adapterPort(tab).denied('auto-denial:classified-1', described)
    expect(h.grants.list(tab).requests).toEqual([expect.objectContaining({ id: 'auto-denial:classified-1', status: 'pending' })])
    expect(h.grants.list(successor).requests.filter(request => request.id === 'auto-denial:classified-1')).toHaveLength(1)
    expect(h.notices.filter(entry => entry.id === tab && entry.itemId === 'auto-denial:classified-1')).toEqual([])
  })

  it('turns a denial of a call already asked about into another view of that request, in the successor and in the superseded tab', async () => {
    const h = harness()
    const asked = h.grants.request(tab, { command: `bash ${script}`, reason: 'fix' })
    await h.grants.transfer(tab, successor)
    const described = describeGrantRequest({ tool: 'Bash', input: { command: `bash ${script}` }, cwd, category: 'External System Write', toolUseId: 'classified-1' })
    // The successor tries the moved call before the owner answered: no second request, the card shows the moved one.
    h.grants.adapterPort(successor).denied('auto-denial:classified-1', described)
    expect(h.grants.list(successor).requests.map(request => request.id)).toEqual([asked.id])
    expect(h.notices.at(-1)).toMatchObject({ id: successor, itemId: 'auto-denial:classified-1', payload: { permissionGrant: { id: asked.id, status: 'pending' } } })
    // The superseded tab tries it too: its card says where the request went, and it holds nothing.
    h.grants.adapterPort(tab).denied('auto-denial:classified-1', described)
    expect(h.grants.list(tab).requests).toEqual([])
    expect(h.notices.at(-1)).toMatchObject({ id: tab, itemId: 'auto-denial:classified-1', payload: { permissionGrant: { id: asked.id, status: 'moved' } } })
    // Answering the successor's denial card answers the one request, and both of its views show it.
    await expect(h.grants.decide(successor, 'auto-denial:classified-1', 'approve-once', 'owner')).resolves.toMatchObject({ status: 'approved-once', grant: { agentSessionId: successor, requestId: asked.id } })
    expect(h.told).toEqual([{ id: successor, text: expect.stringMatching(/^\[Conductor\] approved: Bash\(bash app\/prod\/fix-pool\.sh\)/) }])
    expect(h.notices.filter(entry => entry.id === successor && entry.itemId === 'auto-denial:classified-1').at(-1)).toMatchObject({ payload: { permissionGrant: { id: asked.id, status: 'approved-once' } } })
    await expect(h.grants.decide(tab, 'auto-denial:classified-1', 'approve-once', 'owner')).rejects.toThrow('already answered')
  })

  it('keeps a moved denial when the predecessor tab closes, and expires a denial card of a tab closed without a successor', () => {
    const open = new Set([tab, successor])
    const h = harness({ tabOpen: id => open.has(id) })
    const item = h.deny('toolu_moved', 'Bash', { command: ssh }, 'External System Write', true)
    void h.grants.transfer(tab, successor)
    open.delete(tab)
    h.grants.sweep(); h.grants.sweep()
    expect(h.grants.state().requests).toEqual([expect.objectContaining({ id: item, agentSessionId: successor, status: 'pending' })])
    const alone = harness({ tabOpen: id => open.has(id) })
    open.add(tab)
    const left = alone.deny('toolu_left', 'Bash', { command: ssh }, 'External System Write', true)
    open.delete(tab)
    alone.grants.sweep(); alone.grants.sweep()
    expect(alone.grants.state().requests).toEqual([])
    expect(alone.notices.at(-1)).toMatchObject({ id: tab, itemId: left, payload: { grantStatus: 'expired' } })
  })

  it('shows an answered denial card again over the bare notice the confirmed denial re-emits', async () => {
    const h = harness()
    const item = h.deny('toolu_w', 'Write', { file_path: 'C:\\Users\\owner\\site\\app\\prod\\fix-pool.sh' }, 'Modify Shared Resources', true)
    await h.grants.decide(tab, item, 'deny', 'owner')
    h.grants.adapterPort(tab).denied(item, h.grants.list(tab).requests[0]!)
    expect(h.notices.at(-1)).toMatchObject({ id: tab, itemId: item, payload: { grantStatus: 'denied' } })
    expect(h.grants.list(tab).requests).toEqual([expect.objectContaining({ id: item, status: 'denied' })])
  })

  it('withdraws the pending card of a tab closed without a successor instead of leaving an orphan', () => {
    let open = true
    const h = harness({ tabOpen: id => id === tab && open })
    const asked = h.grants.request(tab, { command: `bash ${script}`, reason: 'fix' })
    open = false
    h.grants.sweep(); h.grants.sweep()
    expect(h.grants.state().requests).toEqual([])
    expect(h.notices.at(-1)).toMatchObject({ id: tab, itemId: asked.id, payload: { permissionGrant: { status: 'expired' } } })
    const closed = harness()
    const other = closed.grants.request(tab, { command: `bash ${script}`, reason: 'fix' })
    closed.grants.closed(tab)
    expect(closed.notices.at(-1)).toMatchObject({ id: tab, itemId: other.id, payload: { permissionGrant: { status: 'expired' } } })
    expect(closed.grants.state().requests).toEqual([])
  })
})
