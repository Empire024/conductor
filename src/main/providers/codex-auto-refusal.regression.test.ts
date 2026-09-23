import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AdapterEvent, Json, SessionSettings } from '../../shared/structured-agent'
import { StructuredActivity } from '../../renderer/src/panes/StructuredAgentRenderers'
import type { AdapterOptions } from './adapter'
import type { TransportOptions } from './transport'
import { CodexAdapter, CODEX_PROTOCOL_BASELINE, ownerOnlyEscalation } from './codex'
import { ApprovalReviews, type ReviewAction } from '../approval-review'

// Bounded adapter ownership: agent_mucykb2d_xjxx7ve. See docs/approval-auto-refusal-repro.md.
// No process, shell command, network, model, credential or application window is used.
// The original six expected failures were promoted to ordinary assertions after the
// existing lead released the adapter slice. The original failing JSON remains evidence.
// Since then Auto answers a native escalation itself unless it reaches an owner-only boundary;
// the retained-card lifecycle is exercised under Edit and under the Auto cases that stay cards.
const cleanup: CodexAdapter[] = []
afterEach(() => cleanup.splice(0).forEach(adapter => adapter.dispose()))
const threadId = 'auto-refusal-thread', turnId = 'auto-refusal-turn', nativeRequestId = 900
const requestId = 'number:900'
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json

function fixture(permission: SessionSettings['permission'] = 'auto', extra: Partial<AdapterOptions> = {}) {
  const settings: SessionSettings = { permission, plan: false }
  const events: AdapterEvent[] = [], sent: Json[] = []
  let wire!: TransportOptions, connected = false, uncertainSend = false
  const inject = (message: unknown) => wire.onMessage(asJson(message))
  const adapter = new CodexAdapter({ executable: 'never-launched', cwd: process.cwd(), runtimeId: 'auto-runtime', settings, ...extra, emit: event => events.push(event) }, {
    version: async () => `codex-cli ${CODEX_PROTOCOL_BASELINE}`,
    transport: options => {
      wire = options
      return {
        start: () => { connected = true }, close: () => { connected = false }, get connected() { return connected },
        send: message => {
          sent.push(asJson(message))
          const packet = message as { id?: number; method?: string }
          if (!packet.method) {
            if (uncertainSend) throw new Error('Synthetic response delivery is ambiguous')
            return
          }
          const result = packet.method === 'initialize' ? { userAgent: 'synthetic-auto-refusal' }
            : ['thread/start', 'thread/resume'].includes(packet.method) ? {
              thread: { id: threadId, status: { type: 'idle' }, turns: [] }, model: 'synthetic-model', reasoningEffort: 'low',
              modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, instructionSources: []
            }
              : packet.method === 'model/list' ? { data: [] }
                : packet.method === 'turn/start' ? { turn: { id: turnId, status: 'inProgress', items: [] } } : undefined
          if (result) queueMicrotask(() => inject({ id: packet.id, result }))
        }
      }
    }
  })
  cleanup.push(adapter)
  const request = (kind: 'commandExecution' | 'fileChange' | 'permissions' = 'commandExecution', command = 'Write-Output synthetic', availableDecisions: unknown[] = ['accept', 'decline', 'cancel']) => {
    inject({ id: nativeRequestId, method: `item/${kind}/requestApproval`, params: {
      threadId, turnId, itemId: 'auto-item', reason: 'Synthetic policy escalation', cwd: process.cwd(),
      ...(kind === 'commandExecution' ? { command, availableDecisions }
        : kind === 'permissions' ? { permissions: { network: { enabled: true } } } : {})
    } })
  }
  const fileChangeStarted = (...paths: string[]) => inject({ method: 'item/started', params: { threadId, turnId, item: { type: 'fileChange', id: 'auto-item', status: 'inProgress', changes: paths.map(path => ({ path, kind: { type: 'update', move_path: null }, diff: '' })) } } })
  const notices = (pattern: RegExp) => events.filter(event => event.data.type === 'notice' && pattern.test(event.data.message)).length
  const responses = () => sent.filter(packet => (packet as { id?: number; method?: string }).id === nativeRequestId && !(packet as { method?: string }).method)
  const pending = () => events.flatMap(event => event.data.type === 'interaction' && event.data.interaction.status === 'pending' ? [event.data.interaction] : [])
  const answer = (decision = 'accept', runtimeId = 'auto-runtime') => adapter.respond({ sessionId: 'synthetic-session', runtimeId, requestId, decision })
  return { adapter, events, sent, request, responses, pending, answer, fileChangeStarted, notices,
    start: () => adapter.submit('Synthetic approval lifecycle only', settings),
    disconnect: () => { connected = false; wire.onExit?.(1, null) },
    makeDeliveryUncertain: () => { uncertainSend = true }
  }
}

