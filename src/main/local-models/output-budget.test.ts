import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentSession } from './agent.ts'
import { chunkCharsFor, outputBudgetLoopStop, salvageTruncatedArguments, truncatedCallResult } from './output-budget.ts'
import { phaseFor } from '../providers/local.ts'
import { localStopLabels } from '../../shared/local-stop.ts'

/** A fake llama.cpp endpoint: replays one scripted SSE reply per request and records the requests. */
function fakeModel(scripts: string[][]): Promise<{ endpoint: string; server: Server; requests: Array<{ messages: Array<{ role: string; content: string }> }> }> {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const frame of scripts[Math.min(requests.length - 1, scripts.length - 1)] ?? []) response.write(`data: ${frame}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve({ endpoint: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, server, requests })
  }))
}
const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })
const call = (id: string, name: string, args: string, finish: string): string[] => [frame({ tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish)]
// A report the size of the G5 incident: ~10k characters in one write_file, cut before the JSON closes.
const report = '# Conductor Repository Inventory\n\n' + Array.from({ length: 200 }, (_, index) => `- item ${index}: "src/main/file-${index}.ts" \\ ok`).join('\n')
const cut = (text: string, at: number): string => `{"path":"docs/report.md","content":${JSON.stringify(text).slice(0, at)}`

describe('output-budget helpers', () => {
  it('sizes a chunk from the output limit, inside sane bounds', () => {
    expect(chunkCharsFor(2560)).toBe(3000)
    expect(chunkCharsFor(256)).toBe(800)
    expect(chunkCharsFor(32768)).toBe(6000)
  })
  it('tells the model the size that fits and that a second cut ends the turn', () => {
    const text = truncatedCallResult('write_file', 'x'.repeat(9876), 2560)
    expect(text).toMatch(/cut off at the local output limit of 2560 tokens after 9876 characters.*append: true.*under about 3000 characters.*ends the turn instead of retrying/)
  })
  it('salvages the path and the decoded content of arguments cut anywhere', () => {
    const full = JSON.stringify({ path: 'docs/a.md', content: 'line "one"\n\\ two é' })
    for (let at = full.indexOf('content') + 11; at < full.length - 2; at++) {
      const salvage = salvageTruncatedArguments(full.slice(0, at))
      expect(salvage.path).toBe('docs/a.md')
      expect('line "one"\n\\ two é'.startsWith(salvage.content!), full.slice(0, at)).toBe(true)
    }
    expect(salvageTruncatedArguments('{"pa')).toEqual({})
  })
  it('stops with a durable partial result: written files, the failure, the salvage and how to continue', () => {
    const stop = outputBudgetLoopStop({ name: 'write_file', limitTokens: 2560, cutChars: [9800, 9700], raw: cut(report, 400), written: [{ path: 'docs/intro.md', bytes: 120 }] })
    expect(stop.detail).toMatch(/^Output-budget loop: 2 write_file calls .* 2560-token output limit \(9800 and 9700 characters\)/)
    expect(stop.partial).toContain('- docs/intro.md (120 bytes)')
    expect(stop.partial).toContain('# Conductor Repository Inventory')
    expect(stop.partial).toContain('NOT written to disk')
    expect(stop.partial).toMatch(/To continue: write_file for docs\/report\.md with the first part only.*append: true.*under 3000 characters/)
  })
  it('is a failed stop with its own label, never read as a completed turn', () => {
    expect(localStopLabels.output_budget_loop).toMatch(/output limit twice/)
    expect(phaseFor({ stopReason: 'output_budget_loop', text: 'Partial result.' })).toBe('failed')
  })
})

describe('local agent output-budget loop', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })
  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-output-budget-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    return root
  }
  const session = (endpoint: string, root: string): LocalAgentSession => new LocalAgentSession({ endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: root, sandbox: null, readOnly: false, timeoutSec: 30, contextTokens: 32768 })

  it('repairs a cut write_file once, then stops on the second cut instead of retrying', async () => {
    // The G5 reproduction: the model repeats the oversized write after the chunking instruction.
    // Script a third reply that would succeed, to prove the runtime never asks for it.
    const model = await fakeModel([
      call('call_1', 'write_file', cut(report, 9800), 'length'),
      call('call_2', 'write_file', cut(report, 9700), 'length'),
      call('call_3', 'write_file', '{"path":"docs/report.md","content":"never"}', 'tool_calls')
    ])
    cleanup.push(() => model.server.close())
    const root = workspace(), notices: string[] = [], tools: string[] = []
    const outcome = await session(model.endpoint, root).run('Write the inventory report to docs/report.md', { notice: message => notices.push(message), toolEnd: event => tools.push(`${event.name}:${event.failed ? 'failed' : 'ok'}`) })

    expect(model.requests).toHaveLength(2)
    expect(tools).toEqual(['write_file:failed', 'write_file:failed'])
    // The one repair: the model was given a concrete size and told a second cut ends the turn.
    expect(model.requests[1]!.messages.at(-1)!.content).toMatch(/cut off at the local output limit of 2560 tokens.*append: true.*under about 3000 characters.*ends the turn/)
    expect(outcome.stopReason).toBe('output_budget_loop')
    expect(outcome.report.reason).toBe('output_budget_loop')
    expect(outcome.report.detail).toMatch(/Output-budget loop: 2 write_file calls/)
    expect(outcome.text).toContain('Written so far:\n- nothing')
    expect(outcome.text).toContain('# Conductor Repository Inventory')
    expect(outcome.text).toMatch(/To continue: write_file for docs\/report\.md with the first part only/)
    expect(notices.at(-1)).toMatch(/^Stopped: Output-budget loop/)
    // No partial or corrupt file: nothing the cut calls carried reached the disk.
    expect(existsSync(join(root, 'docs', 'report.md'))).toBe(false)
  })

  it('names what was already written when the loop starts after a successful part', async () => {
    const model = await fakeModel([
      call('call_1', 'write_file', '{"path":"docs/report.md","content":"# Part one\\n"}', 'tool_calls'),
      call('call_2', 'write_file', cut(report, 9000).replace('"path":"docs/report.md",', '"path":"docs/report.md","append":true,'), 'length'),
      call('call_3', 'write_file', cut(report, 8000).replace('"path":"docs/report.md",', '"path":"docs/report.md","append":true,'), 'length'),
      call('call_4', 'write_file', '{"path":"docs/report.md","content":"never","append":true}', 'tool_calls')
    ])
    cleanup.push(() => model.server.close())
    const root = workspace()
    const outcome = await session(model.endpoint, root).run('Write the inventory report to docs/report.md', {})
    expect(model.requests).toHaveLength(3)
    expect(outcome.stopReason).toBe('output_budget_loop')
    expect(outcome.report.filesChanged).toEqual(['docs/report.md'])
    expect(outcome.text).toContain('- docs/report.md (11 bytes)')
    expect(readFileSync(join(root, 'docs', 'report.md'), 'utf8')).toBe('# Part one\n')
  })

  it('still completes when the model follows the one repair and writes in parts', async () => {
    const model = await fakeModel([
      call('call_1', 'write_file', cut(report, 9800), 'length'),
      call('call_2', 'write_file', '{"path":"docs/report.md","content":"part 1\\n"}', 'tool_calls'),
      call('call_3', 'write_file', '{"path":"docs/report.md","content":"part 2\\n","append":true}', 'tool_calls'),
      [frame({ content: 'Report written in two parts.' }, 'stop')]
    ])
    cleanup.push(() => model.server.close())
    const root = workspace()
    const outcome = await session(model.endpoint, root).run('Write the inventory report to docs/report.md', {})
    expect(outcome).toMatchObject({ stopReason: 'completed', text: 'Report written in two parts.' })
    expect(readFileSync(join(root, 'docs', 'report.md'), 'utf8')).toBe('part 1\npart 2\n')
  })
})
