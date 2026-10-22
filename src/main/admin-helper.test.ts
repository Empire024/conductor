import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_ACTIONS, AdminHelper, AdminRequestError, parseAdminResult, validateAdminRequest, type AdminAction } from './admin-helper'

const run = promisify(execFile)
const helperDir = resolve(__dirname, '..', '..', 'scripts', 'admin-helper')
const roots: string[] = []
const tempRoot = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), 'conductor-admin-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const installed = async (root: string): Promise<void> => {
  await mkdir(join(root, 'queue', 'requests'), { recursive: true })
  await mkdir(join(root, 'queue', 'results'), { recursive: true })
  await writeFile(join(root, 'VERSION.json'), JSON.stringify({ installedAt: '2026-10-22T00:00:00.000Z', commit: 'abc1234' }))
}

describe('admin helper allowlist', () => {
  it('matches the elevated runner\'s own copy in scripts/admin-helper/actions.json', async () => {
    const file = JSON.parse(await readFile(join(helperDir, 'actions.json'), 'utf8')) as { actions: Record<string, AdminAction> }
    expect(file.actions).toEqual(ADMIN_ACTIONS)
    for (const action of Object.values(file.actions)) expect((await readdir(join(helperDir, 'actions')))).toContain(action.script)
  })

  it('accepts only allowlisted actions with their declared args', () => {
    expect(validateAdminRequest('firewall-candidate-cleanup', undefined)).toEqual({ action: 'firewall-candidate-cleanup', args: {} })
    expect(validateAdminRequest('firewall-candidate-cleanup', { dryRun: true })).toEqual({ action: 'firewall-candidate-cleanup', args: { dryRun: true } })
    for (const action of ['format-disk', 'toString', '__proto__', 'constructor', '', 7, null]) expect(() => validateAdminRequest(action, {})).toThrow(AdminRequestError)
    expect(() => validateAdminRequest('firewall-candidate-cleanup', { dryRun: 'yes' })).toThrow(/dryRun must be true or false/)
    expect(() => validateAdminRequest('firewall-candidate-cleanup', { program: 'C:\\x.exe' })).toThrow(/takes no argument "program"; it takes dryRun/)
    expect(() => validateAdminRequest('firewall-candidate-cleanup', JSON.parse('{"__proto__":{"dryRun":true}}'))).toThrow(AdminRequestError)
    expect(() => validateAdminRequest('firewall-candidate-cleanup', ['dryRun'])).toThrow(/args must be an object/)
  })

  it('reads only result files written for that request id', () => {
    expect(parseAdminResult('\uFEFF{"id":"20261022-aaaaaaaaaaaa","ok":true}', '20261022-aaaaaaaaaaaa')).toEqual({ id: '20261022-aaaaaaaaaaaa', ok: true })
    expect(parseAdminResult('{"id":"other-aaaaaaaaaaaa","ok":true}', '20261022-aaaaaaaaaaaa')).toBeNull()
    expect(parseAdminResult('{"id":"20261022-aaaaaaaaaaaa"}', '20261022-aaaaaaaaaaaa')).toBeNull()
    expect(parseAdminResult('not json', '20261022-aaaaaaaaaaaa')).toBeNull()
  })
})

