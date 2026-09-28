import { describe, expect, it, vi } from 'vitest'
import { autoModeDenialItemId, type AutoModeDenial } from '../../shared/auto-mode-denial'
import { describeGrantRequest } from '../../shared/permission-grants'
import type { Json } from '../../shared/structured-agent'
import { AgentControlServer } from '../agent-control-server'
import { callPermissions } from './control'
import { CONDUCTOR_MCP_TOOLS, ConductorMcpServer } from './control-mcp'
import { PermissionGrants, type PermissionGrantPorts, type SavedPermissionGrants } from './service'

const cwd = 'C:\\Users\\owner\\site\\theme'
const tab = 'agent_tab'
const ssh = 'ssh -o BatchMode=yes -i C:\\keys\\deploy root@192.0.2.10 bash -s < app/prod/fix-pool.sh'

function harness(overrides: Partial<PermissionGrantPorts> = {}) {
  const denials = new Map<string, AutoModeDenial>()
  const notices: Array<{ id: string; message: string; payload: Json; itemId: string }> = []
  const told: Array<{ id: string; text: string }> = []
  // Approval turns still waiting in the conversation's queue (retryQueued).
  const queued = new Set<string>()
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
    retry: vi.fn(async (id: string, text: string) => { told.push({ id, text }) }),
    retryQueued: (_id, text) => queued.has(text),
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
  return { grants, ports, notices, told, queued, deny, setPhase: (value: string) => { phase = value } }
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

  // Live case 2026-09-28 (docs/permissions-classifier.md, Evidence): two session approvals steered
  // into the running turn were refused again and declared ineffective; the once approval that
  // arrived as a turn of its own ran. Both scopes now arrive the same way.
  it.each(['approve-once', 'approve-session'] as const)('%s: the approval reaches a busy conversation as a turn of its own, and a refusal before that turn keeps the grant', async decision => {
    const h = harness()
    const item = h.deny('toolu_r', 'Bash', { command: ssh }, 'Production Reads')
    const result = await h.grants.decide(tab, item, decision, 'owner')
    expect(result.message).toMatch(/in a message of its own once its current turn ends/)
    expect(h.ports.retry).toHaveBeenCalledWith(tab, expect.stringMatching(/^\[Conductor\] approved: Bash\(/))
    expect(h.ports.tell).not.toHaveBeenCalled()
    const rule = result.grant!.rule
    // The agent retries on its own while its approval turn still waits: nothing is judged yet.
    h.queued.add(h.told[0]!.text)
    h.grants.adapterPort(tab).refused(rule)
    const early = h.deny('toolu_r2', 'Bash', { command: ssh }, 'Production Reads', true)
    expect(h.grants.rules(tab)).toEqual([{ rule, once: decision === 'approve-once' }])
    expect(h.notices.some(entry => entry.itemId.startsWith('grant-ineffective:'))).toBe(false)
    expect(h.grants.list(tab).requests.filter(request => request.status === 'pending')).toEqual([])
    expect(h.notices.at(-1)).toMatchObject({ itemId: early, message: expect.stringContaining('already asked about'), payload: { permissionGrant: { id: item, status: decision === 'approve-once' ? 'approved-once' : 'approved-session' } } })
    await expect(h.grants.decide(tab, early, 'approve-session', 'owner')).rejects.toThrow('already answered')
    // Its approval turn ran and the call ran: an approve-once grant is spent.
    h.queued.clear()
    if (decision === 'approve-once') {
      h.grants.adapterPort(tab).used(rule)
      expect(h.grants.list(tab).requests.find(request => request.id === item)!.status).toBe('used')
    } else expect(h.grants.rules(tab)).toHaveLength(1)
  })

  it('declares a grant ineffective only when the call is refused after its approval turn started', async () => {
    const h = harness()
    const { grant } = await h.grants.decide(tab, h.deny('toolu_i', 'Bash', { command: ssh }, 'Production Reads'), 'approve-session', 'owner')
    h.grants.adapterPort(tab).refused(grant!.rule)
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.notices.at(-1)).toMatchObject({ itemId: `grant-ineffective:${grant!.id}`, message: expect.stringMatching(/in a message of its own, but the claude CLI's classifier still refused the call/) })
  })

  it('tells an idle conversation to retry at once, and a restarted one after its restart', async () => {
    const h = harness()
    h.setPhase('idle')
    const idle = await h.grants.decide(tab, h.deny('toolu_idle', 'Write', { file_path: 'notes/idle.md' }, 'Self-Modification'), 'approve-once', 'owner')
    expect(idle.message).toMatch(/The conversation was told to retry it\.$/)
    const restarting = harness({ apply: vi.fn(async () => 'unsupported' as const) })
    restarting.setPhase('idle')
    await restarting.grants.decide(tab, restarting.deny('toolu_rs', 'Write', { file_path: 'notes/restart.md' }, 'Self-Modification'), 'approve-once', 'owner')
    await vi.waitFor(() => expect(restarting.ports.retry).toHaveBeenCalledTimes(1))
    expect(restarting.ports.restart).toHaveBeenCalledWith(tab)
    expect(restarting.ports.tell).not.toHaveBeenCalled()
  })

  it('keeps a denied request blocked and tells the conversation not to route around it', async () => {
    const h = harness()
    const item = h.deny('toolu_s', 'Bash', { command: ssh }, 'Modify Shared Resources')
    await expect(h.grants.decide(tab, item, 'deny', 'owner')).resolves.toMatchObject({ status: 'denied' })
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.ports.apply).not.toHaveBeenCalled()
    expect(h.told[0]!.text).toMatch(/owner denied: Run a command ssh .*Do not retry it or route around it/)
  })

  // H13 (owner decision 2026-09-28): the wand holds the owner's authority, so a wizard answers
  // every class, production and destructive included.
  it('lets a wizard answer every class of request: external, destructive and local', async () => {
    const h = harness()
    const external = h.deny('toolu_x', 'Bash', { command: ssh }, 'Modify Shared Resources')
    await expect(h.grants.decide(tab, external, 'approve-once', 'wizard')).resolves.toMatchObject({ status: 'approved-once', grant: { decidedBy: 'wizard', class: 'external' } })
    const destructive = h.deny('toolu_d', 'Bash', { command: 'rm -rf build' }, 'Irreversible Local Destruction')
    await expect(h.grants.decide(tab, destructive, 'approve-session', 'wizard')).resolves.toMatchObject({ status: 'approved-session', grant: { decidedBy: 'wizard', class: 'destructive' } })
    const local = h.deny('toolu_l', 'Write', { file_path: 'notes/plan.md' }, 'Self-Modification')
    await expect(h.grants.decide(tab, local, 'approve-session', 'wizard')).resolves.toMatchObject({ status: 'approved-session', grant: { decidedBy: 'wizard', scope: 'session' } })
    expect(h.grants.rules(tab)).toContainEqual({ rule: 'Edit(//c/Users/owner/site/theme/notes/plan.md)', once: false })
    expect(h.grants.rules(tab)).toHaveLength(3)
    const denied = h.deny('toolu_y', 'Bash', { command: 'npm run deploy:prod' }, 'Production Deploy')
    await expect(h.grants.decide(tab, denied, 'deny', 'wizard')).resolves.toMatchObject({ status: 'denied' })
    // The tab hears who decided: a wizard answering for the owner, not the owner.
    expect(h.told.at(-1)!.text).toMatch(/^\[Conductor\] a wizard tab, answering for the owner, denied: Run a command npm run deploy:prod\. Do not retry it/)
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
  it('lets a conversation ask and list for itself, and only the owner credential or a wizard answer, any class', async () => {
    const h = harness()
    const asked = await callPermissions(h.grants, { agentSessionId: tab }, 'permissions.request', { command: ssh, reason: 'pool fix' }) as { requestId: string; rule: string; class: string }
    expect(asked).toMatchObject({ class: 'external', rule: expect.stringMatching(/^Bash\(ssh /) })
    await expect(callPermissions(h.grants, { agentSessionId: tab }, 'permissions.request', { command: ssh, reason: 'x', allowAll: true })).rejects.toThrow('does not take allowAll')
    await expect(callPermissions(h.grants, { agentSessionId: tab }, 'permissions.list', { agentSessionId: 'agent_other' })).rejects.toThrow('Only the owner or a wizard')
    await expect(callPermissions(h.grants, { agentSessionId: tab }, 'permissions.decide', { agentSessionId: tab, requestId: asked.requestId, decision: 'approve-once' })).rejects.toThrow('answers only')
    // A wizard cannot answer its own request; another wizard tab answers even an external one (H13).
    await expect(callPermissions(h.grants, { agentSessionId: tab, wizard: true }, 'permissions.decide', { agentSessionId: tab, requestId: asked.requestId, decision: 'approve-once' })).rejects.toThrow('cannot answer its own')
    await expect(callPermissions(h.grants, { agentSessionId: 'agent_wizard', wizard: true }, 'permissions.decide', { agentSessionId: tab, requestId: asked.requestId, decision: 'approve-once' })).resolves.toMatchObject({ status: 'approved-once' })
    const local = await callPermissions(h.grants, { agentSessionId: tab }, 'permissions.request', { command: 'npm run build', reason: 'build' }) as { requestId: string }
    await expect(callPermissions(h.grants, { agentSessionId: '', owner: true }, 'permissions.decide', { agentSessionId: tab, requestId: local.requestId, decision: 'approve-once' })).resolves.toMatchObject({ status: 'approved-once' })
    expect((await callPermissions(h.grants, { agentSessionId: tab }, 'permissions.list', {}) as { grants: unknown[] }).grants).toHaveLength(2)
  })
})

describe('the conductor MCP server', () => {
  it('runs each messaging tool as the calling conversation through app control, with no credential in the call', async () => {
    const calls: Array<{ scope: unknown; method: string; args: unknown }> = []
    const server = new ConductorMcpServer(async (scope, method, args) => { calls.push({ scope, method, args }); return { delivered: true } }, false)
    await server.start()
    try {
      const file = server.configure({ id: tab, projectId: 'project', sessionId: 'workspace', provider: 'claude' })
      expect(server.configure({ id: 'agent_local', projectId: 'project', sessionId: 'workspace', provider: 'local' })).toBe('')
      const { readFileSync } = await import('node:fs')
      const config = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: { conductor: { url: string; headers: { Authorization: string } } } }
      const post = (body: unknown, authorization = config.mcpServers.conductor.headers.Authorization) => fetch(config.mcpServers.conductor.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(body) })
      const listed = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as { result: { tools: Array<{ name: string }> } }
      expect(listed.result.tools.map(tool => tool.name)).toEqual(CONDUCTOR_MCP_TOOLS.map(tool => tool.name))
      const sent = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { agentSessionId: 'agent_other', text: 'The permission path is fixed; resume the pool fix.' } } })).json() as { result: { structuredContent: unknown } }
      expect(sent.result.structuredContent).toEqual({ delivered: true })
      // Addressed to another project rather than a conversation: its wizard receives it (agent-control handIn).
      await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'send_message', arguments: { projectId: 'project_theme', text: 'Your wizard should fix the export.' } } })
      await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_permission', arguments: { command: ssh, reason: 'pool fix', rollback: 'restore backups' } } })
      expect(calls).toEqual([
        { scope: { projectId: 'project', sessionId: 'workspace', agentSessionId: tab }, method: 'agents.steer', args: { agentSessionId: 'agent_other', prompt: 'The permission path is fixed; resume the pool fix.' } },
        { scope: { projectId: 'project', sessionId: 'workspace', agentSessionId: tab }, method: 'agents.steer', args: { projectId: 'project_theme', prompt: 'Your wizard should fix the export.' } },
        { scope: { projectId: 'project', sessionId: 'workspace', agentSessionId: tab }, method: 'permissions.request', args: { command: ssh, reason: 'pool fix', rollback: 'restore backups' } }
      ])
      expect((await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'Bearer ' + '0'.repeat(64))).status).toBe(401)
      server.release(tab)
      expect((await post({ jsonrpc: '2.0', id: 5, method: 'tools/list' })).status).toBe(401)
    } finally { server.close() }
  })

  it('calls any app-control method through the HTTP endpoint\'s pipeline, refusing with the text HTTP answers', async () => {
    const listing = { 'tools.list': '({brief?,prefix?})', 'agents.status': '({agentSessionId})' }
    const control = {
      authorize: vi.fn(() => ({ id: tab, projectId: 'project', sessionId: 'workspace', provider: 'claude', title: 'Worker', cwd })),
      ownerScope: vi.fn(),
      prepareActivity: vi.fn(() => undefined),
      recordActivity: vi.fn(),
      // Owner-only as AgentControl.call decides it: from the scope, never from the arguments.
      call: vi.fn(async (scope: { agentSessionId: string; owner?: boolean; wizard?: boolean }, method: string, args: Record<string, unknown>) => {
        if (method === 'tools.list') return args.brief ? listing : { ...listing, full: true }
        if (method === 'app.restart' && !scope.owner && !scope.wizard) throw new Error('app.restart is for the owner credential or a wizard tab; ask the owner with app.restart.request({reason}).')
        if (method === 'tabs.close') throw new Error('Tab is closed')
        return { method, args }
      })
    }
    const http = new AgentControlServer(control as never, false)
    await http.start()
    const mcp = new ConductorMcpServer((scope, method, args, options) => options?.generic ? http.invoke(scope, method, args) : control.call(scope, method, args), false)
    await mcp.start()
    try {
      const spec = { id: tab, projectId: 'project', sessionId: 'workspace', provider: 'claude' as const, title: 'Worker', cwd }
      const { readFileSync } = await import('node:fs')
      const config = JSON.parse(readFileSync(mcp.configure(spec), 'utf8')) as { mcpServers: { conductor: { url: string; headers: { Authorization: string } } } }
      type ToolResult = { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown } }
      const tool = async (args: Record<string, unknown>): Promise<ToolResult['result']> => (await (await fetch(config.mcpServers.conductor.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: config.mcpServers.conductor.headers.Authorization }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'control', arguments: args } }) })).json() as ToolResult).result
      const briefing = http.briefing(spec as never)
      expect(briefing).toContain('control({method,args})')
      const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)![1]!, token = briefing.match(/Bearer ([a-f0-9]{64})/)![1]!
      const overHttp = async (method: string, args: Record<string, unknown> = {}) => await (await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, args }) })).json() as { result?: unknown; error?: string }

      const listed = await tool({ method: 'tools.list', args: { brief: true } })
      expect(listed.isError).toBeUndefined()
      expect(JSON.parse(listed.content[0]!.text)).toEqual(listing)
      // One copy of a large result, not a second one as structuredContent.
      expect(listed.structuredContent).toBeUndefined()
      // args sent as a JSON string, as models often do, is the same call.
      expect(JSON.parse((await tool({ method: 'tools.list', args: '{"brief":true}' })).content[0]!.text)).toEqual(listing)
      expect(control.call).toHaveBeenCalledWith({ projectId: 'project', sessionId: 'workspace', agentSessionId: tab }, 'tools.list', { brief: true })

      // A refused mutation and an owner-only method: the same text the HTTP endpoint answers in its 400 body.
      for (const [method, args] of [['tabs.close', { tabId: 'tab_1' }], ['app.restart', {}]] as const) {
        const refused = await tool({ method, args })
        expect(refused.isError).toBe(true)
        expect(refused.content[0]!.text).toBe((await overHttp(method, args)).error)
      }
      expect((await tool({ method: 'app.restart' })).content[0]!.text).toContain('owner credential or a wizard tab')
      // Recorded in the timelines exactly as an HTTP call is (control-activity.ts).
      expect(control.recordActivity).toHaveBeenCalledWith({ projectId: 'project', sessionId: 'workspace', agentSessionId: tab }, 'tabs.close', { tabId: 'tab_1' }, expect.objectContaining({ error: 'Tab is closed' }))
      expect(control.authorize).toHaveBeenCalled()

      const noMethod = await tool({ args: {} })
      expect(noMethod).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('control needs method') }] })
      const badArgs = await tool({ method: 'agents.status', args: '[1' })
      expect(badArgs).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('tools.list({prefix:"agents."})') }] })
    } finally { mcp.close(); http.close() }
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

