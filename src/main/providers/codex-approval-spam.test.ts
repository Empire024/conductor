import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AdapterEvent, Json, SessionSettings } from '../../shared/structured-agent'
import type { AdapterOptions } from './adapter'
import type { TransportOptions } from './transport'
import { CodexAdapter, CODEX_PROTOCOL_BASELINE, CODEX_SANDBOX_FILE, codexPreset, codexSandboxSettings, ownerOnlyEscalation, ownerOnlyReach } from './codex'
import { reachOf } from '../approval-review-gate'
import { defaultApprovalPolicy, evaluateApprovalPolicy, setCurrentApprovalPolicy, type PolicyRequest } from '../approval-policy'

// feature-list conductor-task:codex-approval-spam (owner 2026-10-17): a normal Blender, Python and
// download workflow of Codex coworkers in the miron project must raise no approval card. Offline:
// no process, provider, model or network; the commands are verbatim from that day's miron requests.

const roots: string[] = []
const adapters: CodexAdapter[] = []
const localAppData = process.env.LOCALAPPDATA
afterEach(() => {
  adapters.splice(0).forEach(adapter => adapter.dispose())
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
  setCurrentApprovalPolicy(defaultApprovalPolicy())
  delete process.env.CONDUCTOR_TEST_SANDBOX_ROOT
  if (localAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = localAppData
})
// The real path: macOS's tmpdir is /var/folders, a link into /private/var, and /var is a system folder.
const temp = (name: string): string => { const root = realpathSync.native(mkdtempSync(join(tmpdir(), `conductor-${name}-`))); roots.push(root); return root }
const windows = process.platform === 'win32'

/** Codex's Windows wrapper exactly as it arrives: literal doubled separators, the script in quotes. */
const wrap = (script: string, quote: '"' | "'" = '"'): string => `"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command ${quote}${script}${quote}`
const BLENDER_PYTHON = "'C:/Program Files/Blender Foundation/Blender 5.2/5.2/python/bin/python.exe'"
const SYSTEM = 'a Windows system directory or the hosts file'

describe('owner-only boundaries are judged on what a command touches, not where its program lives', () => {
  it.each([
    ['the dataset collector on Blender\'s bundled Python', wrap(`& ${BLENDER_PYTHON} rosin_lab/collect_references.py download`)],
    ['a background GPU render with its log redirected', wrap("& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python rosin_lab/scene.py -- --config rosin_lab/output/wet-v3/config.json --output rosin_lab/output/wet-v3 *> rosin_lab/output/wet-v3/render.log")],
    ['a Pillow check chained after a listing', wrap(`Get-ChildItem .deps/PIL -Name | Select-Object -First 5; & ${BLENDER_PYTHON} -c \\"import sys; sys.path.insert(0, '.deps'); import PIL.Image; print('Pillow ready')\\"`)],
    ['a render whose output folder has spaces', wrap(`& ${BLENDER_PYTHON} 'C:/Claude/miron/render_showcase.py' --recipe 'C:/Claude/miron/scenes/haf-showcase-duo.json' --mode still --output 'C:/Claude/miron/Real miron/output/haf-showcase-duo-20260929-stills-v1'`)],
    ['an inline download with requests', wrap(`& ${BLENDER_PYTHON} -c \\"import requests,pathlib; p=pathlib.Path('rosin_lab/dataset/images'); p.mkdir(parents=True,exist_ok=True)\\"`)],
    ['a curl download into the project', wrap("curl.exe -L --fail --max-time 30 'https://www.primaryjane.com/wp-content/uploads/2025/06/Pure-GOLD-THCA-Live-Rosin-open-top.webp' -o reference_review/rosin/primary-jane.webp")],
    ['a double-quoted path with backslashes', '"C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup --python-exit-code 1 --python tests/verify_rosin.py'],
    ['a path through $env:ProgramFiles', wrap('& \\"$env:ProgramFiles\\Blender Foundation\\Blender 5.2\\blender.exe\\" -b scene.blend')],
    ['Start-Process -FilePath', wrap("Start-Process -FilePath 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe' -ArgumentList '-b','scene.blend' -Wait", "'")],
    ['cmd /c', 'cmd /c "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" -b scene.blend'],
    ['the review gate\'s JSON-quoted form', reachOf({ command: wrap(`& ${BLENDER_PYTHON} rosin_lab/collect_references.py sheets`) })],
    ['a listing of the installed Blender versions', wrap("Get-ChildItem 'C:/Program Files/Blender Foundation' -Directory")],
    ['a program installed in ProgramData', "& 'C:\\ProgramData\\chocolatey\\bin\\choco.exe' list"],
    ['a system tool run by its full path', "& 'C:\\Windows\\System32\\robocopy.exe' renders backup /E"]
  ])('lets %s through', (_what, command) => {
    expect(ownerOnlyEscalation([command, 'C:\\Claude\\miron', ''].join('\n'))).toBeUndefined()
  })

  it.each([
    ['--hosts as an option', 'python serve.py --hosts 3'],
    ['hosts in a host name and a file name', 'Invoke-WebRequest https://hosts.example.com/list -OutFile hosts.json'],
    ['Get-Credential', '$cred = Get-Credential'],
    ['credential in a document name', 'Get-Content docs/credential-rotation.md'],
    ['credential in a commit message', 'git commit -m "document the credential rotation"'],
    ['vault as a word', 'python vault_report.py --vault obsidian'],
    ['Get-Date -Format', '$stamp = Get-Date -Format yyyyMMdd-HHmmss; New-Item -ItemType Directory rosin_lab/output/$stamp'],
    ['a shutdown method', 'python -c "httpd.shutdown()"'],
    ['Blender\'s scripts/startup folder', 'Copy-Item addon.py rosin_lab/scripts/startup/addon.py'],
    ['reading a file in ProgramData', 'Get-Content C:\\ProgramData\\NVIDIA\\NvTelemetry.log'],
    ['the profile\'s own Microsoft\\Windows folder', 'Get-ChildItem $env:LOCALAPPDATA\\Microsoft\\Windows\\INetCache']
  ])('no longer holds %s', (_what, command) => {
    expect(ownerOnlyEscalation(command)).toBeUndefined()
  })

  it.each([
    ['Add-Content C:\\Windows\\System32\\drivers\\etc\\hosts "127.0.0.1 faktury.test"', `${SYSTEM} (“C:\\Windows\\System32\\drivers\\etc\\hosts”)`],
    [wrap('Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts', "'"), `${SYSTEM} (“C:\\Windows\\System32\\drivers\\etc\\hosts”)`],
    ['cat /etc/hosts', `${SYSTEM} (“/etc/hosts”)`],
    ["Copy-Item addon.py 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\5.2\\scripts\\addons\\addon.py'", `${SYSTEM} (“C:\\Program Files\\Blender”)`],
    ["Set-Content C:\\ProgramData\\Miron\\config.ini 'a=1'", `${SYSTEM} (“C:\\ProgramData\\Miron\\config.ini”)`],
    ['echo x > "%ProgramData%\\miron\\a.txt"', `${SYSTEM} (“%ProgramData%\\miron\\a.txt”)`],
    ['"x" | Out-File $env:ProgramData\\miron\\log.txt', `${SYSTEM} (“$env:ProgramData\\miron\\log.txt”)`],
    ['C:\\ProgramData\\miron\\a.txt', `${SYSTEM} (“C:\\ProgramData\\miron\\a.txt”)`],
    [JSON.stringify({ fileSystem: { write: ['C:\\ProgramData\\miron'] } }), `${SYSTEM} (“C:\\ProgramData\\miron”)`],
    ['robocopy renders C:\\Windows\\System32\\miron', `${SYSTEM} (“C:\\Windows\\System32\\miron”)`],
    [reachOf({ file_path: 'C:\\Windows\\System32\\x.dll', content: 'x' }), `${SYSTEM} (“C:\\Windows\\System32\\x.dll”)`],
    ['Copy-Item x.lnk "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk"', 'services, scheduled tasks or startup (“$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk”)'],
    ['cmdkey /list', 'a credential or key store (“cmdkey”)'],
    ['git credential fill', 'a credential or key store (“git credential”)'],
    ['git -C ../site credential fill', 'a credential or key store (“git -C ../site credential”)'],
    ['git config --global credential.helper manager', 'a credential or key store (“credential.helper”)'],
    ['Copy-Item x $env:APPDATA\\Microsoft\\Credentials\\', 'a credential or key store (“$env:APPDATA\\Microsoft\\Credentials\\”)'],
    ['vault kv get secret/app', 'a credential or key store (“vault kv”)'],
    ['format D: /q', 'disks, boot, accounts or permissions (“format D:”)'],
    ['shutdown /s /t 0', 'disks, boot, accounts or permissions (“shutdown /s”)'],
    ['"C:\\Windows\\System32\\reg.exe" add HKLM\\Software\\Miron /v a /d 1', 'the registry (“reg add”)']
  ])('still holds %s, naming what matched', (reach, boundary) => {
    expect(ownerOnlyEscalation(reach)).toBe(boundary)
  })

  it('gives the boundary and the matched text apart, for a caller that wants them separately', () => {
    expect(ownerOnlyReach('Add-Content C:\\Windows\\System32\\drivers\\etc\\hosts x')).toEqual({ boundary: SYSTEM, matched: 'C:\\Windows\\System32\\drivers\\etc\\hosts' })
    expect(ownerOnlyReach(wrap(`& ${BLENDER_PYTHON} rosin_lab/collect_references.py download`))).toBeUndefined()
  })
})

// One in-memory App Server per test: requests are injected, responses read from what was sent.
const threadId = 'spam-thread', turnId = 'spam-turn'
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json
function fixture(permission: SessionSettings['permission'] = 'accept-edits', extra: Partial<AdapterOptions> = {}, cwd = process.cwd()) {
  const settings: SessionSettings = { permission, plan: false }
  const events: AdapterEvent[] = [], sent: Json[] = []
  let wire!: TransportOptions, connected = false
  const inject = (message: unknown) => wire.onMessage(asJson(message))
  const adapter = new CodexAdapter({ executable: 'never-launched', cwd, runtimeId: 'spam-runtime', settings, ...extra, emit: event => events.push(event) }, {
    version: async () => `codex-cli ${CODEX_PROTOCOL_BASELINE}`,
    transport: options => {
      wire = options
      return {
        start: () => { connected = true }, close: () => { connected = false }, get connected() { return connected },
        send: message => {
          sent.push(asJson(message))
          const packet = message as { id?: number; method?: string }
          if (!packet.method) return
          const result = packet.method === 'initialize' ? { userAgent: 'synthetic-approval-spam' }
            : ['thread/start', 'thread/resume'].includes(packet.method) ? { thread: { id: threadId, status: { type: 'idle' }, turns: [] }, model: 'synthetic-model', reasoningEffort: 'low', modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, instructionSources: [] }
              : packet.method === 'model/list' ? { data: [] }
                : packet.method === 'turn/start' ? { turn: { id: turnId, status: 'inProgress', items: [] } } : undefined
          if (result) queueMicrotask(() => inject({ id: packet.id, result }))
        }
      }
    }
  })
  adapters.push(adapter)
  const command = (id: number, script: string, availableDecisions: unknown[] = ['accept', 'decline', 'cancel'], extraParams: Record<string, unknown> = {}) => inject({ id, method: 'item/commandExecution/requestApproval', params: {
    threadId, turnId, itemId: `item-${id}`, reason: `Synthetic escalation ${id}`, command: script, cwd, kind: 'command', environmentId: null, startedAtMs: 0, availableDecisions, ...extraParams
  } })
  const fileChange = (id: number, grantRoot: string, paths: string[] = []) => {
    if (paths.length) inject({ method: 'item/started', params: { threadId, turnId, item: { type: 'fileChange', id: `item-${id}`, status: 'inProgress', changes: paths.map(path => ({ path, kind: { type: 'update', move_path: null }, diff: '' })) } } })
    inject({ id, method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: `item-${id}`, reason: 'Synthetic file change', grantRoot } })
  }
  const pending = () => events.flatMap(event => event.data.type === 'interaction' && event.data.interaction.status === 'pending' ? [event.data.interaction] : [])
  const responses = (id: number) => sent.filter(packet => (packet as { id?: number; method?: string }).id === id && !(packet as { method?: string }).method)
  const notices = () => events.flatMap(event => event.data.type === 'notice' ? [event.data] : [])
  const turnStart = () => (sent.filter(packet => (packet as { method?: string }).method === 'turn/start').at(-1) as { params: Record<string, Json> } | undefined)?.params
  return { adapter, events, sent, inject, command, fileChange, pending, responses, notices, turnStart, settings,
    start: () => adapter.submit('Synthetic approval spam check', settings),
    answer: (id: number, decision: string) => adapter.respond({ sessionId: 'spam-session', runtimeId: 'spam-runtime', requestId: `number:${id}`, decision }) }
}
const amendmentOf = (script: string) => ({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', script] } })

describe('"for this session" on a Codex command is its execpolicy amendment and a session class', () => {
  it('answers the session choice with the amendment Codex offered, then runs the same kind of command without a card', async () => {
    const f = fixture('accept-edits'); await f.start()
    const download = 'python rosin_lab/collect_references.py download'
    f.command(701, wrap(download), ['accept', amendmentOf(download), 'cancel'])
    const [card] = f.pending()
    expect(card?.choices.map(choice => choice.id)).toEqual(['accept', 'acceptForSession', 'cancel'])
    await f.answer(701, 'acceptForSession')
    expect(f.responses(701)).toEqual([{ id: 701, result: { decision: amendmentOf(download) } }])
    // The same script with another subcommand is the same class: allowed for the session, no card.
    f.command(702, wrap('python rosin_lab/collect_references.py sheets'), ['accept', amendmentOf('python rosin_lab/collect_references.py sheets'), 'cancel'])
    expect(f.responses(702)).toEqual([{ id: 702, result: { decision: 'accept' } }])
    expect(f.pending().filter(interaction => interaction.id === 'number:702')).toEqual([])
    expect(f.notices().at(-1)).toMatchObject({ message: expect.stringContaining('for this session without asking: a command of the same kind'), payload: { sessionClass: expect.stringContaining('python rosin_lab/collect_references.py') } })
    // Another script is another class, and asks.
    f.command(703, wrap('python rosin_lab/other_tool.py'), ['accept', 'cancel'])
    expect(f.responses(703)).toEqual([])
    expect(f.pending().map(interaction => interaction.id)).toContain('number:703')
  })

  it('keeps Codex\'s own session grant native, with its prefix rule a separate Always allow', async () => {
    const f = fixture('accept-edits'); await f.start()
    f.command(711, wrap('npm run lint'), ['accept', 'acceptForSession', amendmentOf('npm run lint'), 'cancel'])
    expect(f.pending()[0]?.choices.map(choice => choice.id)).toEqual(['accept', 'acceptWithExecpolicyAmendment', 'acceptForSession', 'cancel'])
    await f.answer(711, 'acceptForSession')
    expect(f.responses(711)).toEqual([{ id: 711, result: { decision: 'acceptForSession' } }])
    const g = fixture('accept-edits'); await g.start()
    g.command(712, wrap('npm run lint'), ['accept', 'acceptForSession', amendmentOf('npm run lint'), 'cancel'])
    await g.answer(712, 'acceptWithExecpolicyAmendment')
    expect(g.responses(712)).toEqual([{ id: 712, result: { decision: amendmentOf('npm run lint') } }])
  })

  it('never offers a session or forms a class for an owner-only command, in any mode', async () => {
    const f = fixture('accept-edits'); await f.start()
    const registry = 'reg add HKCU\\Software\\Miron /v a /d 1'
    f.command(721, wrap(registry), ['accept', amendmentOf(registry), 'cancel'])
    const [card] = f.pending()
    expect(card?.choices.map(choice => choice.id)).toEqual(['accept', 'cancel'])
    expect(card?.required).toBe(true)
    await expect(f.answer(721, 'acceptForSession')).rejects.toThrow('not offered')
    await f.answer(721, 'accept')
    f.command(722, wrap(registry), ['accept', amendmentOf(registry), 'cancel'])
    expect(f.responses(722)).toEqual([])
    expect(f.pending().map(interaction => interaction.id)).toContain('number:722')
  })
})

describe('network is on by default in both workspace-write modes', () => {
  it('maps Edit and Auto to a networked workspace sandbox and keeps Read only offline', () => {
    expect(codexPreset({ permission: 'accept-edits' })).toMatchObject({ sandbox: 'workspace-write', network: true, unattended: false })
    expect(codexPreset({ permission: 'auto' })).toMatchObject({ sandbox: 'workspace-write', network: true, unattended: true })
    expect(codexPreset({ permission: 'read-only' })).toMatchObject({ network: false })
  })

  it.each(['accept-edits', 'auto'] as const)('sends networkAccess in %s, and a project\'s "network": false turns it off', async permission => {
    // No owner roots here (not even the OptiX default), so the sandbox is exactly the workspace.
    setCurrentApprovalPolicy({ ...defaultApprovalPolicy(), writableRoots: [] })
    const project = temp('codex-network')
    const on = fixture(permission, {}, project); await on.start()
    expect(on.turnStart()?.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: [project], networkAccess: true })
    mkdirSync(join(project, '.conductor'))
    writeFileSync(join(project, CODEX_SANDBOX_FILE), JSON.stringify({ network: false }))
    const off = fixture(permission, {}, project); await off.start()
    expect(off.turnStart()?.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', networkAccess: false })
    const readOnly = fixture('read-only', {}, project); await readOnly.start()
    expect(readOnly.turnStart()?.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false })
  })
})

describe('extra writable roots of the Codex sandbox', () => {
  it('adds the project\'s real .deps and .cache folders, never a file or a link', () => {
    const project = temp('codex-roots')
    mkdirSync(join(project, '.deps'))
    writeFileSync(join(project, '.cache'), 'not a folder')
    expect(codexSandboxSettings(project, { projectRoots: false })).toEqual({ writableRoots: [join(project, '.deps')], problems: [] })
    const linked = temp('codex-roots-linked'), target = temp('codex-roots-target')
    let link = true
    try { symlinkSync(target, join(linked, '.deps'), 'junction') } catch { link = false }
    if (link) expect(codexSandboxSettings(linked, { projectRoots: true }).writableRoots).toEqual([])
  })

  it('takes the owner\'s roots in every mode and the project file\'s roots in Auto only, expanded and checked', () => {
    const project = temp('codex-roots-file'), outside = temp('codex-roots-outside')
    mkdirSync(join(outside, 'OptixCache'))
    process.env.CONDUCTOR_TEST_SANDBOX_ROOT = outside
    mkdirSync(join(project, '.conductor'))
    writeFileSync(join(project, CODEX_SANDBOX_FILE), JSON.stringify({ writableRoots: ['%CONDUCTOR_TEST_SANDBOX_ROOT%/OptixCache', 'relative/cache', join(outside, 'missing'), dirname(project)] }))
    const auto = codexSandboxSettings(project, { projectRoots: true })
    expect(auto.writableRoots).toEqual([join(outside, 'OptixCache')])
    expect(auto.problems).toEqual([
      expect.stringContaining('relative/cache was left out'),
      expect.stringMatching(/missing was left out: it does not exist/),
      expect.stringMatching(/was left out: it contains the project itself/)
    ])
    const edit = codexSandboxSettings(project, { projectRoots: false, ownerRoots: [outside, join(outside, 'not-on-this-machine')] })
    // An owner root that does not exist here (the OptiX default without an NVIDIA GPU) does not apply, silently.
    expect(edit.writableRoots).toEqual([outside])
    expect(edit.problems).toEqual([expect.stringContaining('apply in Auto only')])
    if (windows) expect(codexSandboxSettings(project, { projectRoots: false, ownerRoots: ['C:\\Windows\\Temp'] }).problems).toEqual([expect.stringContaining('owner\'s writable root C:\\Windows\\Temp was left out'), expect.stringContaining('apply in Auto only')])
  })

  it('reports a malformed project file and keeps the defaults', () => {
    const project = temp('codex-roots-bad')
    mkdirSync(join(project, '.conductor'))
    writeFileSync(join(project, CODEX_SANDBOX_FILE), '{ not json')
    expect(codexSandboxSettings(project, { projectRoots: true })).toMatchObject({ writableRoots: [], problems: [expect.stringContaining('could not be read')] })
    writeFileSync(join(project, CODEX_SANDBOX_FILE), JSON.stringify({ network: 'off', roots: [] }))
    expect(codexSandboxSettings(project, { projectRoots: true }).problems).toEqual([expect.stringContaining('unknown key(s) roots'), expect.stringContaining('"network" must be true or false')])
  })

  it('passes the roots into the turn\'s sandbox policy and says once which folders they are', async () => {
    const project = temp('codex-roots-turn'), outside = temp('codex-roots-owner')
    mkdirSync(join(project, '.deps'))
    setCurrentApprovalPolicy({ ...defaultApprovalPolicy(), writableRoots: [outside] })
    const f = fixture('accept-edits', {}, project); await f.start()
    expect(f.turnStart()?.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: [project, join(project, '.deps'), outside], networkAccess: true })
    expect(f.notices().filter(notice => notice.message.startsWith('Codex sandbox: besides the workspace'))).toHaveLength(1)
  })

  it.runIf(windows)('carries the default OptiX cache root once it exists, and skips it without a notice where it does not', async () => {
    // The policy's default writable root (DEFAULT_WRITABLE_ROOTS) is %LOCALAPPDATA%\NVIDIA\OptixCache:
    // a sandboxed Blender GPU render stalled when it could not write there (miron, 2026-10-17).
    const project = temp('codex-optix'), local = temp('codex-optix-localappdata')
    process.env.LOCALAPPDATA = local
    const absent = fixture('auto', {}, project); await absent.start()
    expect(absent.turnStart()?.sandboxPolicy).toMatchObject({ writableRoots: [project] })
    expect(absent.notices().filter(notice => notice.message.startsWith('Codex sandbox'))).toEqual([])
    mkdirSync(join(local, 'NVIDIA', 'OptixCache'), { recursive: true })
    const present = fixture('accept-edits', {}, project); await present.start()
    expect(present.turnStart()?.sandboxPolicy).toMatchObject({ writableRoots: [project, join(local, 'NVIDIA', 'OptixCache')], networkAccess: true })
  })
})