describe('admin helper queue', () => {
  it('refuses before queueing when the helper is not installed, and names the install command', async () => {
    const root = await tempRoot()
    const startTask = vi.fn(async () => {})
    const helper = new AdminHelper({ root, startTask, platform: 'win32', taskInstalled: async () => false })
    await expect(helper.run({ action: 'firewall-candidate-cleanup', by: 'owner' })).rejects.toThrow(/not installed.*install\.ps1/)
    await expect(helper.run({ action: 'nope', by: 'owner' })).rejects.toThrow(AdminRequestError)
    expect(startTask).not.toHaveBeenCalled()
    expect(await helper.status()).toMatchObject({ installed: false, recent: [], install: expect.stringContaining('install.ps1') })
  })

  it('queues a request, starts the task and returns the result the task writes', async () => {
    const root = await tempRoot()
    await installed(root)
    const startTask = vi.fn(async () => {
      // Stand-in for the elevated runner: take the request, write the result.
      const name = (await readdir(join(root, 'queue', 'requests')))[0] as string
      const request = JSON.parse(await readFile(join(root, 'queue', 'requests', name), 'utf8'))
      expect(name).toBe(`${request.id}.json`)
      expect(request).toMatchObject({ action: 'firewall-candidate-cleanup', args: { dryRun: true }, by: 'wizard agent_x' })
      await rm(join(root, 'queue', 'requests', name))
      setTimeout(() => { void writeFile(join(root, 'queue', 'results', name), JSON.stringify({ id: request.id, ok: true, exitCode: 0, output: 'Dry run: 2 rule(s) would be removed.' })) }, 30)
    })
    const helper = new AdminHelper({ root, startTask, platform: 'win32', taskInstalled: async () => true, pollMs: 10 })
    const outcome = await helper.run({ action: 'firewall-candidate-cleanup', args: { dryRun: true }, by: 'wizard agent_x' })
    expect(outcome).toMatchObject({ pending: false, result: { ok: true, output: 'Dry run: 2 rule(s) would be removed.' } })
    expect(startTask).toHaveBeenCalledTimes(1)
    const status = await helper.status()
    expect(status).toMatchObject({ installed: true, version: { commit: 'abc1234' }, recent: [{ id: outcome.id, ok: true }] })
    expect(Object.keys(status.actions)).toEqual(['firewall-candidate-cleanup'])
    expect(await helper.result(outcome.id)).toMatchObject({ ok: true })
    await expect(helper.result('../../secret')).rejects.toThrow(AdminRequestError)
  })

  it('answers pending when the task has not finished within the wait, and withdraws the request when the task cannot start', async () => {
    const root = await tempRoot()
    await installed(root)
    let clock = 0
    const pending = new AdminHelper({ root, startTask: async () => {}, platform: 'win32', now: () => clock, sleep: async ms => { clock += ms }, pollMs: 1000 })
    const outcome = await pending.run({ action: 'firewall-candidate-cleanup', by: 'owner', waitMs: 3000 })
    expect(outcome).toMatchObject({ pending: true, request: { action: 'firewall-candidate-cleanup', args: {}, by: 'owner' } })
    expect(await readdir(join(root, 'queue', 'requests'))).toEqual([`${outcome.id}.json`])
    await rm(join(root, 'queue', 'requests', `${outcome.id}.json`))

    const failing = new AdminHelper({ root, startTask: async () => { throw new Error('access denied') }, platform: 'win32' })
    await expect(failing.run({ action: 'firewall-candidate-cleanup', by: 'owner' })).rejects.toThrow(/access denied.*nothing ran/)
    expect(await readdir(join(root, 'queue', 'requests'))).toEqual([])
  })
})