describe('Auto refusal incident: native approval lifecycle', () => {
  const answered: Array<['commandExecution' | 'fileChange' | 'permissions', Json]> = [
    ['commandExecution', { decision: 'accept' }], ['fileChange', { decision: 'accept' }], ['permissions', { permissions: { network: { enabled: true } }, scope: 'turn' }]
  ]
  it.each(answered)('Auto answers a %s escalation inside the owner\'s own files itself: one native accept for this request, no card, no session grant', async (kind, result) => {
    const f = fixture(); await f.start()
    if (kind === 'fileChange') f.fileChangeStarted('C:\\Users\\owner\\Desktop\\Invoices.lnk')
    f.request(kind)
    expect({ pending: f.pending(), responses: f.responses(), allowed: f.notices(/^Auto allowed .* without asking\.$/) })
      .toEqual({ pending: [], responses: [{ id: nativeRequestId, result }], allowed: 1 })
    expect(f.events.some(event => event.data.type === 'session' && event.data.phase === 'waiting_approval')).toBe(false)
    expect(f.events.some(event => event.data.type === 'interaction')).toBe(false)
  })

  it.each([
    ['the desktop shortcut the owner reported', '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut(\'C:\\Users\\owner\\Desktop\\Invoices.lnk\'); $s.TargetPath=\'C:\\Users\\owner\\Conductor\\faktury\\start-invoices.cmd\'; $s.Save()\''],
    ['a port query', 'Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object OwningProcess'],
    ['a copy into the profile', 'Copy-Item .\\out\\report.pdf C:\\Users\\owner\\Documents\\report.pdf']
  ])('Auto allows %s once', async (_what, command) => {
    const f = fixture(); await f.start(); f.request('commandExecution', command)
    expect({ pending: f.pending(), responses: f.responses() }).toEqual({ pending: [], responses: [{ id: nativeRequestId, result: { decision: 'accept' } }] })
  })

  it.each([
    ['a Windows system directory or the hosts file', 'Add-Content C:\\Windows\\System32\\drivers\\etc\\hosts "127.0.0.1 faktury.test"'],
    ['the registry', 'reg add HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Invoices /d start.cmd'],
    ['elevation', 'Start-Process powershell -Verb RunAs -ArgumentList "-File setup.ps1"'],
    ['services, scheduled tasks or startup', 'schtasks /create /tn Invoices /tr start.cmd /sc onlogon'],
    ['the firewall, network configuration or Defender', 'netsh advfirewall firewall add rule name=Invoices dir=in action=allow'],
    ['a credential or key store', 'Copy-Item .\\key C:\\Users\\owner\\.ssh\\id_ed25519'],
    ['disks, boot, accounts or permissions', 'icacls C:\\Users\\owner\\Documents /grant Everyone:F'],
    ['recursive deletion', 'Remove-Item -Recurse -Force C:\\Users\\owner\\Documents\\old']
  ])('an escalation that reaches %s stays an owner card in Auto, with the reason and the offered choices', async (boundary, command) => {
    const f = fixture(); await f.start(); f.request('commandExecution', command)
    expect({ pending: f.pending().map(interaction => interaction.choices.map(choice => choice.id)), responses: f.responses(), last: f.events.at(-1)?.data })
      .toMatchObject({ pending: [['accept', 'decline', 'cancel']], responses: [], last: { type: 'session', phase: 'waiting_approval' } })
    expect(f.notices(new RegExp('^Auto left “Synthetic policy escalation” to you: it reaches ' + boundary.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '\\. The native request is pending'))).toBe(1)
    await f.answer()
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'accept' } }])
  })

  // Verbatim from the controller session of 2026-09-23 (agent_mueapu6k_u5nkaij): Codex quotes its
  // PowerShell wrapper with doubled separators, and Auto held all six evaluation runs as "a Windows
  // system directory or the hosts file" because the wrapper path was never reduced.
  const liveWrapper = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '
  const liveEvaluation = liveWrapper + "'node artifacts/local-files/evaluate.mjs --acceptance-batch --docker=C:/Users/stilj/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe'"
  const livePrefix = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node', 'artifacts/local-files/evaluate.mjs'] } }

  it('Auto allows a live-quoted evaluation run once and never saves its prefix rule by itself', async () => {
    const f = fixture(); await f.start(); f.request('commandExecution', liveEvaluation, ['accept', livePrefix, 'cancel'])
    expect({ pending: f.pending(), responses: f.responses(), held: f.notices(/^Auto left/) }).toEqual({ pending: [], responses: [{ id: nativeRequestId, result: { decision: 'accept' } }], held: 0 })
  })

  it('a live-quoted wrapper still holds what the command itself reaches', async () => {
    expect(ownerOnlyEscalation(liveWrapper + "'Add-Content C:\\Windows\\System32\\drivers\\etc\\hosts x'")).toBe('a Windows system directory or the hosts file')
    expect(ownerOnlyEscalation(liveWrapper + "'Copy-Item k C:\\Users\\owner\\.docker\\config.json'")).toBe('a credential or key store')
    const f = fixture(); await f.start(); f.request('commandExecution', liveWrapper + "'reg add HKCU\\Software\\x'", ['accept', livePrefix, 'cancel'])
    expect(f.pending().map(interaction => interaction.choices.map(choice => choice.id))).toEqual([['accept', 'cancel']])
  })

  it('outside Auto the owner may save the prefix Codex offers, answered exactly as offered', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request('commandExecution', liveEvaluation, ['accept', livePrefix, 'cancel'])
    const [card] = f.pending()
    expect(card?.choices.map(choice => [choice.id, choice.label])).toEqual([['accept', 'Allow once'], ['acceptWithExecpolicyAmendment', 'Always allow `node artifacts/local-files/evaluate.mjs`'], ['cancel', 'Cancel turn']])
    await f.answer('acceptWithExecpolicyAmendment')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: livePrefix } }])
    const plain = fixture('accept-edits'); await plain.start(); plain.request('commandExecution', liveEvaluation, ['accept', 'cancel'])
    await expect(plain.answer('acceptWithExecpolicyAmendment')).rejects.toThrow('not offered')
  })

  it('a file change whose paths Auto cannot see, and a permission profile that reaches a boundary, stay owner cards', async () => {
    const blind = fixture(); await blind.start(); blind.request('fileChange')
    expect({ pending: blind.pending().length, responses: blind.responses(), held: blind.notices(/^Auto left .* to you: it names no paths Auto can check\./) }).toEqual({ pending: 1, responses: [], held: 1 })
    const seen = fixture(); await seen.start(); seen.fileChangeStarted('C:\\Users\\owner\\.ssh\\config'); seen.request('fileChange')
    expect({ pending: seen.pending().length, responses: seen.responses(), held: seen.notices(/it reaches a credential or key store/) }).toEqual({ pending: 1, responses: [], held: 1 })
    expect(ownerOnlyEscalation(JSON.stringify({ fileSystem: { write: ['C:\\Windows\\System32'] } }))).toBe('a Windows system directory or the hosts file')
    expect(ownerOnlyEscalation(JSON.stringify({ network: { enabled: true } }))).toBeUndefined()
  })

  it('a request that offers no plain accept stays pending in Auto with the offered choices, and the owner can still answer', async () => {
    const f = fixture(); await f.start(); f.request('commandExecution', 'Write-Output synthetic', ['decline', 'cancel'])
    expect({ pending: f.pending().map(interaction => interaction.choices.map(choice => choice.id)), responses: f.responses(), last: f.events.at(-1)?.data })
      .toMatchObject({ pending: [['decline', 'cancel']], responses: [], last: { type: 'session', phase: 'waiting_approval' } })
    expect(f.notices(/^Auto could not approve .*no plain accept/)).toBe(1)
    await f.answer('cancel')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'cancel' } }])
  })

  it('an exact repeated native request in Auto gets one accept, and a reused identity with other arguments is refused', async () => {
    const f = fixture(); await f.start(); f.request(); f.request()
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'accept' } }])
    f.request('commandExecution', 'Write-Output changed-scope'); f.request()
    const accepts = f.responses().filter(packet => (packet as { result?: { decision?: string } }).result?.decision === 'accept')
    expect({ accepts: accepts.length, errors: f.responses().filter(packet => 'error' in (packet as object)).length, pending: f.pending() }).toEqual({ accepts: 1, errors: 2, pending: [] })
  })

  it('renders a retained request with attention styling and enabled Allow/Deny controls', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request()
    const renderLatest = () => {
      const event = f.events.filter(event => event.data.type === 'interaction').at(-1)!
      const item = { id: 'visible-auto-request', runtimeId: 'auto-runtime', sequence: 1, timestamp: '2026-09-22T17:00:00Z', data: event.data }
      return renderToStaticMarkup(createElement(StructuredActivity, { item, sessionId: 'synthetic-session', cwd: process.cwd(), expanded: true, interactive: true,
        onExpand: () => undefined, onOpenFile: () => undefined, onDiff: () => undefined, onRespond: async (_item, decision) => { await f.answer(decision) } }))
    }
    const html = renderLatest()
    expect(html).toContain('sa-interaction needs-attention')
    expect(html).toContain('<button type="button">Allow once</button>')
    expect(html).toContain('<button type="button">Deny</button>')
    expect(html).toContain('Write-Output synthetic')
    await f.answer()
    expect(renderLatest()).not.toContain('>Allow once</button>')
    expect(renderLatest()).not.toContain('sa-interaction needs-attention')
  })

  it('an isolated reviewer in Auto retains its blocked native request; original-worker handoff is separate', async () => {
    const f = fixture('auto', { approvalReviewer: true }); await f.start(); f.request()
    expect({ pending: f.pending().length, responses: f.responses() }).toEqual({ pending: 1, responses: [] })
  })

  it('changed arguments under a reused native request ID invalidate the old owner choice', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request()
    f.request('commandExecution', 'Write-Output changed-scope')
    const outcome = await f.answer().then(() => 'accepted', () => 'refused')
    expect({ outcome, accepts: f.responses().filter(packet => (packet as { result?: { decision?: string } }).result?.decision === 'accept') })
      .toEqual({ outcome: 'refused', accepts: [] })
  })

  it('an exact repeated native request produces only one card and one owner response', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request(); f.request()
    expect(f.pending()).toHaveLength(1)
    expect(f.responses()).toEqual([])
    await f.answer()
    await expect(f.answer()).rejects.toThrow('already answered')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'accept' } }])
  })

  it('a changed identity stays invalid even if the provider sends the original arguments again', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request(); f.request('commandExecution', 'Write-Output changed'); f.request()
    await expect(f.answer()).rejects.toThrow('expired')
    expect(f.responses().some(packet => (packet as { result?: { decision?: string } }).result?.decision === 'accept')).toBe(false)
    expect(f.events.some(event => event.data.type === 'interaction' && event.data.interaction.status === 'expired' && /arguments changed/.test(event.data.interaction.outcome ?? ''))).toBe(true)
  })

  it('a reviewed Auto worker still grants a native turn permission by itself with the genuine permission response', async () => {
    // "Review coworkers" on the controller used to hold this for the owner; Auto stays Auto.
    const f = fixture('auto', { reviewApprovals: true }); await f.start(); f.request('permissions')
    expect(f.pending()).toEqual([])
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { permissions: { network: { enabled: true } }, scope: 'turn' } }])
  })

  it('Edit exposes the exact native request and sends one owner response despite two views', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request()
    expect(f.pending()[0]).toMatchObject({ id: requestId, input: { command: 'Write-Output synthetic', cwd: process.cwd(), threadId, turnId } })
    expect(f.responses()).toEqual([])
    await expect(f.answer('accept', 'stale-runtime')).rejects.toThrow('stale runtime')
    await expect(f.answer('acceptForSession')).rejects.toThrow('not offered')
    await f.answer()
    await expect(f.answer()).rejects.toThrow('already answered')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'accept' } }])
  })

  it('the host review opt-in on the controller does not stop an Auto worker from answering its own request', async () => {
    const f = fixture('auto', { reviewApprovals: true }); await f.start(); f.request()
    expect(f.pending()).toEqual([])
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'accept' } }])
  })

  it('an actual owner denial sends decline once and cannot be replaced by a second answer', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request()
    await f.answer('decline')
    await expect(f.answer()).rejects.toThrow('already answered')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'decline' } }])
    expect(f.events.some(event => event.data.type === 'interaction' && event.data.interaction.outcome === 'decline')).toBe(true)
  })

  it('the separate journal keeps human denial durable across reconstruction and changed worker arguments', async () => {
    const store = new Map<string, string>()
    const persistence = { getSetting: (key: string) => store.get(key) ?? null, setSetting: (key: string, value: string) => { store.set(key, value) } }
    const journal = new ApprovalReviews(persistence)
    const action: ReviewAction = { projectId: 'synthetic-project', machineId: 'synthetic-device', workerId: 'worker', runtimeId: 'runtime', requestId: 'request',
      tool: 'synthetic-operation', arguments: { value: 1 }, paths: ['synthetic-target'], boundary: 'native-owner', reason: 'Native owner answer required',
      sideEffects: [], ownerEvidence: 'Synthetic owner task', authorizationId: 'owner-task', native: {} }
    const record = await journal.review(action, async digest => ({ digest, decision: 'escalate', rationale: 'Owner required', reviewerId: 'separate-reviewer', model: 'synthetic-reviewer', turnId: 'review-turn' }), () => undefined)
    expect(record.phase).toBe('owner')
    journal.reserve(action, 'deny')
    const recovered = new ApprovalReviews(persistence)
    expect(recovered.denied({ ...action, workerId: 'replacement', arguments: { value: 2 } })).toBe(true)
    expect(() => recovered.reserve(action, 'allow')).toThrow()
  })

  it('reconnect never replays input or a stale response; recovery of the pending card remains unsupported', async () => {
    const first = fixture('accept-edits'); await first.start(); first.request(); first.disconnect()
    await expect(first.answer()).rejects.toThrow('stale runtime')
    expect(first.responses()).toEqual([])
    expect(first.events.some(event => event.data.type === 'interaction' && event.data.interaction.status === 'expired')).toBe(true)
    const resumed = fixture('accept-edits', { nativeSessionId: threadId, runtimeId: 'replacement-runtime' })
    await resumed.adapter.start()
    await expect(resumed.answer('accept', 'replacement-runtime')).rejects.toThrow('expired')
    expect(resumed.sent.some(packet => (packet as { method?: string }).method === 'turn/start')).toBe(false)
    expect(resumed.responses()).toEqual([])
  })

  it('ambiguous native response delivery is explicit and never retried as a second execution', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request(); f.makeDeliveryUncertain()
    await expect(f.answer()).rejects.toThrow('delivery is ambiguous')
    await expect(f.answer()).rejects.toThrow('stale runtime')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'accept' } }])
    expect(f.events.some(event => event.data.type === 'interaction' && event.data.interaction.outcome === 'Delivery uncertain after disconnect')).toBe(true)
    expect(f.events.at(-1)?.data).toMatchObject({ type: 'session', phase: 'disconnected', message: expect.stringContaining('uncertain') })
  })
})
