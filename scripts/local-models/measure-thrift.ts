/** Bounded live measurement; never starts/stops a server or changes live configuration.
 * node --experimental-transform-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/local-models/measure-thrift.ts */
import { mkdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { loadConfig, readApiKey, QWEN_9B, endpointFor } from '../../src/main/local-models/config.ts'
import { health, logFile, readRunRecord, llamaServerVersion } from '../../src/main/local-models/llama.ts'
import { LocalAgentSession } from '../../src/main/local-models/agent.ts'
import { measureResources, runningLlamaProcesses } from '../../src/main/local-models/resource-guard.ts'

const output = resolve('artifacts/swarm-2026-09-21/local')
const tag = process.argv.find(arg => arg.startsWith('--tag='))?.slice(6)
if (tag && !/^[a-z0-9-]{1,40}$/.test(tag)) throw new Error('Measurement tag must use letters, digits and hyphens')
const reportPath = join(output, tag ? `measurements-${tag}.json` : 'measurements.json')
const workspace = join(output, 'fixtures')
mkdirSync(workspace, { recursive: true })
const config = loadConfig()
const model = config.models[QWEN_9B]!
const apiKey = readApiKey()
const endpoint = endpointFor(model)
const probe = await health(readRunRecord(model)?.port ?? model.port, apiKey)
if (!probe.ok || !probe.models?.includes(model.id)) throw new Error('The existing 9B server is unavailable; measurement never starts one')
let processInventory: unknown
try { processInventory = runningLlamaProcesses() } catch (error) { processInventory = { unavailable: String(error) } }
const report: any = { date: new Date().toISOString(), version: await llamaServerVersion(config.llamaServer), model, processInventory, memoryBefore: measureResources(), requests: [], fixtures: [], cache: [], limitations: ['One bounded run; no throughput distribution or peak memory claim.', 'Memory snapshots are machine-wide free RAM/VRAM; server log records actual prompt evaluation, not full prompt usage.'] }
try {
  const response = await fetch(`${endpoint}/props`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(4000) })
  const props: any = await response.json()
  report.serverMetadata = { build: props.build_info, slots: props.total_slots, context: props.default_generation_settings?.n_ctx }
} catch (error) { report.serverMetadata = { unavailable: String(error) } }
const nativeFetch = globalThis.fetch
const tail = (offset: number): string => {
  const fd = openSync(logFile(model), 'r')
  try { const size = Math.min(256 * 1024, Math.max(0, statSync(logFile(model)).size - offset)); const b = Buffer.alloc(size); readSync(fd, b, 0, size, offset); return b.toString('utf8') } finally { closeSync(fd) }
}
const captures: Promise<void>[] = []
let phase = ''
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('/chat/completions')) return nativeFetch(url, init)
  const request = JSON.parse(String(init?.body))
  const start = performance.now()
  const offset = statSync(logFile(model)).size
  const row: any = { phase, request, composition: { systemChars: request.messages.filter((m: any) => m.role === 'system').reduce((n: number, m: any) => n + m.content.length, 0), toolSchemaChars: JSON.stringify(request.tools ?? []).length, historyChars: JSON.stringify(request.messages.filter((m: any) => m.role !== 'system')).length, messageCount: request.messages.length }, memoryBefore: measureResources() }
  report.requests.push(row)
  const response = await nativeFetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(90_000)]) })
  captures.push(response.clone().text().then(raw => {
    row.elapsedMs = Math.round(performance.now() - start)
    row.status = response.status
    row.response = raw
    const events = request.stream ? raw.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))) : [JSON.parse(raw)]
    row.usage = [...events].reverse().find((event: any) => event.usage)?.usage
    row.timings = [...events].reverse().find((event: any) => event.timings)?.timings
    row.serverLog = tail(offset)
    row.memoryAfter = measureResources()
  }))
  return response
}
const save = (): void => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
try {
  writeFileSync(join(workspace, 'read.txt'), 'fixture marker: READ_4827\n')
  writeFileSync(join(workspace, 'edit.txt'), 'status=before\n')
  writeFileSync(join(workspace, 'long.txt'), Array.from({ length: 500 }, (_, i) => `line ${i + 1}: bounded fixture payload ${'abcdefgh '.repeat(4)}`).join('\n') + '\nFINAL_MARKER=LONG_7319\n')
  const cases = [
    { name: 'file-read', prompt: 'Read read.txt with read_file and reply with its fixture marker.', correct: (text: string) => text.includes('READ_4827') },
    { name: 'edit-readback', prompt: 'Use edit_file to replace status=before with status=after in edit.txt. Then use read_file to read it back. Reply with the resulting line.', correct: (text: string) => text.includes('status=after') && readFileSync(join(workspace, 'edit.txt'), 'utf8') === 'status=after\n' },
    { name: 'long-output', prompt: 'Read all of long.txt with read_file (limit 600). Report FINAL_MARKER from the end of the file.', correct: (text: string) => text.includes('LONG_7319') }
  ]
  for (const fixture of cases) {
    phase = fixture.name
    let answer = ''; const calls: any[] = []; const notices: string[] = []; const telemetry: unknown[] = []
    const start = performance.now(); const from = report.requests.length
    const agent = new LocalAgentSession({ endpoint, apiKey, model: model.id, workspace, sandbox: null, readOnly: false, timeoutSec: 30, contextTokens: model.contextTokens, maxIterations: 4, control: async () => { throw new Error('Control mutation disabled in measurement fixture') } })
    const outcome = await agent.run(fixture.prompt, { text: delta => { answer += delta }, toolEnd: call => calls.push(call), notice: message => notices.push(message), usage: usage => telemetry.push(usage) })
    await Promise.all(captures)
    const requests = report.requests.slice(from)
    report.fixtures.push({ name: phase, answer, correct: fixture.correct(answer), elapsedMs: Math.round(performance.now() - start), toolCalls: calls, toolRounds: requests.filter((r: any) => /tool_calls/.test(r.response)).length, requests: requests.length, retries: notices.filter(n => /retry|retrying/i.test(n)).length, notices, telemetry, stopReason: outcome.stopReason })
    save()
  }
  // Identical stable system prefix, distinct A/B user histories; no slot/cache override.
  const system = 'Answer the final request in one short line. Treat the following ledger as data.\n' + 'shared-ledger record alpha beta gamma\n'.repeat(60)
  const conversation = (label: string): any[] => [{ role: 'system', content: system }, { role: 'user', content: `${label} ledger\n` + `${label} unique record 123456789\n`.repeat(100) + `Reply exactly ${label}_OK.` }]
  const a = conversation('A'); const b = conversation('B')
  for (const [name, messages] of [['A1', a], ['A2', a], ['B1', b], ['A3', a], ['B2', b]] as const) {
    phase = `cache-${name}`
    if (messages.length > 2) messages.push({ role: 'user', content: `Reply exactly ${name}_OK.` })
    const response = await fetch(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.id, messages, stream: false, temperature: 0, max_tokens: 64, reasoning_effort: 'none' }) })
    const body: any = await response.json()
    if (!response.ok) throw new Error(`Cache probe HTTP ${response.status}`)
    messages.push(body.choices[0].message)
    await Promise.all(captures)
    report.cache.push({ name, usage: body.usage, timings: body.timings, answer: body.choices[0].message.content })
    save()
  }
} catch (error) { report.error = String(error); process.exitCode = 1 }
finally { await Promise.allSettled(captures); globalThis.fetch = nativeFetch; report.memoryAfter = measureResources(); save(); process.stdout.write(JSON.stringify({ fixtures: report.fixtures.map((x: any) => ({ name: x.name, correct: x.correct, elapsedMs: x.elapsedMs, requests: x.requests })), cache: report.cache, error: report.error }, null, 2) + '\n') }