// The real runner and action scripts, run without elevation in a temp folder that stands in for
// C:\ProgramData\ConductorAdmin. Nothing here touches the firewall.
describe.runIf(process.platform === 'win32')('elevated runner script (run unelevated)', () => {
  const powershell = (...args: string[]) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: 60_000 })

  it('runs only allowlisted actions with declared switches, and refuses everything else', async () => {
    const root = await tempRoot()
    await installed(root)
    await mkdir(join(root, 'actions'))
    await mkdir(join(root, 'logs'))
    await copyFile(join(helperDir, 'runner.ps1'), join(root, 'runner.ps1'))
    await writeFile(join(root, 'actions.json'), JSON.stringify({ actions: { 'echo-test': { script: 'echo.ps1', summary: 'test', args: { loud: { type: 'boolean', switch: 'Loud', summary: 'test' } } } } }))
    await writeFile(join(root, 'actions', 'echo.ps1'), 'param([switch]$Loud, [string]$Extra)\nWrite-Output "echo loud=$Loud extra=$Extra"\n')
    await writeFile(join(root, 'actions', 'evil.ps1'), 'Write-Output "evil ran"\n')
    const request = (id: string, body: Record<string, unknown>) => writeFile(join(root, 'queue', 'requests', `${id}.json`), JSON.stringify({ id, by: 'test', ...body }))
    await request('test-ok-000001', { action: 'echo-test', args: { loud: true } })
    await request('test-quiet-0001', { action: 'echo-test', args: { loud: false } })
    await request('test-unknown-01', { action: 'evil', args: {} })
    await request('test-extra-0001', { action: 'echo-test', args: { extra: 'x; Remove-Item C:\\' } })
    await request('test-type-00001', { action: 'echo-test', args: { loud: 'true' } })
    await request('test-script-001', { action: 'echo-test', script: 'evil.ps1', args: {} })
    await writeFile(join(root, 'queue', 'requests', 'test-mismatch1.json'), JSON.stringify({ id: 'someone-else-1', action: 'echo-test' }))
    await writeFile(join(root, 'queue', 'requests', 'BAD NAME.json'), JSON.stringify({ id: 'BAD NAME', action: 'echo-test' }))
    await writeFile(join(root, 'queue', 'requests', 'test-broken-001.json'), '{not json')
    await powershell('-File', join(root, 'runner.ps1'))

    expect(await readdir(join(root, 'queue', 'requests'))).toEqual([])
    const result = async (id: string) => parseAdminResult(await readFile(join(root, 'queue', 'results', `${id}.json`), 'utf8'), id)
    expect(await result('test-ok-000001')).toMatchObject({ ok: true, exitCode: 0, action: 'echo-test', output: 'echo loud=True extra=' })
    expect(await readFile(join(root, 'logs', 'test-ok-000001.log'), 'utf8')).toMatch(/action echo-test requested by test[\s\S]*echo loud=True extra=/)
    expect(await result('test-quiet-0001')).toMatchObject({ ok: true, output: 'echo loud=False extra=' })
    expect(await result('test-unknown-01')).toMatchObject({ ok: false, error: "Action 'evil' is not on the admin helper's allowlist" })
    expect(await result('test-extra-0001')).toMatchObject({ ok: false, error: "Action 'echo-test' takes no argument 'extra'" })
    expect(await result('test-type-00001')).toMatchObject({ ok: false, error: 'loud must be true or false' })
    expect(await result('test-script-001')).toMatchObject({ ok: true, output: 'echo loud=False extra=' })
    expect(await result('test-mismatch1')).toMatchObject({ ok: false, error: 'The request id does not match its file name' })
    expect(await result('test-broken-001')).toMatchObject({ ok: false, error: 'The request is not valid JSON' })
    expect((await readdir(join(root, 'queue', 'results'))).sort()).not.toContain('BAD NAME.json')
    const logs = await Promise.all((await readdir(join(root, 'logs'))).map(name => readFile(join(root, 'logs', name), 'utf8')))
    expect(logs.join('\n')).not.toContain('evil ran')
  }, 90_000)

  it('firewall-candidate-cleanup matches only candidate and smoke-worktree electron.exe copies', async () => {
    const programs = [
      'C:\\claude\\conductor-candidates\\0ee12ae\\node_modules\\electron\\dist\\electron.exe',
      'C:\\Claude\\conductor\\.conductor-scratch\\smoke-wt\\node_modules\\electron\\dist\\electron.exe',
      'C:\\claude\\conductor\\node_modules\\electron\\dist\\electron.exe',
      'C:\\users\\stilj\\appdata\\local\\programs\\conductor-desktop\\conductor.exe',
      'C:\\claude\\conductor-candidates\\0ee12ae\\node_modules\\electron\\dist\\electron.exe.bak',
      'C:\\claude\\conductor-candidates\\..\\Windows\\electron.exe',
      'C:\\Program Files\\Other\\electron.exe',
      'System',
      'Any'
    ]
    const script = join(helperDir, 'actions', 'firewall-candidate-cleanup.ps1')
    const { stdout } = await powershell('-Command', `& '${script}' -Classify @(${programs.map(program => `'${program}'`).join(',')})`)
    expect(stdout.trim().split(/\r?\n/)).toEqual(programs.slice(0, 2))
  }, 60_000)
})
