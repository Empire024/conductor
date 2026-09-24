import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalModelOutcome, LocalModelRequest, SavingsRecord } from './contract'
import { capLines, failureLines, modelExcerpt, splitLines, stripAnsi } from './digest'
import { LocalAssistTools, hostCommandRunner, type CommandRunner, type LocalAssistSession } from './tools'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'local-assist-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const session = (overrides: Partial<LocalAssistSession> = {}): LocalAssistSession => ({ projectId: 'p1', sessionId: 's1', agentSessionId: 'a1', provider: 'claude', cwd: root, permission: 'auto', plan: false, ...overrides })

function harness(options: { outcome?: LocalModelOutcome; output?: string; exitCode?: number; session?: Partial<LocalAssistSession> } = {}) {
  const asked: LocalModelRequest[] = []
  const records: SavingsRecord[] = []
  const runs: Parameters<CommandRunner>[0][] = []
  const run: CommandRunner = async request => {
    runs.push(request)
    writeFileSync(request.logFile, options.output ?? '')
    return { exitCode: options.exitCode ?? 0, durationMs: 1234, timedOut: false, outputChars: (options.output ?? '').length }
  }
  const tools = new LocalAssistTools({
    session: id => id === 'a1' ? session(options.session) : undefined,
    runner: { ask: async request => { asked.push(request); return options.outcome ?? { ok: true, answer: { text: 'FAIL src/a.test.ts > adds\nsrc/a.ts:3 expected 2', model: 'local/qwen', inputTokens: 900, outputTokens: 30, durationMs: 50 } } } },
    ledger: { record: entry => records.push({ at: 'now', ...entry }), summary: () => { throw new Error('unused') } },
    run,
    now: () => new Date('2026-09-24T12:00:00Z')
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

  it('summarize_file is local_ask over one file and records no saving when the model is unavailable', async () => {
    writeFileSync(join(root, 'a.md'), '# Title\n'.repeat(100))
    const h = harness({ outcome: { ok: false, reason: 'no local model is configured' } })
    const result = await h.tools.summarizeFile('a1', { path: 'a.md' })
    expect(result.text).toContain('Local model unavailable: no local model is configured.')
    expect(h.records[0]).toMatchObject({ tool: 'summarize_file', usedModel: false, rawChars: 0 })
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