describe('a pending owner approval survives a restart (grant-survives-restart)', () => {
  const successor = 'agent_other'
  const script = 'app/prod/fix-pool.sh'
  const rule = `Bash(bash ${script})`
  /** A run whose every save is kept, as permission-grants.json keeps the last one. */
  function saving(overrides: Partial<PermissionGrantPorts> = {}) {
    let saved: SavedPermissionGrants | undefined
    const h = harness({ persist: value => { saved = JSON.parse(JSON.stringify(value)) as SavedPermissionGrants }, ...overrides })
    return { ...h, saved: () => saved }
  }
  const exists = (id: string): boolean => id === tab || id === successor

  it('keeps a waiting request across a restart: the card, the list and one approval that tells the holder, spent once', async () => {
    const before = saving()
    const asked = before.grants.request(tab, { command: `bash ${script}`, reason: 'B5 lsphp pool fix', rollback: 'restore the pool file' })
    expect(before.saved()!.requests).toEqual([expect.objectContaining({ id: asked.id, agentSessionId: tab, status: 'pending', reason: 'B5 lsphp pool fix' })])
    const after = saving()
    expect(after.grants.restore(before.saved(), exists)).toEqual({ requests: 1, grants: 0, dropped: 0 })
    expect(after.grants.list(tab).requests).toEqual([expect.objectContaining({ id: asked.id, status: 'pending', rule })])
    expect(after.ports.changed).toHaveBeenCalledWith({ requests: [expect.objectContaining({ id: asked.id, agentSessionId: tab, status: 'pending' })], grants: [] })
    // The same identical ask after the restart is the restored request, not a second card.
    expect(after.grants.request(tab, { command: `bash ${script}`, reason: 'again' }).id).toBe(asked.id)
    await expect(after.grants.decide(tab, asked.id, 'approve-once', 'owner')).resolves.toMatchObject({ status: 'approved-once' })
    expect(after.told).toEqual([{ id: tab, text: expect.stringMatching(/^\[Conductor\] approved: Bash\(bash app\/prod\/fix-pool\.sh\) \(once\); retry it now/) }])
    await expect(after.grants.decide(tab, asked.id, 'approve-once', 'owner')).rejects.toThrow('already answered')
    after.grants.adapterPort(tab).used(rule)
    expect(after.grants.rules(tab)).toEqual([])
    // Spent: nothing of it comes back after another restart, and it cannot be approved again.
    const again = saving()
    expect(again.grants.restore(after.saved(), exists)).toEqual({ requests: 0, grants: 0, dropped: 0 })
    expect(again.grants.state()).toEqual({ requests: [], grants: [], settled: [{ agentSessionId: tab, id: asked.id, status: 'used' }] })
    await expect(again.grants.decide(tab, asked.id, 'approve-once', 'owner')).rejects.toThrow('already answered (used)')
  })

  it('keeps an approved grant not yet used across a restart: its rule reaches the next start, and it is consumed once', async () => {
    const before = saving()
    const asked = before.grants.request(tab, { command: `bash ${script}`, reason: 'fix' })
    await before.grants.decide(tab, asked.id, 'approve-once', 'owner')
    const after = saving()
    expect(after.grants.restore(before.saved(), exists)).toEqual({ requests: 1, grants: 1, dropped: 0 })
    expect(after.grants.rules(tab)).toEqual([{ rule, once: true }])
    expect(after.grants.list(tab).grants).toEqual([expect.objectContaining({ requestId: asked.id, delivery: 'pending' })])
    expect(after.grants.list(tab).requests).toEqual([expect.objectContaining({ id: asked.id, status: 'approved-once' })])
    after.grants.adapterPort(tab).used(rule)
    after.grants.adapterPort(tab).used(rule)
    expect(after.grants.rules(tab)).toEqual([])
    expect(after.grants.list(tab).requests[0]!.status).toBe('used')
    const again = saving()
    again.grants.restore(after.saved(), exists)
    expect(again.grants.rules(tab)).toEqual([])
  })

  it('drops what a conversation that no longer exists held, and anything saved as answered or spent', () => {
    const before = saving({ provider: () => 'claude' })
    const gone = before.grants.request('agent_gone', { command: 'npm test', reason: 'r' })
    const kept = before.grants.request(tab, { command: `bash ${script}`, reason: 'r' })
    const saved = before.saved()!
    saved.requests.push({ ...saved.requests.find(entry => entry.id === kept.id)!, id: 'grant:answered', status: 'denied' })
    saved.requests.push({ ...saved.requests.find(entry => entry.id === kept.id)!, id: 'grant:orphan-approval', status: 'approved-once' })
    const after = saving()
    expect(after.grants.restore(saved, exists)).toEqual({ requests: 1, grants: 0, dropped: 2 })
    expect(after.grants.state().requests.map(entry => entry.id)).toEqual([kept.id])
    expect(after.saved()!.requests.map(entry => entry.id)).toEqual([kept.id])
    expect(gone.id).not.toBe(kept.id)
    expect(after.grants.restore('not json', exists)).toEqual({ requests: 0, grants: 0, dropped: 0 })
  })

  it('ends nothing when the app quits or an idle runtime is given back while its tab stays open', () => {
    const open = new Set([tab])
    const h = saving({ tabOpen: id => open.has(id) })
    const asked = h.grants.request(tab, { command: `bash ${script}`, reason: 'r' })
    h.grants.closed(tab)
    expect(h.grants.list(tab).requests).toEqual([expect.objectContaining({ id: asked.id, status: 'pending' })])
    h.grants.freeze()
    open.clear()
    h.grants.closed(tab)
    h.grants.sweep(); h.grants.sweep()
    expect(h.saved()!.requests).toEqual([expect.objectContaining({ id: asked.id, status: 'pending' })])
    expect(h.notices.filter(entry => entry.payload && JSON.stringify(entry.payload).includes('"expired"'))).toEqual([])
  })

  it('keeps a handoff across a restart: the old id reaches the moved request, a spend the old runtime reports spends it, and its re-shown denial stays moved', async () => {
    const before = saving()
    const item = before.deny('toolu_moved', 'Bash', { command: ssh }, 'External System Write', true)
    const asked = before.grants.request(tab, { command: `bash ${script}`, reason: 'fix' })
    await before.grants.decide(tab, asked.id, 'approve-once', 'owner')
    await before.grants.transfer(tab, successor)
    const after = saving({ apply: vi.fn(async () => 'offline' as const) })
    expect(after.grants.restore(before.saved(), exists)).toEqual({ requests: 2, grants: 1, dropped: 0 })
    expect(after.grants.list(successor).requests.map(entry => entry.id).sort()).toEqual([asked.id, item].sort())
    expect(after.grants.rules(tab)).toEqual([])
    // The superseded tab's runtime shows the denial again: it stays moved, not a new request there.
    after.grants.adapterPort(tab).denied(item, describeGrantRequest({ tool: 'Bash', input: { command: ssh }, cwd }))
    expect(after.grants.list(tab).requests).toEqual([])
    await expect(after.grants.decide(tab, item, 'approve-once', 'owner')).resolves.toMatchObject({ status: 'approved-once', grant: { agentSessionId: successor } })
    expect(after.told.at(-1)).toMatchObject({ id: successor })
    // The old runtime took the moved rule at launch and ran it: the successor's grant is spent.
    after.grants.adapterPort(tab).used(rule)
    expect(after.grants.rules(successor).map(entry => entry.rule)).not.toContain(rule)
  })

  it('shows a denial answered before the restart as answered when the reattached runtime shows it again, and never asks it twice', async () => {
    const before = saving()
    const item = before.deny('toolu_w', 'Write', { file_path: 'C:\\Users\\owner\\site\\app\\prod\\fix-pool.sh' }, 'Modify Shared Resources', true)
    await before.grants.decide(tab, item, 'deny', 'owner')
    expect(before.saved()!.settled).toEqual([[tab, item, 'denied']])
    const after = saving({ denial: before.ports.denial })
    after.grants.restore(before.saved(), exists)
    after.grants.adapterPort(tab).denied(item, describeGrantRequest({ tool: 'Write', input: { file_path: 'C:\\Users\\owner\\site\\app\\prod\\fix-pool.sh' }, cwd }))
    expect(after.grants.list(tab).requests).toEqual([])
    expect(after.notices.at(-1)).toMatchObject({ id: tab, itemId: item, payload: { grantStatus: 'denied' } })
    await expect(after.grants.decide(tab, item, 'approve-once', 'owner')).rejects.toThrow('already answered (denied)')
  })
})

