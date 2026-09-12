import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool, toolSpecs } from './tools.ts'
import { publicAddress, researchUrl, readPublicWeb } from './web.ts'
import { lookup } from 'node:dns/promises'
import { detectSecretPaths, containerRunArgs } from './sandbox.ts'
import { DEFAULT_SANDBOX } from './config.ts'
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

describe('bounded local coworker tools', () => {
  const roots: string[] = []
  afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  const context = async () => { const workspace = await mkdtemp(join(tmpdir(), 'local-harness-')); roots.push(workspace); return { workspace, readOnly: false, sandbox: null, timeoutSec: 1 } }
  it('creates nested workspace files, while refusing a missing child under an escaping junction', async () => {
    const ctx = await context(); const outside = await context()
    expect((await runTool('write_file', JSON.stringify({ path: 'new/nested/note.md', content: 'verified' }), ctx)).failed).toBe(false)
    expect(await readFile(join(ctx.workspace, 'new/nested/note.md'), 'utf8')).toBe('verified')
    await symlink(outside.workspace, join(ctx.workspace, 'escape'), 'junction')
    expect((await runTool('write_file', JSON.stringify({ path: 'escape/new/note.md', content: 'escape' }), ctx)).output).toMatch(/denied/)
  })
  it('finds deep secrets and refuses incomplete scans or unrepresentable masks', async () => {
    const ctx = await context()
    await mkdir(join(ctx.workspace, 'a/b/c/d'), { recursive: true })
    await runTool('write_file', '{"path":"a/b/c/d/ordinary.txt","content":"safe"}', ctx)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(ctx.workspace, 'a/b/c/d/.env'), 'fixture')
    expect(detectSecretPaths(ctx.workspace)).toContainEqual({ relative: 'a/b/c/d/.env', directory: false })
    expect(() => detectSecretPaths(ctx.workspace, 1)).toThrow(/depth budget/)
    expect(() => detectSecretPaths(ctx.workspace, 64, 0)).toThrow(/mask budget/)
    expect(() => containerRunArgs({ name: 'test', image: DEFAULT_SANDBOX.image, workspace: ctx.workspace, sandbox: DEFAULT_SANDBOX, masks: [{ relative: 'bad,path/.env', directory: false }], emptyFile: join(ctx.workspace, 'empty') })).toThrow(/cannot be represented/)
  })
  it('withholds secret ancestors reached through a public alias while keeping safe templates readable', async () => {
    const ctx = await context(), { writeFile } = await import('node:fs/promises')
    await mkdir(join(ctx.workspace, 'secret-vault'))
    await writeFile(join(ctx.workspace, 'secret-vault/ordinary.txt'), 'PRIVATE_ALIAS_CANARY')
    await symlink(join(ctx.workspace, 'secret-vault'), join(ctx.workspace, 'public-alias'), 'junction')
    for (const path of ['secret-vault/ordinary.txt', 'public-alias/ordinary.txt']) {
      const outcome = await runTool('read_file', JSON.stringify({ path }), ctx)
      expect(outcome.failed).toBe(true); expect(outcome.output).not.toContain('PRIVATE_ALIAS_CANARY')
    }
    expect((await runTool('write_file', '{"path":"public-alias/new/ordinary.txt","content":"bad"}', ctx)).failed).toBe(true)
    await writeFile(join(ctx.workspace, '.env.example'), 'PUBLIC_TEMPLATE')
    expect((await runTool('read_file', '{"path":".env.example"}', ctx)).output).toBe('PUBLIC_TEMPLATE')
  })
  it('passes memory to a trusted callback with no caller-controlled scope', async () => {
    const control = vi.fn(async () => ({ id: 'durable-memory' })); const ctx = { ...await context(), control }
    expect((await runTool('conductor', JSON.stringify({ method: 'memory.remember', args: { gist: 'Project uses explicit tool boundaries', kind: 'semantic', cues: ['boundary'] } }), ctx)).output).toContain('durable-memory')
    expect(control).toHaveBeenCalledTimes(1)
    for (const [method, args, readOnly] of [
      ['memory.remember', { gist: 'x' }, true], ['memory.remember', { gist: 'x', projectId: 'foreign' }, false],
      ['router.dispatch', { tasks: [] }, false], ['files.read', { path: '../x' }, false], ['tasks.list', { projectId: 'foreign' }, false]
    ] as const) expect((await runTool('conductor', JSON.stringify({ method, args }), { ...ctx, readOnly })).failed).toBe(true)
    expect(control).toHaveBeenCalledTimes(1)
    expect(toolSpecs(false).some(tool => tool.function.name === 'conductor')).toBe(false)
    expect(toolSpecs(false, true).some(tool => tool.function.name === 'conductor')).toBe(true)
  })
  it('allows only bounded read-only agent discovery through the trusted conversation scope', async () => {
    const control = vi.fn(async (method: string) => method === 'agents.list' ? [{ agentSessionId: 'visible-agent' }] : { agentSessionId: 'visible-agent', phase: 'running' })
    const ctx = { ...await context(), readOnly: true, control }
    expect((await runTool('conductor', JSON.stringify({ method: 'agents.list', args: {} }), ctx)).output).toContain('visible-agent')
    expect((await runTool('conductor', JSON.stringify({ method: 'agents.snapshot', args: { agentSessionId: 'visible-agent' } }), ctx)).output).toContain('running')
    expect((await runTool('conductor', JSON.stringify({ method: 'agents.list', args: { projectId: 'foreign' } }), ctx)).failed).toBe(true)
    expect((await runTool('conductor', JSON.stringify({ method: 'agents.snapshot', args: { agentSessionId: 'visible-agent', mutate: true } }), ctx)).failed).toBe(true)
    expect(control).toHaveBeenCalledTimes(2)
  })
  it('propagates cancellation to command execution and refuses tools after cancellation', async () => {
    const controller = new AbortController(); const exec = vi.fn(async (_command, _timeout, signal: AbortSignal) => { expect(signal).toBe(controller.signal); controller.abort(); signal.throwIfAborted() })
    const ctx = { ...await context(), signal: controller.signal, sandbox: { exec } as never }
    expect((await runTool('run_command', '{"command":"sleep 100"}', ctx)).failed).toBe(true)
    expect((await runTool('write_file', '{"path":"after.txt","content":"bad"}', ctx)).failed).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
  })
  it('does not write after cancellation during the host artifact hook', async () => {
    const controller = new AbortController()
    const ctx = { ...await context(), signal: controller.signal, beforeTool: async () => { controller.abort() } }
    expect((await runTool('write_file', '{"path":"after-hook.txt","content":"bad"}', ctx)).failed).toBe(true)
    await expect(readFile(join(ctx.workspace, 'after-hook.txt'))).rejects.toThrow()
  })
  it('blocks private, metadata, mapped, encoded, credentialed and non-HTTPS research targets', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', '198.18.0.1']) expect(publicAddress(address), address).toBe(false)
    expect(publicAddress('93.184.216.34')).toBe(true)
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com:8080', 'https://127.1', 'https://0x7f000001', 'file:///etc/passwd', 'https://localhost']) expect(() => researchUrl(url), url).toThrow()
    vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never)
    await expect(readPublicWeb('https://public-looking.example')).rejects.toThrow(/DNS/)
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] as never)
    await expect(readPublicWeb('https://mixed.example')).rejects.toThrow(/DNS/)
  })
})
