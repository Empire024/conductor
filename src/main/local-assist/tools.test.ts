import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalModelOutcome, LocalModelRequest, SavingsRecord } from './contract'
import { capLines, failureLines, modelExcerpt, splitLines, stripAnsi } from './digest'
import { LocalAssistTools, hostCommandRunner, promptTerms, type CommandRunner, type LocalAssistSession } from './tools'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'local-assist-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const session = (overrides: Partial<LocalAssistSession> = {}): LocalAssistSession => ({ projectId: 'p1', sessionId: 's1', agentSessionId: 'a1', provider: 'claude', cwd: root, permission: 'auto', plan: false, ...overrides })

function harness(options: { outcome?: LocalModelOutcome; output?: string; exitCode?: number; session?: Partial<LocalAssistSession>; run?: CommandRunner; sleep?: (ms: number) => Promise<void> } = {}) {
  const asked: LocalModelRequest[] = []
  const records: SavingsRecord[] = []
  const runs: Parameters<CommandRunner>[0][] = []
  const run: CommandRunner = options.run ?? (async request => {
    runs.push(request)
    writeFileSync(request.logFile, options.output ?? '')
    return { exitCode: options.exitCode ?? 0, durationMs: 1234, timedOut: false, outputChars: (options.output ?? '').length }
  })
  const tools = new LocalAssistTools({
    session: id => id === 'a1' ? session(options.session) : undefined,
    runner: { contextTokens: async () => 32_768, promptTokens: async request => Math.ceil((request.system.length + request.user.length) / 4), ask: async request => { asked.push(request); return options.outcome ?? { ok: true, answer: { text: 'FAIL src/a.test.ts > adds\nsrc/a.ts:3 expected 2', model: 'local/qwen', inputTokens: 900, outputTokens: 30, durationMs: 50 } } } },
    ledger: { record: entry => records.push({ at: 'now', ...entry }), summary: () => { throw new Error('unused') } },
    run,
    now: () => new Date('2026-09-24T12:00:00Z'),
    ...(options.sleep ? { sleep: options.sleep } : {})
  })
  return { tools, asked, records, runs }
}

const longLog = (failures = 1): string => [...Array.from({ length: 400 }, (_, index) => `✓ passing test ${index}`), ...Array.from({ length: failures }, (_, index) => `FAIL src/a.test.ts > case ${index}\nAssertionError: expected 1 to be 2\n    at src/a.test.ts:${10 + index}:5`), ...Array.from({ length: 30 }, (_, index) => `tail line ${index}`)].join('\n')

describe('digest', () => {
  it('strips colour codes and keeps failure lines in order with context', () => {
    expect(stripAnsi('\u001b[31mFAIL\u001b[0m x')).toBe('FAIL x')
    const lines = splitLines('ok 1\nok 2\nFAIL thing\n  at src/x.ts:4:2\nok 3\n')
    expect(failureLines(lines, 10, 0)).toEqual(['FAIL thing', '  at src/x.ts:4:2'])
  })
  it('keeps the head, failures and tail of a log that does not fit', () => {
    const excerpt = modelExcerpt(splitLines(longLog(3)), 6000)
    expect(excerpt.length).toBeLessThanOrEqual(6100)
    expect(excerpt).toContain('FAIL src/a.test.ts > case 2')
    expect(excerpt).toContain('tail line 29')
    expect(excerpt).toContain('passing test 0')
  })
  it('caps an answer to maxLines', () => expect(capLines('a\nb\nc\nd', 2)).toBe('a\nb\n… (2 more lines cut)'))
})