describe('the owner\'s auto-approve policy answers a Codex request before any card', () => {
  const blender = wrap(`& ${BLENDER_PYTHON} rosin_lab/collect_references.py download`)

  it('accepts what the policy allows once, with its notice, and asks it exactly what Codex asked', async () => {
    const project = temp('codex-policy')
    const approvalPolicy = vi.fn(() => ({ decision: 'allow' as const, rule: 'blender' }))
    const f = fixture('accept-edits', { approvalPolicy }, project); await f.start()
    f.command(801, blender, ['accept', amendmentOf('x'), 'cancel'])
    expect(f.pending()).toEqual([])
    expect(f.responses(801)).toEqual([{ id: 801, result: { decision: 'accept' } }])
    expect(f.notices().at(-1)).toEqual({ type: 'notice', message: `Allowed by the auto-approve policy (blender): & ${BLENDER_PYTHON} rosin_lab/collect_references.py download`, payload: { approvalPolicy: { rule: 'blender' } } })
    expect(approvalPolicy).toHaveBeenCalledTimes(1)
    expect(approvalPolicy).toHaveBeenCalledWith({ provider: 'codex', kind: 'command', command: blender, cwd: project, projectRoot: project },
      { requestId: 'number:801', tool: 'Command', input: expect.objectContaining({ command: blender, itemId: 'item-801' }) })
    // A repeated delivery is neither asked again nor answered twice.
    f.command(801, blender, ['accept', amendmentOf('x'), 'cancel'])
    expect(approvalPolicy).toHaveBeenCalledTimes(1)
    expect(f.responses(801)).toHaveLength(1)
  })

  it('asks about a file change with its grant root and paths, and about network access as network', async () => {
    const project = temp('codex-policy-kinds')
    const approvalPolicy = vi.fn((_request: PolicyRequest) => null)
    const f = fixture('accept-edits', { approvalPolicy }, project); await f.start()
    f.fileChange(811, join(project, 'renders'), [join(project, 'renders', 'a.png')])
    f.command(812, 'curl.exe -L https://example.com/a.png -o renders/a.png', ['accept', 'cancel'], { networkApprovalContext: { host: 'example.com', protocol: 'https' } })
    expect(approvalPolicy.mock.calls.map(([request]) => request)).toEqual([
      { provider: 'codex', kind: 'file-write', paths: [join(project, 'renders'), join(project, 'renders', 'a.png')], cwd: project, projectRoot: project },
      { provider: 'codex', kind: 'network', command: 'curl.exe -L https://example.com/a.png -o renders/a.png', cwd: project, projectRoot: project }
    ])
    // Null leaves both to the normal path: two cards.
    expect(f.pending().map(interaction => interaction.id)).toEqual(['number:811', 'number:812'])
  })

  it('never lets the policy answer an owner-only request, and a policy that throws is no answer', async () => {
    const approvalPolicy = vi.fn(() => ({ decision: 'allow' as const, rule: 'workspace-write' }))
    const f = fixture('accept-edits', { approvalPolicy }); await f.start()
    f.command(821, wrap('reg add HKCU\\Software\\Miron /v a /d 1'))
    expect(approvalPolicy).toHaveBeenCalledWith(expect.objectContaining({ nativeOwner: true }), expect.anything())
    expect(f.responses(821)).toEqual([])
    expect(f.pending()[0]).toMatchObject({ id: 'number:821', required: true })
    const g = fixture('accept-edits', { approvalPolicy: () => { throw new Error('policy store unreadable') } }); await g.start()
    g.command(822, wrap('python rosin_lab/collect_references.py download'))
    expect(g.pending().map(interaction => interaction.id)).toEqual(['number:822'])
  })

  it('is not asked by an isolated reviewer, for MCP tools or permission grants, or for what Auto answers itself', async () => {
    const approvalPolicy = vi.fn(() => ({ decision: 'allow' as const, rule: 'python' }))
    const reviewer = fixture('accept-edits', { approvalPolicy, approvalReviewer: true }); await reviewer.start()
    reviewer.command(831, wrap('python rosin_lab/collect_references.py download'))
    const auto = fixture('auto', { approvalPolicy }); await auto.start()
    auto.command(832, wrap(`& ${BLENDER_PYTHON} rosin_lab/collect_references.py download`), ['accept', amendmentOf('x'), 'cancel'])
    expect(auto.responses(832)).toEqual([{ id: 832, result: { decision: 'accept' } }])
    expect(auto.notices().at(-1)?.message).toMatch(/^Auto allowed .* without asking\.$/)
    const edit = fixture('accept-edits', { approvalPolicy }); await edit.start()
    edit.inject({ id: 833, method: 'item/permissions/requestApproval', params: { threadId, turnId, itemId: 'item-833', reason: 'Synthetic permission', permissions: { network: { enabled: true } } } })
    edit.inject({ id: 834, method: 'mcpServer/elicitation/request', params: { threadId, turnId, serverName: 'conductor-browser', mode: 'form', message: 'Allow the conductor-browser MCP server to run tool "browser_snapshot"?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session'] } } })
    expect(approvalPolicy).not.toHaveBeenCalled()
    expect(reviewer.pending().map(interaction => interaction.id)).toEqual(['number:831'])
    expect(edit.pending().map(interaction => interaction.id)).toEqual(['number:833', 'number:834'])
  })

  it('allows the miron Blender collector through the real policy, with the request shape it reads', async () => {
    const project = temp('codex-policy-real')
    mkdirSync(join(project, 'rosin_lab'))
    writeFileSync(join(project, 'rosin_lab', 'collect_references.py'), 'print("collect")\n')
    const f = fixture('accept-edits', { approvalPolicy: request => evaluateApprovalPolicy(request, defaultApprovalPolicy()) }, project); await f.start()
    f.command(841, blender, ['accept', amendmentOf('x'), 'cancel'])
    expect(f.pending()).toEqual([])
    expect(f.responses(841)).toEqual([{ id: 841, result: { decision: 'accept' } }])
    expect(f.notices().at(-1)?.payload).toEqual({ approvalPolicy: { rule: expect.stringContaining('blender') } })
  })
})