describe('classifier outages are not permission questions', () => {
  const outageRequest = (toolUseId: string) => ({ ...describeGrantRequest({ tool: 'Bash', input: { command: 'npm test' }, cwd, category: 'Classifier unavailable', toolUseId }), id: autoModeDenialItemId(toolUseId), source: 'denial' as const, status: 'pending' as const, requestedAt: '2026-09-28T09:03:00.000Z' })

  it('raises no card for an outage denial and never answers one as an approval', async () => {
    const h = harness()
    const item = h.deny('toolu_o', 'Bash', { command: 'npm test' }, 'Classifier unavailable', true)
    expect(h.grants.list(tab).requests).toEqual([])
    expect(h.ports.changed).not.toHaveBeenCalled()
    await expect(h.grants.decide(tab, item, 'approve-once', 'owner')).rejects.toThrow('already answered (expired)')
    expect(h.grants.rules(tab)).toEqual([])
    // A real refusal next to it is still the owner's card.
    const real = h.deny('toolu_r', 'Bash', { command: 'npm test' }, 'Interfere With Workloads', true)
    expect(h.grants.list(tab).requests).toEqual([expect.objectContaining({ id: real, status: 'pending', category: 'Interfere With Workloads' })])
  })

  it('withdraws a stale outage card once its turn settles, as a plain notice, and leaves real refusals pending', async () => {
    const h = harness()
    // A card an older build raised in this run, held the way its denied() held it.
    const open = new Map([[autoModeDenialItemId('toolu_live'), outageRequest('toolu_live')]])
    ;(h.grants as unknown as { requests: Map<string, Map<string, unknown>> }).requests.set(tab, open)
    const real = h.deny('toolu_real', 'Bash', { command: 'npm test' }, 'Interfere With Workloads', true)
    h.grants.sweep()
    expect(h.grants.list(tab).requests.find(request => request.id === autoModeDenialItemId('toolu_live'))?.status).toBe('pending')
    h.setPhase('completed')
    h.grants.sweep()
    const requests = h.grants.list(tab).requests
    expect(requests.find(request => request.id === autoModeDenialItemId('toolu_live'))?.status).toBe('expired')
    expect(requests.find(request => request.id === real)?.status).toBe('pending')
    const notice = h.notices.at(-1)!
    expect(notice).toMatchObject({ id: tab, itemId: autoModeDenialItemId('toolu_live'), payload: { classifierUnavailable: { tool: 'Bash', toolUseId: 'toolu_live' }, grantStatus: 'expired' } })
    expect(notice.payload).not.toHaveProperty('autoModeDenial')
    expect(h.grants.snapshot().settled).toContainEqual([tab, autoModeDenialItemId('toolu_live'), 'expired'])
    await expect(h.grants.decide(tab, autoModeDenialItemId('toolu_live'), 'approve-once', 'owner')).rejects.toThrow('already answered (expired)')
  })

  it('withdraws a pending outage card saved in permission-grants.json when it is loaded', async () => {
    const h = harness()
    const exists = (id: string) => id === tab
    const real = { ...describeGrantRequest({ tool: 'Bash', input: { command: 'npm test' }, cwd, category: 'Interfere With Workloads', toolUseId: 'toolu_real' }), id: autoModeDenialItemId('toolu_real'), source: 'denial' as const, status: 'pending' as const, requestedAt: '2026-09-28T09:03:00.000Z' }
    const saved: SavedPermissionGrants = { version: 1, requests: [{ ...outageRequest('toolu_old'), agentSessionId: tab }, { ...real, agentSessionId: tab }], grants: [], successors: [], movedFrom: [], movedOut: [], aliases: [], settled: [] }
    expect(h.grants.restore(saved, exists)).toEqual({ requests: 1, grants: 0, dropped: 1 })
    expect(h.grants.list(tab).requests).toEqual([expect.objectContaining({ id: real.id, status: 'pending' })])
    expect(h.grants.state().settled).toContainEqual({ agentSessionId: tab, id: autoModeDenialItemId('toolu_old'), status: 'expired' })
    await expect(h.grants.decide(tab, autoModeDenialItemId('toolu_old'), 'approve-once', 'owner')).rejects.toThrow('already answered (expired)')
  })
})