describe('run_and_summarize', () => {
  it('runs in the project, logs under scratch, summarises and returns the raw tail', async () => {
    const h = harness({ output: longLog(), exitCode: 1 })
    const result = await h.tools.runAndSummarize('a1', { command: 'npx vitest run', question: 'which test?' })
    expect(h.runs[0]).toMatchObject({ command: 'npx vitest run', cwd: root })
    expect(h.runs[0]!.logFile.startsWith(join(root, '.conductor-scratch', 'local-assist'))).toBe(true)
    expect(result.text).toMatch(/^exit 1 · 1\.2 s · \d+ lines/)
    expect(result.text).toContain('full log: .conductor-scratch/local-assist/')
    expect(result.text).toContain('Summary (local/qwen, local):')
    expect(result.text).toContain('Last 15 lines (verbatim):\ntail line 15')
    expect(result.text).toContain('tail line 29')
    expect(h.asked[0]!.user).toContain('Question: which test?')
    expect(h.records[0]).toMatchObject({ tool: 'run_and_summarize', usedModel: true, localInputTokens: 900, localOutputTokens: 30, model: 'local/qwen' })
    expect(h.records[0]!.rawChars).toBeGreaterThan(h.records[0]!.returnedChars * 5)
    expect(result.structured).toMatchObject({ exitCode: 1, summarized: true })
  })

  it('falls back to pattern-matched failures and the tail when the model is unavailable', async () => {
    const h = harness({ output: longLog(), exitCode: 1, outcome: { ok: false, reason: 'the local model was busy for 20 s' } })
    const result = await h.tools.runAndSummarize('a1', { command: 'npm test', maxLines: 5 })
    expect(result.text).toContain('Local summary unavailable: the local model was busy for 20 s.')
    expect(result.text).toContain('FAIL src/a.test.ts > case 0')
    expect(result.text).toContain('tail line 29')
    expect(h.records[0]).toMatchObject({ usedModel: false, localInputTokens: 0 })
  })

  it('does not call the model for output that is already short', async () => {
    const h = harness({ output: 'ok\n' })
    const result = await h.tools.runAndSummarize('a1', { command: 'echo ok' })
    expect(h.asked).toHaveLength(0)
    expect(result.text).toContain('Last 1 lines (verbatim):\nok')
  })

  it('refuses outside Auto so it never widens a permission', async () => {
    for (const overrides of [{ permission: 'default' as const }, { permission: 'accept-edits' as const }, { permission: 'read-only' as const }, { plan: true }]) {
      const h = harness({ session: overrides })
      await expect(h.tools.runAndSummarize('a1', { command: 'echo hi' })).rejects.toThrow(/only available to a conversation in Auto/)
      expect(h.runs).toHaveLength(0)
    }
  })

  it('refuses a cwd outside the project and an unknown conversation', async () => {
    const h = harness()
    await expect(h.tools.runAndSummarize('a1', { command: 'dir', cwd: '..' })).rejects.toThrow(/outside/)
    await expect(h.tools.runAndSummarize('gone', { command: 'dir' })).rejects.toThrow(/no longer open/)
  })

  it('does not hold the caller past the default return bound when no timeoutSec was given', async () => {
    const h = harness({
      run: () => new Promise(() => { /* never settles within the test: simulates a long-running command */ }),
      sleep: () => Promise.resolve() // fast-forwards the ~120 s return bound instantly
    })
    const result = await h.tools.runAndSummarize('a1', { command: 'sleep 99999' })
    expect(result.structured).toMatchObject({ stillRunning: true })
    expect(result.text).toMatch(/still running/i)
    expect(result.text).toContain('.conductor-scratch/local-assist/')
  })

  it('honours an explicit timeoutSec in full instead of returning early', async () => {
    const h = harness({ output: 'ok\n', sleep: () => { throw new Error('the return-bound race must not be used when timeoutSec is explicit') } })
    const result = await h.tools.runAndSummarize('a1', { command: 'echo ok', timeoutSec: 5 })
    expect(result.structured).not.toMatchObject({ stillRunning: true })
  })

  it('sizes the excerpt from the server and retries a context refusal once at half the size', async () => {
    const output = Array.from({ length: 30_000 }, (_, index) => `FAIL src/case-${index}.test.ts > step ${index} (shard ${index % 32}): AssertionError: expected ${index} to equal ${index + 1} at src/case-${index}.test.ts:${index % 400}:7`).join('\n')
    const asked: LocalModelRequest[] = []
    const tools = new LocalAssistTools({
      session: () => session(),
      runner: {
        contextTokens: async () => 32_768,
        ask: async request => {
          asked.push(request)
          return asked.length === 1 ? { ok: false, reason: 'the request was longer than the local model\'s context', contextExceeded: true } : { ok: true, answer: { text: 'All steps passed.', model: 'local/qwen', inputTokens: 900, outputTokens: 5, durationMs: 5 } }
        }
      },
      ledger: { record: () => undefined, summary: () => { throw new Error('unused') } },
      run: async request => { writeFileSync(request.logFile, output); return { exitCode: 0, durationMs: 5, timedOut: false, outputChars: output.length } }
    })
    const result = await tools.runAndSummarize('a1', { command: 'npm test', timeoutSec: 60 })
    expect(asked).toHaveLength(2)
    // Unmeasured, at 1.5 characters a token: the first excerpt fits a 32k context, not 60,000 chars.
    expect(asked[0]!.user.length).toBeLessThan(32_768 * 1.5)
    expect(asked[1]!.user.length).toBeLessThan(asked[0]!.user.length * 0.6)
    expect(result.text).toContain('All steps passed.')
    expect(result.structured).toMatchObject({ summarized: true })
  })
})

