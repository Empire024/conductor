// VR4 A4/A5 (docs/verification/2026-09-25-vr4.md), local-models-save-tokens. Serves conductor-local from
// the source tree this file sits in (copy it into a worktree of the commit under test) against the
// owner's already-running local server, never starting one, and calls it over JSON-RPC the way an
// MCP client does. A4 runs VR3's own a4-raw.mjs unchanged; A5 checks what Claude Code hands the model:
// structuredContent, which must carry the answer text.
//   npx vite-node scripts/smoke-verify-vr4-assist.mts -- --only a4|a5 [--repeat n] [--label X]
// cwd for the tools is C:/Claude/conductor (VR3's fixture paths are relative to it).
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { LocalAssistMcpServer } from '../src/main/local-assist/mcp-server.ts'
import { createLocalModelRunner, realRunnerPorts } from '../src/main/local-assist/model-runner.ts'
import { LocalAssistTools } from '../src/main/local-assist/tools.ts'

const argv = process.argv.slice(2)
const option = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
const only = option('--only') ?? 'a5'
const label = option('--label') ?? only.toUpperCase()
const OUT = 'C:/Claude/conductor/artifacts/verification/2026-09-25-vr4'
const REPO = 'C:/Claude/conductor'
mkdirSync(OUT, { recursive: true })
const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const record = (id: string, verdict: string, numbers: object, evidence: string): void => {
  const line = `- ${new Date().toISOString()} **${id}** ${verdict} ${JSON.stringify(numbers)} - source ${head}; ${evidence.replace(/\r?\n/g, ' ')}\n`
  appendFileSync(`${OUT}/results.md`, line)
  console.log(line.trim())
}
const guard = setTimeout(() => { record(`${label} watchdog`, 'HUNG', { seconds: 900 }, 'host exceeded 15 min'); process.exit(2) }, 15 * 60_000)

const ports = await realRunnerPorts()
const runner = createLocalModelRunner({ ...ports, start: async () => { throw new Error('VR4 host never starts a model server') } })
const tools = new LocalAssistTools({
  session: (id: string) => ({ projectId: 'vr4', sessionId: 'vr4', agentSessionId: id, provider: 'claude', cwd: REPO, permission: 'auto', plan: false }),
  runner,
  ledger: { record: () => {}, summary: () => { throw new Error('unused') } }
} as never)
const server = new LocalAssistMcpServer(tools, false)
await server.start()
const config = server.configure({ id: 'vr4-host', projectId: 'vr4', sessionId: 'vr4', provider: 'claude' } as never)
const servers = ports.servers().map(entry => ({ model: entry.model, port: entry.port, pid: entry.pid }))

if (only === 'a4') {
  const args = JSON.stringify({ prompt: 'values on the NEEDLE-ALPHA and NEEDLE-OMEGA lines', files: ['.conductor-scratch/vr3/s7-1mb.log'] })
  for (let run = 1; run <= Number(option('--repeat') ?? 1); run++) {
    const started = Date.now()
    // Async: the MCP server answers from this same process, so a blocking spawn would deadlock it.
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
      const child = spawn(process.execPath, [`${REPO}/.conductor-scratch/vr3/a4-raw.mjs`, config, 'local_ask', args], { cwd: REPO, windowsHide: true })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const timer = setTimeout(() => child.kill(), 12 * 60_000)
      child.on('close', status => { clearTimeout(timer); done({ status, stdout, stderr }) })
    })
    const ms = Date.now() - started
    let out: { ms?: number; status?: number; text?: string; structured?: { examined?: number; chunks?: number } } = {}
    try { out = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('}') + 1)) } catch { /* recorded below */ }
    const text = out.text ?? ''
    const alpha = /48213-KESTREL[^\n]*1147/.test(text), omega = /90517-HALCYON[^\n]*10309/.test(text)
    const refused = /exceed_context_size/.test(text)
    const pass = alpha && omega && !refused && (out.ms ?? ms) < 300_000
    record(`${label} run ${run}`, pass ? 'PASS' : 'FAIL', { ms: out.ms ?? ms, alpha, omega, refused, examined: out.structured?.examined, chunks: out.structured?.chunks, servers }, `a4-raw.mjs unchanged; text: ${text.slice(0, 600)}${result.status ? '; exit ' + result.status + ' ' + result.stderr.slice(0, 300) : ''}`)
  }
} else {
  const { mcpServers } = JSON.parse((await import('node:fs')).readFileSync(config, 'utf8'))
  const endpoint = mcpServers['conductor-local']
  const callTool = async (name: string, args: object): Promise<{ text: string; structured: Record<string, unknown> | undefined }> => {
    const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: endpoint.headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(300_000) })
    const body = await response.json()
    return { text: (body.result?.content ?? []).map((part: { text?: string }) => part.text ?? '').join('\n'), structured: body.result?.structuredContent }
  }
  const cases: Array<[string, object]> = [
    ['local_ask', { prompt: 'How much VRAM does this machine have?', files: ['docs/machine-profile.md'] }],
    ['summarize_file', { path: 'docs/machine-profile.md' }],
    ['run_and_summarize', { command: 'node -e "console.log(\'vr4-a5 line one\'); console.log(\'vr4-a5 line two\')"' }]
  ]
  for (const [name, args] of cases) {
    const started = Date.now()
    const { text, structured } = await callTool(name, args)
    const carried = typeof structured?.text === 'string' && structured.text.length > 0
    const same = carried && structured!.text === text
    const pass = Boolean(structured) && same
    record(`${label} ${name}`, pass ? 'PASS' : 'FAIL', { ms: Date.now() - started, structuredKeys: structured ? Object.keys(structured) : null, structuredTextChars: carried ? (structured!.text as string).length : 0, textChars: text.length, identical: same }, `text: ${text.slice(0, 240)}`)
  }
}
clearTimeout(guard)
server.close()
process.exit(0)