// H06 (docs/verification/2026-09-28-harness-gap-sweep.md): the approval turn waits behind a running
// turn; the agent hears it is coming, the approver hears after 2 min (a wizard's approval
// interrupts), and a retry older than 30 min is withdrawn rather than delivered.
describe('an approval reaches a conversation whose turn is still running (H06)', () => {
  const successor = 'agent_other'
  function timed(overrides: Partial<PermissionGrantPorts> = {}) {
    let clock = Date.parse('2026-09-28T15:00:00.000Z')
    let phase = 'running'
    // The conversation's queue: an approval turn handed over while a turn is under way waits here.
    const waiting = new Set<string>()
    const retried: Array<{ id: string; text: string }> = []
    const h = harness({
      now: () => new Date(clock).toISOString(),
      phase: () => phase,
      retry: vi.fn(async (id: string, text: string) => { retried.push({ id, text }); if (['running', 'starting', 'waiting_input', 'waiting_approval'].includes(phase)) waiting.add(text) }),
      retryQueued: (_id, text) => waiting.has(text),
      headsUp: vi.fn(async () => true),
      interrupt: vi.fn(async () => undefined),
      turn: () => ({ startedAt: '2026-09-28T14:50:00.000Z', lastTool: 'Bash' }),
      unqueue: vi.fn((_id: string, text: string) => waiting.delete(text)),
      title: id => id === successor ? 'Wizard (continued)' : 'Wizard',
      ...overrides
    })
    return { ...h, retried, waiting, advance: (ms: number) => { clock += ms }, setPhase: (value: string) => { phase = value } }
  }
  const settle = () => new Promise(done => setTimeout(done, 0))
  const waitingNotices = (h: ReturnType<typeof timed>) => h.notices.filter(entry => entry.itemId.startsWith('grant-waiting:'))

  it('says which conversation made the call and when it was approved', async () => {
    const h = timed()
    await h.grants.decide(tab, h.deny('toolu_p', 'Bash', { command: ssh }, 'Production Reads'), 'approve-once', 'owner')
    expect(h.retried).toEqual([{ id: tab, text: expect.stringMatching(/^\[Conductor\] approved: Bash\(.*\(once\); retry it now\..*\(Asked in this conversation at 2026-09-28 15:00 UTC; approved by the owner at 2026-09-28 15:00 UTC\.\)$/) }])
  })

  it('steers one heads-up into the running turn once it can take one, never the approval itself', async () => {
    const headsUp = vi.fn(async (_id: string, _text: string) => true).mockResolvedValueOnce(false)
    const h = timed({ headsUp })
    await h.grants.decide(tab, h.deny('toolu_h', 'Bash', { command: ssh }, 'Production Reads'), 'approve-session', 'owner')
    await settle()
    // Not steerable at the moment of the decision: tried again on the next sweep, then never again.
    expect(headsUp).toHaveBeenCalledTimes(1)
    h.grants.sweep(); await settle()
    h.grants.sweep(); await settle()
    h.grants.sweep(); await settle()
    expect(headsUp).toHaveBeenCalledTimes(2)
    expect(headsUp.mock.calls[1]![1]).toMatch(/^\[Conductor\] approval queued: Bash\(ssh .*Until that message arrives, do not retry the call/)
    expect(h.retried).toHaveLength(1)
  })

  it('tells the owner once, after 2 min, how to interrupt the turn; it does not interrupt on its own', async () => {
    const h = timed()
    const result = await h.grants.decide(tab, h.deny('toolu_o', 'Bash', { command: ssh }, 'Production Reads'), 'approve-once', 'owner')
    expect(result.message).toMatch(/once its current turn ends\. If that turn is still running 2 min from now, the tab says so/)
    h.advance(119_000); h.grants.sweep()
    expect(waitingNotices(h)).toEqual([])
    h.advance(2000); h.grants.sweep(); h.advance(60_000); h.grants.sweep()
    expect(waitingNotices(h)).toEqual([expect.objectContaining({ id: tab, message: expect.stringMatching(/queued behind a turn that has run 12 min \(last tool: Bash\)\. Use "Interrupt and retry" on its approval card, or press Esc in this tab/) })])
    expect(h.ports.interrupt).not.toHaveBeenCalled()
  })

  it('offers the owner "Interrupt and retry" after the notice, and interrupts with the queue expedited', async () => {
    const h = timed()
    const { grant } = await h.grants.decide(tab, h.deny('toolu_i', 'Bash', { command: ssh }, 'Production Reads'), 'approve-once', 'owner')
    expect(h.grants.state().waiting).toBeUndefined()
    h.advance(121_000); h.grants.sweep()
    expect(h.grants.state().waiting).toEqual([{ agentSessionId: tab, grantIds: [grant!.id], rules: [grant!.rule], since: '2026-09-28T15:00:00.000Z' }])
    await h.grants.interruptForRetry(tab, grant!.id)
    expect(h.ports.interrupt).toHaveBeenCalledWith(tab)
    expect(h.grants.state().waiting).toBeUndefined()
    expect(waitingNotices(h).at(-1)).toMatchObject({ message: expect.stringMatching(/you interrupted that turn, so the retry runs now/) })
    // The retry started: a second click says so instead of interrupting the next turn.
    h.waiting.clear()
    await expect(h.grants.interruptForRetry(tab, grant!.id)).rejects.toThrow(/no longer waiting/)
    expect(h.ports.interrupt).toHaveBeenCalledTimes(1)
  })

  it('offers the card action again when the interrupt fails, and withdraws the offer when the retry runs', async () => {
    const interrupt = vi.fn(async () => { throw new Error('runtime offline') })
    const h = timed({ interrupt })
    const { grant } = await h.grants.decide(tab, h.deny('toolu_f', 'Bash', { command: ssh }, 'Production Reads'), 'approve-once', 'wizard')
    h.advance(121_000); h.grants.sweep(); await settle()
    expect(waitingNotices(h).at(-1)).toMatchObject({ message: expect.stringMatching(/could not interrupt it \(runtime offline\)\. Use "Interrupt and retry"/) })
    expect(h.grants.state().waiting).toHaveLength(1)
    await expect(h.grants.interruptForRetry(tab, grant!.id)).rejects.toThrow('runtime offline')
    expect(h.grants.state().waiting).toHaveLength(1)
    h.waiting.clear(); h.grants.sweep()
    expect(h.grants.state().waiting).toBeUndefined()
  })

  it('interrupts the turn once when a wizard approved and the retry has waited 2 min', async () => {
    const h = timed()
    const result = await h.grants.decide(tab, h.deny('toolu_z', 'Bash', { command: ssh }, 'Production Reads'), 'approve-once', 'wizard')
    expect(result.message).toMatch(/Conductor interrupts it so the retry runs/)
    h.advance(121_000); h.grants.sweep(); h.grants.sweep()
    expect(h.ports.interrupt).toHaveBeenCalledTimes(1)
    expect(h.ports.interrupt).toHaveBeenCalledWith(tab)
    expect(waitingNotices(h)).toEqual([expect.objectContaining({ message: expect.stringMatching(/A wizard tab approved it, so Conductor interrupted that turn/) })])
    // The retry ran after the interrupt: nothing more to follow.
    h.waiting.clear(); h.grants.sweep(); h.advance(40 * 60_000); h.grants.sweep()
    expect(h.ports.interrupt).toHaveBeenCalledTimes(1)
    expect(h.ports.unqueue).not.toHaveBeenCalled()
  })

  it('never throws after the grant is applied: a conversation still stopping gets the retry once it has stopped', async () => {
    const h = timed()
    const retry = vi.fn(async (id: string, text: string) => {
      if (h.ports.phase(id) === 'interrupting') throw new Error('The conversation is still stopping its last turn')
      h.retried.push({ id, text })
    })
    h.ports.retry = retry
    h.setPhase('interrupting')
    const result = await h.grants.decide(tab, h.deny('toolu_s', 'Bash', { command: ssh }, 'Production Reads'), 'approve-once', 'owner')
    expect(result).toMatchObject({ status: 'approved-once', message: expect.stringMatching(/still stopping its last turn; Conductor hands it the retry as soon as it has stopped/) })
    expect(h.grants.rules(tab)).toHaveLength(1)
    h.advance(5000); h.grants.sweep(); await settle()
    expect(retry).toHaveBeenCalledTimes(1)
    h.setPhase('completed')
    h.advance(1000); h.grants.sweep(); await settle()
    h.advance(5000); h.grants.sweep(); await settle()
    h.advance(5000); h.grants.sweep(); await settle()
    expect(retry).toHaveBeenCalledTimes(2)
    expect(h.retried).toEqual([{ id: tab, text: expect.stringMatching(/^\[Conductor\] approved: Bash\(/) }])
  })

  it('withdraws an approval turn that waited 30 min instead of delivering it as "retry it now"', async () => {
    const h = timed()
    const { grant } = await h.grants.decide(tab, h.deny('toolu_w', 'Bash', { command: ssh }, 'Production Reads'), 'approve-session', 'owner')
    h.advance(30 * 60_000 + 1000); h.grants.sweep()
    expect(h.ports.unqueue).toHaveBeenCalledWith(tab, h.retried[0]!.text)
    expect(h.waiting.size).toBe(0)
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.grants.list(tab).requests.find(request => request.id === grant!.requestId)).toMatchObject({ status: 'expired' })
    expect(waitingNotices(h).at(-1)).toMatchObject({ message: expect.stringMatching(/^Withdrawn: the approval of Bash\(.* waited 30 min .*not delivered as "retry it now"/) })
  })

  it('hands a successor only recent approvals: an older unspent grant ends with a notice and is never announced to it', async () => {
    const h = timed()
    const old = await h.grants.decide(tab, h.deny('toolu_old', 'Bash', { command: 'npm run deploy:staging' }, 'Production Deploy'), 'approve-session', 'owner')
    h.advance(20 * 60_000)
    const recent = await h.grants.decide(tab, h.deny('toolu_new', 'Bash', { command: ssh }, 'Production Reads'), 'approve-once', 'wizard')
    h.advance(60_000)
    expect(await h.grants.transfer(tab, successor)).toEqual({ requests: 0, grants: 1 })
    expect(h.grants.rules(successor)).toEqual([{ rule: recent.grant!.rule, once: true }])
    expect(h.grants.rules(tab)).toEqual([])
    expect(h.grants.list(tab).requests.find(request => request.id === old.grant!.requestId)).toMatchObject({ status: 'expired' })
    expect(h.notices).toContainEqual(expect.objectContaining({ id: tab, itemId: `grant-stale:${old.grant!.id}`, message: expect.stringMatching(/^Not handed on to Wizard \(continued\) · other: Bash\(npm run deploy:staging\) was approved 21 min ago/) }))
    const told = h.retried.filter(entry => entry.id === successor)
    expect(told).toEqual([{ id: successor, text: expect.stringMatching(/\(Asked in Wizard · tab \(which handed itself on to this one\) at 2026-09-28 15:20 UTC; approved by a wizard tab at 2026-09-28 15:20 UTC\.\)$/) }])
    expect(told[0]!.text).not.toContain('deploy:staging')
  })
})
