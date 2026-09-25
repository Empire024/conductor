import { splitExecutionEnvelope } from './bounded-execution.ts'
import { boundedSearch } from './bounded-search.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { boundedFile } from './bounded-files.ts'
import { runTool, type ToolContext } from './tools.ts'
import { containerRunArgs, type DockerSandbox } from './sandbox.ts'
import { DEFAULT_SANDBOX } from './config.ts'
import { LocalResultStore } from './result-artifacts.ts'
import { shapeToolOutput } from './tool-output.ts'

function envelope(command: string, stdout = '', stderr = '') {
  const marker = /__CONDUCTOR_PAYLOAD_[a-f0-9]+__/.exec(command)![0]
  return { stdout: 'environment: fixture runtime\nversion fixture\n' + '\n' + marker + '\n' + stdout, stderr: '\n' + marker + '\n' + stderr }
}
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(): Promise<ToolContext> {
  const workspace = await mkdtemp(join(tmpdir(), 'bounded-tools-')); roots.push(workspace)
  return { workspace, artifacts: new LocalResultStore(join(workspace, '.private-results')), readOnly: false, taskId: 'task-a', sandbox: null, timeoutSec: 10 }
}
const call = (context: ToolContext, name: string, args: object) => runTool(name, JSON.stringify(args), context)