describe('local_ask and summarize_file', () => {
  it('reads project files with line numbers and returns only the answer', async () => {
    writeFileSync(join(root, 'big.ts'), Array.from({ length: 2000 }, (_, index) => `const line${index} = ${index}`).join('\n'))
    const h = harness({ session: { permission: 'read-only' } })
    const result = await h.tools.ask('a1', { prompt: 'where is line1500 defined?', files: ['big.ts'] })
    expect(h.asked[0]!.user).toContain('=== big.ts')
    expect(h.asked[0]!.user).toContain('1501: const line1500 = 1500')
    expect(result.text).toContain('— local/qwen, local, over big.ts')
    expect(h.records[0]).toMatchObject({ tool: 'local_ask', usedModel: true })
    expect(h.records[0]!.rawChars).toBeGreaterThan(30_000)
  })

  it('refuses files outside the project and credential files', async () => {
    mkdirSync(join(root, 'inner'))
    writeFileSync(join(root, '.env'), 'SECRET=1')
    const h = harness()
    await expect(h.tools.ask('a1', { prompt: 'x', files: ['../outside.txt'] })).rejects.toThrow(/does not exist|outside/)
    await expect(h.tools.ask('a1', { prompt: 'x', files: ['.env'] })).rejects.toThrow(/credential/)
    await expect(h.tools.ask('a1', { prompt: 'x', files: ['inner'] })).rejects.toThrow(/not a file/)
    expect(h.asked).toHaveLength(0)
  })

  it('finds a needle deep past the old 512 KB head-only read instead of confidently saying it is absent (S7)', async () => {
    const FILLER = 'const filler = 0;'
    let content = ''
    while (content.length < 100_000) content += FILLER + '\n'
    content += 'const NEEDLE_100K = "here";\n'
    while (content.length < 900_000) content += FILLER + '\n'
    content += 'const NEEDLE_900K = "here";\n'
    while (content.length < 1_000_000) content += FILLER + '\n'
    writeFileSync(join(root, 'big.txt'), content)
    const asked: LocalModelRequest[] = []
    const tools = new LocalAssistTools({
      session: id => id === 'a1' ? session() : undefined,
      runner: {
        ask: async request => {
          asked.push(request)
          const found = request.user.includes('NEEDLE_900K')
          return { ok: true, answer: { text: found ? 'Found: const NEEDLE_900K = "here";' : 'NOT FOUND IN THIS EXCERPT', model: 'local/qwen', inputTokens: 500, outputTokens: 10, durationMs: 20 } }
        }
      },
      ledger: { record: () => undefined, summary: () => { throw new Error('unused') } }
    })
    const result = await tools.ask('a1', { prompt: 'Quote the line containing NEEDLE_900K.', files: ['big.txt'] })
    expect(asked.length).toBeGreaterThan(1) // more than one window: the fix is the chunking, not a bigger single read
    expect(result.text).toContain('NEEDLE_900K')
    expect(result.text.toLowerCase()).not.toMatch(/^not found/)
  })

  it('says a large file was only partly examined rather than implying the rest was checked', async () => {
    const lines = Array.from({ length: 20000 }, (_, index) => `const filler${index} = ${index};`)
    writeFileSync(join(root, 'big.txt'), lines.join('\n'))
    const tools = new LocalAssistTools({
      session: id => id === 'a1' ? session() : undefined,
      runner: { ask: async () => ({ ok: true, answer: { text: 'NOT FOUND IN THIS EXCERPT', model: 'local/qwen', inputTokens: 500, outputTokens: 10, durationMs: 20 } }) },
      ledger: { record: () => undefined, summary: () => { throw new Error('unused') } }
    })
    const result = await tools.ask('a1', { prompt: 'Is there a line saying ALL_DONE?', files: ['big.txt'] })
    expect(result.text.toLowerCase()).toContain('not found')
    expect(result.structured).toMatchObject({ answered: false })
  })

  it('summarize_file is local_ask over one file and records no saving when the model is unavailable', async () => {
    writeFileSync(join(root, 'a.md'), '# Title\n'.repeat(100))
    const h = harness({ outcome: { ok: false, reason: 'no local model is configured' } })
    const result = await h.tools.summarizeFile('a1', { path: 'a.md' })
    expect(result.text).toContain('Local model unavailable: no local model is configured.')
    expect(h.records[0]).toMatchObject({ tool: 'summarize_file', usedModel: false, rawChars: 0 })
  })

  /** The VR3 A4 fixture: ~1 MB of dense service-log lines with needles near 100 KB and 900 KB. */
  const denseLog = (): string => {
    const services = ['auth', 'billing', 'search', 'render', 'queue', 'mailer', 'gateway', 'indexer']
    const verbs = ['accepted', 'retried', 'throttled', 'completed', 'deferred', 'rejected', 'merged', 'flushed']
    let out = '', i = 0, alpha = false, omega = false
    while (out.length < 1_050_000) {
      if (!alpha && out.length > 100_000) { out += 'NEEDLE-ALPHA configuration value: 48213-KESTREL\n'; alpha = true }
      if (!omega && out.length > 900_000) { out += 'NEEDLE-OMEGA rollback token: 90517-HALCYON\n'; omega = true }
      out += `2026-09-2${i % 5} 1${i % 10}:${String(i % 60).padStart(2, '0')} [${services[(i * 7) % 8]}] request ${100000 + i} ${verbs[(i * 5 + 3) % 8]} after ${(i * 37) % 900} ms (shard ${(i * 11) % 32})\n`
      i++
    }
    return out
  }
  /** A 32k server whose tokenizer makes 1.7 characters a token and that refuses, as llama.cpp does,
   *  any prompt that does not leave the answer room. */
  const strictServer = (options: { measure?: boolean; charsPerToken?: number; onAsk?: () => void } = {}) => {
    const asked: LocalModelRequest[] = []
    let refused = 0
    const tokens = (text: string): number => Math.ceil(text.length / (options.charsPerToken ?? 1.7))
    const runner = {
      contextTokens: async () => 32_768,
      ...(options.measure === false ? {} : { promptTokens: async (request: { system: string; user: string }) => tokens(request.system + request.user) + 12 }),
      ask: async (request: LocalModelRequest): Promise<LocalModelOutcome> => {
        asked.push(request)
        options.onAsk?.()
        if (tokens(request.system + request.user) + 12 + request.maxTokens > 32_768) { refused++; return { ok: false, reason: 'the request was longer than the local model\'s context (Local model request failed with HTTP 400 (exceed_context_size))', contextExceeded: true } }
        // Answered the way the real Qwen 3.6 answered the two-needle question on one section:
        // the needle it holds, and NOT FOUND for the other (VR3 A4 re-run, 15:2xZ).
        const needle = /^\d+: (NEEDLE-\w+ .*)$/m.exec(request.user)
        const other = needle?.[1]!.startsWith('NEEDLE-ALPHA') ? 'NEEDLE-OMEGA' : 'NEEDLE-ALPHA'
        return { ok: true, answer: { text: needle ? `${needle[0]}\n${other}: NOT FOUND IN THIS EXCERPT` : 'NOT FOUND IN THIS EXCERPT', model: 'local/qwen3.6-35b-a3b', inputTokens: 1000, outputTokens: 10, durationMs: 20 } }
      }
    }
    return { runner, asked, refused: () => refused }
  }

  it('sizes windows from the server\'s real context so a dense 1 MB log is read end to end (VR3 A4)', async () => {
    writeFileSync(join(root, 's7-1mb.log'), denseLog())
    const server = strictServer()
    const tools = new LocalAssistTools({ session: () => session(), runner: server.runner, ledger: { record: () => undefined, summary: () => { throw new Error('unused') } } })
    const result = await tools.ask('a1', { prompt: 'values on the NEEDLE-ALPHA and NEEDLE-OMEGA lines', files: ['s7-1mb.log'] })
    expect(server.refused()).toBe(0)
    expect(result.structured).toMatchObject({ answered: true, examined: result.structured.chunks })
    expect(result.text).toMatch(/s7-1mb\.log \(part \d+\/\d+, lines \d+–\d+\): \d+: NEEDLE-ALPHA configuration value: 48213-KESTREL/)
    expect(result.text).toMatch(/s7-1mb\.log \(part \d+\/\d+, lines \d+–\d+\): \d+: NEEDLE-OMEGA rollback token: 90517-HALCYON/)
    expect(result.text).not.toContain('not examined')
    // The sections naming the question's terms are read before the rest.
    expect(server.asked[0]!.user).toContain('NEEDLE-ALPHA configuration')
    expect(server.asked[1]!.user).toContain('NEEDLE-OMEGA rollback')
    expect(result.text.indexOf('NEEDLE-ALPHA configuration')).toBeLessThan(result.text.indexOf('NEEDLE-OMEGA rollback'))
  })

  it('retries a window the server refuses as too long once, as two halves, when it cannot measure first', async () => {
    writeFileSync(join(root, 'dense.log'), denseLog().slice(0, 200_000))
    const server = strictServer({ measure: false, charsPerToken: 1.2 })
    const tools = new LocalAssistTools({ session: () => session(), runner: server.runner, ledger: { record: () => undefined, summary: () => { throw new Error('unused') } } })
    const result = await tools.ask('a1', { prompt: 'Quote the NEEDLE-ALPHA line.', files: ['dense.log'] })
    expect(server.refused()).toBeGreaterThan(0)
    expect(result.text).toContain('NEEDLE-ALPHA configuration value: 48213-KESTREL')
    expect(result.text).not.toContain('not examined')
    expect(result.structured).toMatchObject({ answered: true, examined: result.structured.chunks })
  })

  it('stops after one smaller retry and names exactly which lines were not read', async () => {
    writeFileSync(join(root, 'dense.log'), denseLog().slice(0, 200_000))
    const tools = new LocalAssistTools({
      session: () => session(),
      runner: { ask: async () => ({ ok: false, reason: 'the request was longer than the local model\'s context (Local model request failed with HTTP 400 (exceed_context_size))', contextExceeded: true }) },
      ledger: { record: () => undefined, summary: () => { throw new Error('unused') } }
    })
    const result = await tools.ask('a1', { prompt: 'Quote the NEEDLE-ALPHA line.', files: ['dense.log'] })
    expect(result.structured).toMatchObject({ answered: false, examined: 0 })
    expect(result.text).toMatch(/^Not found in the 0 of \d+ section\(s\)/)
    expect(result.text).toMatch(/were not examined \(local model failed: .*exceed_context_size.*\): dense\.log lines 1–\d+\./)
  })

  it('answers within the 300 s an HTTP MCP client waits: term sections first, the rest reported unread (VR3 A4)', async () => {
    writeFileSync(join(root, 's7-1mb.log'), denseLog())
    let clock = Date.parse('2026-09-25T12:00:00Z')
    const server = strictServer({ onAsk: () => { clock += 75_000 } })
    const tools = new LocalAssistTools({ session: () => session(), runner: server.runner, ledger: { record: () => undefined, summary: () => { throw new Error('unused') } }, now: () => new Date(clock) })
    const result = await tools.ask('a1', { prompt: 'values on the NEEDLE-ALPHA and NEEDLE-OMEGA lines', files: ['s7-1mb.log'] })
    // 75 s a section: sections end at 75, 150 and 225 s; a fourth would end at 300 s, past 240.
    expect(server.asked).toHaveLength(3)
    expect(server.asked[2]!.timeoutMs).toBe(135_000) // cut off 285 s into the call, under the client's 300 s
    expect(result.text).toContain('NEEDLE-ALPHA configuration value: 48213-KESTREL')
    expect(result.text).toContain('NEEDLE-OMEGA rollback token: 90517-HALCYON')
    const total = result.structured.chunks as number
    expect(result.text).toContain(`read 3 of ${total} sections. ${total - 3} of ${total} sections of s7-1mb.log (`)
    expect(result.text).toMatch(/bytes\) were not examined \(one call answers within 4 min, and a section takes about 75 s on this model\): s7-1mb\.log lines \d+–\d+/)
    expect(result.text).toContain('Sections naming "needle-alpha", "needle-omega" were read first.')
  })

  it('picks only distinctive literals from the question', () => {
    expect(promptTerms('values on the NEEDLE-ALPHA and NEEDLE-OMEGA lines')).toEqual(['needle-alpha', 'needle-omega'])
    expect(promptTerms('where is line1500 defined? Is there a line saying ALL_DONE or "exit code 3"?')).toEqual(['exit code 3', 'line1500', 'all_done'])
    expect(promptTerms('Summarise this file: its purpose and anything unusual.')).toEqual([])
  })
})

describe('hostCommandRunner', () => {
  it('streams output to the log and reports the exit code', async () => {
    const logFile = join(root, 'out.log')
    const result = await hostCommandRunner({ command: 'node -e "console.log(1);console.error(2);process.exit(3)"', cwd: root, logFile, timeoutMs: 30_000 })
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(logFile, 'utf8')).toMatch(/1[\s\S]*2|2[\s\S]*1/)
  })

  it('kills a command that runs past its timeout', async () => {
    const result = await hostCommandRunner({ command: 'node -e "setTimeout(() => {}, 60000)"', cwd: root, logFile: join(root, 'slow.log'), timeoutMs: 500 })
    expect(result.timedOut).toBe(true)
  }, 20_000)

  it('kills the command when the caller aborts', async () => {
    const controller = new AbortController()
    const pending = hostCommandRunner({ command: 'node -e "setTimeout(() => {}, 60000)"', cwd: root, logFile: join(root, 'aborted.log'), timeoutMs: 60_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const result = await pending
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBeLessThan(20_000)
  }, 25_000)
})

vi.setConfig({ testTimeout: 20_000 })
