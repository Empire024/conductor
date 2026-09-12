/** Real llama.cpp + Docker probe. No Electron, provider CLI, or synthetic model. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig, readApiKey, endpointFor } from '../../src/main/local-models/config.ts'
import { DockerSandbox } from '../../src/main/local-models/sandbox.ts'
import { LocalAgentSession } from '../../src/main/local-models/agent.ts'
import { readPublicWeb } from '../../src/main/local-models/web.ts'

const root = await mkdtemp(join(tmpdir(), 'conductor-local-fixer-probe-'))
const config = loadConfig()
const checks: Array<{ check: string; milliseconds?: number; tools?: string[] }> = []
const output = resolve('artifacts/local-harness-fixer')
await mkdir(output, { recursive: true })
const sandbox = new DockerSandbox('fixer-probe-' + Date.now(), root, config.sandbox)
try {
  await writeFile(join(root, 'input.txt'), 'LOCAL_INPUT_42')
  await writeFile(join(root, '.env'), 'PRIVATE_FIXTURE_DO_NOT_EXPOSE')
  const secret = await sandbox.exec('cat .env', 10)
  assert.ok(!secret.stdout.includes('PRIVATE_FIXTURE_DO_NOT_EXPOSE'))
  checks.push({ check: 'Real Docker masks workspace .env' })
  await mkdir(join(root, 'a/b/c/d'), { recursive: true })
  await writeFile(join(root, 'a/b/c/d/.env'), 'DEEP_PRIVATE_FIXTURE')
  await writeFile(join(root, '.env.late'), 'LATE_PRIVATE_FIXTURE')
  const refreshed = await sandbox.exec('cat a/b/c/d/.env .env.late', 10)
  assert.ok(!refreshed.stdout.includes('PRIVATE_FIXTURE'))
  checks.push({ check: 'Real Docker refreshes masks for deep and newly created workspace secrets' })
  const controller = new AbortController()
  const start = Date.now()
  const command = sandbox.exec('sleep 3; printf LATE_WRITE > cancelled.txt', 30, controller.signal)
  const timer = setTimeout(() => controller.abort(), 400)
  await assert.rejects(command, /abort/i)
  clearTimeout(timer)
  assert.ok(Date.now() - start < 3000, 'Cancellation did not terminate the command promptly')
  await new Promise(done => setTimeout(done, 3200))
  await assert.rejects(access(join(root, 'cancelled.txt')))
  checks.push({ check: 'Cancellation removes real Docker container and prevents delayed workspace writes', milliseconds: Date.now() - start })
  assert.equal((await sandbox.exec('printf RESTARTED', 10)).stdout, 'RESTARTED')
  checks.push({ check: 'Sandbox recreates safely after cancellation' })
  const limited = new DockerSandbox('fixer-overflow-' + Date.now(), root, { ...config.sandbox, maxOutputBytes: 1024 })
  try {
    const result = await limited.exec('(sleep 2; printf AFTER_LIMIT > overflow-late.txt) & head -c 262144 /dev/zero; wait', 10)
    assert.equal(result.truncated, true)
    assert.notEqual(result.exitCode, 0)
    assert.ok(Buffer.byteLength(result.stdout) <= 1024)
    await new Promise(done => setTimeout(done, 2300))
    await assert.rejects(access(join(root, 'overflow-late.txt')))
    checks.push({ check: 'Output overflow is reported and removes real container before delayed child can write' })
  } finally { await limited.stop() }
  assert.match(await readPublicWeb('https://example.com'), /Example Domain/)
  for (const url of ['https://127.0.0.1', 'https://169.254.169.254', 'https://localhost.', 'https://user:pass@example.com']) await assert.rejects(readPublicWeb(url))
  checks.push({ check: 'Real public HTTPS response works; local, metadata and credentialed URLs rejected' })
  for (const model of Object.values(config.models)) {
    const file = model.id.includes('9b') ? 'nine' : 'big'
    const tools: string[] = []
    const started = Date.now()
    const session = new LocalAgentSession({ endpoint: endpointFor(model), apiKey: readApiKey(), model: model.id, workspace: root, sandbox, readOnly: false, timeoutSec: 15, contextTokens: model.contextTokens, maxIterations: 8 })
    const result = await session.run(`Read input.txt using read_file. Then call write_file to create results/${file}/answer.txt containing exactly LOCAL_INPUT_42. Read it back and finish. Use only these tools.`, { toolEnd: call => { tools.push(call.name + ':' + (call.failed ? 'failed' : 'ok')); process.stdout.write(model.id + ' ' + tools.at(-1) + '\n') } }, AbortSignal.timeout(120_000))
    assert.equal(result.stopReason, 'complete')
    assert.equal((await readFile(join(root, 'results', file, 'answer.txt'), 'utf8')).trim(), 'LOCAL_INPUT_42')
    assert.ok(tools.includes('write_file:ok'))
    checks.push({ check: model.id + ' completed real bounded workspace task', milliseconds: Date.now() - started, tools })
  }
} finally {
  await sandbox.stop()
  await writeFile(join(output, 'runtime-probe.json'), JSON.stringify({ root, actualModels: true, actualDocker: true, checks }, null, 2))
}
console.log(JSON.stringify(checks, null, 2))