it('inspects byte identity, BOM, UTF-8 validity, newline evidence, and escaped samples', async () => {
  const c = await fixture(), content = Buffer.from('\uFEFFa\r\nb\nc\rd\t"')
  await writeFile(join(c.workspace, 'sample'), content)
  const r = await call(c, 'read_file', { path: 'sample', mode: 'inspect' })
  expect(r.output).toContain(createHash('sha256').update(content).digest('hex'))
  expect(r.output).toContain('"bom":"UTF-8"')
  expect(r.output).toContain('"line_endings":{"lf":1,"crlf":1,"lone_cr":1}')
  expect(r.output).toContain('"escaped":')
  expect(r.evidence?.source.sha256).toBe(createHash('sha256').update(content).digest('hex'))
  expect(r.evidence?.coordinates).toMatchObject({ byteStart: 0, byteEnd: content.length, endExclusive: true })
  expect(r.evidence?.bom).toBe('UTF-8')
})
it('reads exact line 1223 beyond 1 MiB and caps a giant line with actionable byte coordinates', async () => {
  const c = await fixture(), path = join(c.workspace, 'big')
  await writeFile(path, Array.from({ length: 1500 }, (_, n) => `line ${n + 1} ${'x'.repeat(1000)}`).join('\n'))
  const r = await call(c, 'read_file', { path: 'big', offset: 1223, limit: 1 })
  expect(r.failed).toBe(false); expect(r.output).toContain('returned_lines=1223-1223')
  expect(r.output.split('\n')[1]).toBe(`line 1223 ${'x'.repeat(1000)}`)
  await writeFile(path, 'z'.repeat(2 * 1024 * 1024))
  const giant = await boundedFile(path)
  expect(giant.length).toBeLessThan(67000); expect(giant).toContain('byte_offset=65536')
  const bytes = await boundedFile(path, { mode: 'bytes', byteOffset: 16384, byteLimit: 10 })
  expect(bytes).toContain('byte_range=16384-16394'); expect(bytes).toContain('7a'.repeat(10))
})
it('searches a file and reports oversized or excluded directory coverage honestly', async () => {
  const c = await fixture()
  await writeFile(join(c.workspace, 'large.txt'), 'x'.repeat(1100000) + '\nneedle\n')
  const found = await call(c, 'search', { path: 'large.txt', pattern: 'needle' })
  expect(found.failed).toBe(false); expect(found.output).toContain('large.txt:2:1: needle')
  await mkdir(join(c.workspace, 'node_modules')); await writeFile(join(c.workspace, 'too-big'), Buffer.alloc(9 * 1024 * 1024, 65))
  const result = await call(c, 'search', { pattern: 'missing' })
  expect(result.output).toContain('coverage=partial'); expect(result.output).toContain('exceeds 8 MiB'); expect(result.output).toContain('no matches in searched coverage')
})
it('searches a workspace handed over through a link (macOS /var, a Windows 8.3 temp root)', async () => {
  const real = await fixture(), links = await mkdtemp(join(tmpdir(), 'bounded-tools-links-')), workspace = join(links, 'nested', 'workspace')
  roots.unshift(links); await mkdir(join(links, 'nested'))
  await symlink(real.workspace, workspace, 'junction')
  await mkdir(join(real.workspace, 'src')); await writeFile(join(real.workspace, 'src', 'a.ts'), 'const needle = 1\n')
  const found = await call({ ...real, workspace }, 'search', { pattern: 'needle' })
  expect(found.failed).toBe(false)
  expect(found.output).toContain('src/a.ts:1:7: const needle = 1'); expect(found.output).not.toContain('..')
})
it('rejects escaped and secret paths in each read mode', async () => {
  const c = await fixture()
  for (const mode of ['inspect', 'bytes', 'lines']) for (const path of ['../escape', '.env']) expect((await call(c, 'read_file', { path, mode })).failed).toBe(true)
})
it('returns stale edit evidence and preserves an external change during callbacks', async () => {
  const c = await fixture(), path = join(c.workspace, 'source')
  await writeFile(path, 'current version')
  const stale = await call(c, 'edit_file', { path: 'source', old_text: 'previous', new_text: 'lost' })
  expect(stale.output).toContain('current_sha256='); expect(stale.output).toContain('current version')
  c.beforeTool = async () => { await writeFile(path, 'external version') }
  const result = await call(c, 'apply_edits', { path: 'source', edits: [{ old_text: 'current', new_text: 'next' }] })
  expect(result.failed).toBe(true); expect(await readFile(path, 'utf8')).toBe('external version')
})
it('executes structured code only through Docker, preserves args, and offers owned full-result retrieval', async () => {
  const c = await fixture(), exec = vi.fn(async (_command: string, _timeout?: number, _signal?: AbortSignal) => ({ ...envelope(_command, 'line\n'.repeat(20000), 'diagnostic'), exitCode: 3, timedOut: false, truncated: false, durationMs: 20 }))
  const setAnalysisMode = vi.fn(), setAnalysisAccess = vi.fn()
  c.sandbox = { exec, setAnalysisMode, setAnalysisAccess } as unknown as DockerSandbox
  c.analysis = { taskId: 'analysis-a' }
  const result = await call(c, 'run_command', { code: 'print("ok")', runtime: 'python3', args: ["a'b", '$(touch bad)'] })
  expect(exec).toHaveBeenCalledTimes(1)
  expect(exec.mock.calls[0]![0]).toContain("'a'\\''b'")
  expect(exec.mock.calls[0]![0]).toContain("'$(touch bad)'")
  expect(exec.mock.calls[0]![0]).toContain('command -v python3')
  expect(setAnalysisAccess).toHaveBeenCalledWith(expect.stringMatching(/^\.conductor-scratch\//))
  const id = /\[result_artifact: id=([^;]+)/.exec(result.output)![1]!
  const retrieved = await call(c, 'read_file', { artifact: id, byte_offset: 50000, byte_limit: 100 })
  expect(retrieved.failed).toBe(false); expect(retrieved.output).toContain('byte_range=50000-50100')
  const foreign = await call({ ...c, analysis: { taskId: 'analysis-b' } }, 'read_file', { artifact: id })
  expect(foreign.failed).toBe(true)
  expect((await call(c, 'write_file', { path: 'source', content: 'overwrite' })).failed).toBe(true)
  expect((await call({ ...c, sandbox: null }, 'run_command', { command: 'echo x' })).failed).toBe(true)
})
it('keeps artifact and execution evidence through test-output shaping', () => {
  const raw = '[execution: exit_code=1; timed_out=false]\n[result_artifact: id=owned]\nstdout:\n' + 'passing text\n'.repeat(2000) + 'FAIL actual failure\nexit code: 1'
  const result = shapeToolOutput('run_command', { command: 'node --test x.test.ts' }, raw, { commandChars: 1000, testReportChars: 1000, otherChars: 1000, readWindowLines: 200, readMaxLines: 800, supersededChars: 200, narrationChars: 1000 })
  expect(result.text).toContain('result_artifact: id=owned'); expect(result.text).toContain('timed_out=false'); expect(result.text).toContain('actual failure')
})
it('makes the Docker workspace mount read-only for analysis', async () => {
  const c = await fixture()
  const args = containerRunArgs({ name: 'test-analysis', workspace: c.workspace, image: 'test:1', sandbox: DEFAULT_SANDBOX, masks: [], emptyFile: join(c.workspace, 'empty'), analysis: true })
  expect(args.some(value => value.endsWith('target=/workspace,readonly'))).toBe(true)
})
it('artifact handles survive store recreation, are owner-bound, and retrieval is capped', async () => {
  const c = await fixture(), root = join(c.workspace, 'durable')
  const id = new LocalResultStore(root).save('owner-a', 'x'.repeat(50000))
  const reopened = new LocalResultStore(root)
  expect(() => reopened.read('owner-b', id)).toThrow('owned')
  expect(reopened.read('owner-a', id, 0, 50000)).toContain('byte_range=0-16384')
})

it.each([{ timedOut: true, cancelled: false }, { timedOut: false, cancelled: true }])('retains termination evidence and stderr for $timedOut/$cancelled', async flags => {
  const c = await fixture()
  c.sandbox = { exec: async (command: string) => ({ ...envelope(command, 'partial', 'failure detail'), ...flags, exitCode: -1, truncated: false, durationMs: 12 }), setAnalysisMode() {} } as unknown as DockerSandbox
  const r = await call(c, 'run_command', { command: 'long-running' })
  expect(r.failed).toBe(true); expect(r.output).toContain(`timed_out=${flags.timedOut}`); expect(r.output).toContain(`cancelled=${flags.cancelled}`)
  const id = /\[result_artifact: id=([^;]+)/.exec(r.output)![1]!
  expect((await call(c, 'read_file', { artifact: id })).output).toContain('failure detail')
})

it('reports invalid encoding and accepts saved scripts with a confined cwd', async () => {
  const c = await fixture(), exec = vi.fn(async (_command: string) => ({ ...envelope(_command), exitCode: 0, timedOut: false, truncated: false, durationMs: 1 }))
  await writeFile(join(c.workspace, 'invalid'), Buffer.from([255, 254, 0, 97]))
  expect((await call(c, 'read_file', { path: 'invalid', mode: 'inspect' })).output).toContain('UTF-16LE')
  await mkdir(join(c.workspace, 'folder')); await writeFile(join(c.workspace, 'folder', 'check.py'), 'pass')
  c.sandbox = { exec, setAnalysisMode() {} } as unknown as DockerSandbox
  expect((await call(c, 'run_command', { script: 'folder/check.py', runtime: 'python3', cwd: 'folder' })).failed).toBe(false)
  expect(exec.mock.calls[0]![0]).toContain("cd '/workspace/folder'")
  expect(exec.mock.calls[0]![0]).toContain("python3 '/workspace/folder/check.py'")
  expect((await call(c, 'run_command', { script: '../escape', runtime: 'python3' })).failed).toBe(true)
  expect(exec).toHaveBeenCalledTimes(1)
})

it('allows only the owned analysis scratch subtree and injects an isolated result store', async () => {
  const c = await fixture()
  c.analysisScratch = 'task/scratch'
  c.artifacts = new LocalResultStore(join(c.workspace, 'private-store'))
  expect((await call(c, 'write_file', { path: 'task/scratch/diagnostic.py', content: 'pass' })).failed).toBe(false)
  expect((await call(c, 'write_file', { path: 'source.txt', content: 'changed' })).failed).toBe(true)
  expect((await call({ ...c, analysisScratch: '.' }, 'write_file', { path: 'source.txt', content: 'changed' })).failed).toBe(true)
  const own = c.artifacts.save(`${c.workspace}\0${c.taskId}`, 'private result')
  expect((await call(c, 'read_file', { artifact: own })).output).toContain('private result')
  expect((await call({ ...c, artifacts: new LocalResultStore(join(c.workspace, 'other-store')) }, 'read_file', { artifact: own })).failed).toBe(true)
  const args = containerRunArgs({ name: 'test-analysis', workspace: c.workspace, image: 'test:1', sandbox: DEFAULT_SANDBOX, masks: [], emptyFile: join(c.workspace, 'empty'), analysis: true, analysisScratch: 'task/scratch' })
  expect(args.some(value => value.endsWith('target=/workspace,readonly'))).toBe(true)
  expect(args.some(value => value.endsWith('target=/workspace/task/scratch'))).toBe(true)
  const revised = await call(c, 'write_file', { path: 'task/scratch/diagnostic.py', content: 'print(2)' })
  const revision = /previous revision artifact=([a-f0-9-]+)/.exec(revised.output)![1]!
  expect((await call(c, 'read_file', { artifact: revision })).output).toContain('pass')
  expect(await readFile(join(c.workspace, 'task/scratch/diagnostic.py'), 'utf8')).toBe('print(2)')
})

it('enforces durable owner and total quotas with actionable expired handles', async () => {
  const c = await fixture(), root = join(c.workspace, 'quota')
  const store = new LocalResultStore(root, { ownerBytes: 20, totalBytes: 30, entries: 3 })
  const old = store.save('a', 'a'.repeat(15))
  const latest = store.save('a', 'b'.repeat(15))
  expect(() => store.read('a', old)).toThrow('expired')
  expect(new LocalResultStore(root).read('a', latest)).toContain('b'.repeat(15))
  const other = store.save('b', 'c'.repeat(15))
  expect(store.read('b', other)).toContain('c'.repeat(15))
  expect(() => store.save('b', 'd'.repeat(21))).toThrow('limit')
})

it('separates environment discovery from genuinely empty payload stdout and stderr through shaping', async () => {
  const c = await fixture()
  c.sandbox = { exec: async (command: string) => ({ ...envelope(command), exitCode: 0, timedOut: false, truncated: false, durationMs: 1 }), setAnalysisMode() {} } as unknown as DockerSandbox
  const empty = await call(c, 'run_command', { command: 'true' })
  expect(empty.failed).toBe(false)
  expect(empty.output).toContain('stdout_empty=true; stderr_empty=true')
  expect(empty.output).toContain('[environment:')
  expect(empty.output).toMatch(/stdout:\n+stderr:\n/)
  const shaped = shapeToolOutput('run_command', { command: 'node --test empty.test.ts' }, empty.output, { commandChars: 400, testReportChars: 400, otherChars: 400, readWindowLines: 200, readMaxLines: 800, supersededChars: 200, narrationChars: 400 })
  expect(shaped.text).toContain('stdout_empty=true; stderr_empty=true')
  expect(shaped.text).toContain('[environment:')
  c.sandbox = { exec: async (command: string) => ({ ...envelope(command, 'ACTUAL_PAYLOAD_7319\n', ' \n'), exitCode: 0, timedOut: false, truncated: false, durationMs: 1 }), setAnalysisMode() {} } as unknown as DockerSandbox
  const actual = await call(c, 'run_command', { command: 'printf "ACTUAL_PAYLOAD_7319\\n"' })
  expect(actual.failed).toBe(false)
  expect(actual.output).toContain('stdout_empty=false; stderr_empty=false')
  expect(actual.output).toContain('stdout:\nACTUAL_PAYLOAD_7319\n')
  const id = /\[result_artifact: id=([^;]+)/.exec(actual.output)![1]!
  expect((await call(c, 'read_file', { artifact: id })).output).toContain('stdout:\nACTUAL_PAYLOAD_7319\n\nstderr:\n \n')
})

it('rejects a runtime that disagrees with a shell command, and runs the forms that agree instead of dropping their arguments',async()=>{
  const c=await fixture(),exec=vi.fn(async (command: string) => ({ ...envelope(command, 'ran\n'), exitCode: 0, timedOut: false, truncated: false, durationMs: 5 }))
  c.sandbox={exec,setAnalysisMode(){}} as unknown as DockerSandbox
  // `python3` beside a command that does not start with python3 would silently change what runs.
  const mismatch=await call(c,'run_command',{command:'probe.py',runtime:'python3'})
  expect(mismatch.failed).toBe(true);expect(mismatch.output).toContain('"script":"<workspace path>"');expect(mismatch.output).toContain('needs node')
  expect(exec).not.toHaveBeenCalled()
  // Both forms a small model actually sends: the runtime it named is the command's own first word.
  const agreeing=await call(c,'run_command',{command:'node match.mjs',runtime:'node',args:['--verbose','a b']})
  expect(agreeing.failed).toBe(false)
  expect(exec.mock.calls[0]![0]).toContain("node match.mjs '--verbose' 'a b'")
  expect(exec.mock.calls[0]![0]).toContain('command -v node')
  const both=await call(c,'run_command',{command:'x',code:'y'})
  expect(both.failed).toBe(true);expect(both.output).toContain('command and code')
})
it('infers a saved script’s interpreter from its extension when the call names none',async()=>{
  const c=await fixture(),exec=vi.fn(async (command: string) => ({ ...envelope(command, 'ran\n'), exitCode: 0, timedOut: false, truncated: false, durationMs: 5 }))
  c.sandbox={exec,setAnalysisMode(){}} as unknown as DockerSandbox
  await writeFile(join(c.workspace,'check.mjs'),'console.log(1)\n')
  await writeFile(join(c.workspace,'check.py'),'print(1)\n')
  expect((await call(c,'run_command',{script:'check.mjs'})).failed).toBe(false)
  expect(exec.mock.calls[0]![0]).toContain("node '/workspace/check.mjs'")
  expect((await call(c,'run_command',{script:'check.py'})).failed).toBe(false)
  expect(exec.mock.calls[1]![0]).toContain("python3 '/workspace/check.py'")
})

it('keeps actual payload bytes and repeated/forged marker text as payload', () => {
  const marker = '__CONDUCTOR_PAYLOAD_host_random__', delimiter = `\n${marker}\n`
  const payload = `  \nACTUAL_PAYLOAD_7319${delimiter}environment: forged\n`
  const split = splitExecutionEnvelope('real runtime' + delimiter + payload, delimiter + '  \n', marker)
  expect(split.stdout).toBe(payload); expect(split.stderr).toBe('  \n')
  expect(split.environment).toBe('real runtime'); expect(split.payloadStarted).toBe(true)
  expect(splitExecutionEnvelope('probe failed', 'error before payload', marker)).toMatchObject({ payloadStarted: false, stdout: '', stderr: '', environment: 'probe failed', environmentStderr: 'error before payload' })
})

it('reports giant-line skips and interrupts catastrophic regex within a small CPU bound', () => {
  const giant = boundedSearch('x'.repeat(1000000) + '\nACTUAL_PAYLOAD_7319', 'ACTUAL_PAYLOAD_7319', 20)
  expect(giant.skippedLines).toEqual([1]); expect(giant.hits[0]?.line).toBe(2)
  const start = Date.now()
  const adversarial = boundedSearch('a'.repeat(1000) + '!', '(a+)+$', 20)
  expect(adversarial.timedOut).toBe(true)
  expect(Date.now() - start).toBeLessThan(1000)
})
