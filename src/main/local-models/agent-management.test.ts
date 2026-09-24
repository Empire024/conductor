import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LOCAL_AGENT_POLICY, resolveLocalAgentPolicy } from './agent-policy.ts'
import { detectsTestRun, headAndTail, narrationConclusion, shapeDiffOutput, shapeTestOutput, shapeToolOutput, supersededSummary } from './tool-output.ts'
import { compactHistory, emptyTaskState, measureContext, noteCommand, noteFailure, noteFileChanged, renderTaskState } from './context-manager.ts'
import { callFingerprint, roundStage, roundStageMessage, StagnationDetector } from './progress.ts'
import { completionEstablished, contractConstraints, emptyEvidence, normaliseContract, pathAllowed, recordCommand, unverifiedClaim } from './completion.ts'
import { ruminationVerdict } from './client.ts'
import { assertToolAllowed, runTool, toolSpecs } from './tools.ts'
import { llamaServerArgs, parseLlamaServerFeatures } from './llama.ts'
import { validateConfig, DEFAULT_SANDBOX } from './config.ts'
import type { ChatMessage } from './client.ts'

const policy = DEFAULT_LOCAL_AGENT_POLICY

describe('local agent policy', () => {
  it('resolves overrides onto the defaults and refuses misordered thresholds', () => {
    expect(resolveLocalAgentPolicy({ rounds: { hardLimit: 30 } }).rounds).toEqual({ ...policy.rounds, hardLimit: 30 })
    expect(resolveLocalAgentPolicy().context.toolRoundReserveTokens).toBeLessThan(4096)
    expect(() => resolveLocalAgentPolicy({ context: { compactAt: 0.5 } })).toThrow(/ordered/)
    expect(() => resolveLocalAgentPolicy({ rounds: { finishAt: 40 } })).toThrow(/ordered/)
    expect(() => resolveLocalAgentPolicy({ stagnation: { repeatStopAt: 1 } })).toThrow(/warning must come before/)
    expect(() => resolveLocalAgentPolicy({ toolOutput: { readWindowLines: 5000 } })).toThrow(/read cap/)
  })
})

describe('tool output retention', () => {
  it('keeps the head, the tail and a truthful count of a long command result', () => {
    const raw = 'BEGIN\n' + 'line of noise\n'.repeat(2000) + 'exit code: 1'
    const shaped = shapeToolOutput('run_command', { command: 'ls -R' }, raw, policy.toolOutput)
    expect(shaped.kind).toBe('command')
    expect(shaped.text.length).toBeLessThanOrEqual(policy.toolOutput.commandChars)
    expect(shaped.text.startsWith('BEGIN')).toBe(true)
    expect(shaped.text.endsWith('exit code: 1')).toBe(true)
    expect(shaped.text).toMatch(/\[\.\.\. \d+ characters not shown/)
    expect(shaped.excludedChars).toBe(raw.length - shaped.text.length)
  })

  it('reduces a test run to its failures, assertions and summary', () => {
    const passes = Array.from({ length: 500 }, (_v, i) => `✓ suite > passing case ${i}`).join('\n')
    const raw = `stdout:\n${passes}\n× suite > broken case\n  → expected 3 to be 4\nAssertionError: expected 3 to be 4\n    at tests/x.test.mjs:12:5\n${passes}\nTests  1 failed | 1000 passed (1001)\n\nexit code: 1`
    const shaped = shapeToolOutput('run_command', { command: './node_modules/.bin/vitest run tests/x.test.mjs' }, raw, policy.toolOutput)
    expect(shaped.kind).toBe('test')
    expect(shaped.text).toContain('broken case')
    expect(shaped.text).toContain('expected 3 to be 4')
    expect(shaped.text).toContain('tests/x.test.mjs:12:5')
    expect(shaped.text).toContain('1 failed | 1000 passed')
    expect(shaped.text).toContain('exit code: 1')
    expect(shaped.text).not.toContain('passing case 7')
    expect(shaped.text).toMatch(/\[\d+ passing-test lines omitted\]/)
    expect(shaped.text.length).toBeLessThan(raw.length / 20)
    expect(detectsTestRun('node --test tests/a.test.mjs')).toBe(true)
    expect(detectsTestRun('cat README.md')).toBe(false)
  })

  it('keeps diff hunks and names the files when a diff is cut', () => {
    const file = (n: number): string => `diff --git a/src/f${n}.ts b/src/f${n}.ts\nindex 111..222 100644\n--- a/src/f${n}.ts\n+++ b/src/f${n}.ts\n@@ -1,2 +1,2 @@\n-old\n+new ${'x'.repeat(400)}\n`
    const raw = Array.from({ length: 30 }, (_v, i) => file(i)).join('')
    const shaped = shapeDiffOutput(raw, 3000)
    expect(shaped.text).not.toContain('index 111..222')
    expect(shaped.text).toContain('@@ -1,2 +1,2 @@')
    expect(shaped.text).toMatch(/30 files changed: src\/f0\.ts, src\/f1\.ts/)
    expect(shaped.text.length).toBeLessThan(3400)
    expect(shapeToolOutput('run_command', { command: 'git diff' }, raw, policy.toolOutput).kind).toBe('diff')
  })

  it('shrinks superseded results and old narration to their conclusions', () => {
    expect(supersededSummary('short', 400)).toBe('short')
    const folded = supersededSummary('header line\n' + 'body '.repeat(500), 200)
    expect(folded.startsWith('header line')).toBe(true)
    expect(folded).toMatch(/earlier result, \d+ characters folded/)
    const narration = 'Let me trace this. Wait, maybe not. '.repeat(50) + 'Conclusion: the suffix walk overlaps the middle.'
    const kept = narrationConclusion(narration, 120)
    expect(kept.endsWith('Conclusion: the suffix walk overlaps the middle.')).toBe(true)
    expect(kept.length).toBeLessThan(200)
    expect(headAndTail('abc', 100)).toEqual({ text: 'abc', excluded: 0 })
  })
})

describe('context manager', () => {
  const system: ChatMessage = { role: 'system', content: 'system prompt' }
  const user: ChatMessage = { role: 'user', content: 'Implement public/text-diff.js only; tests/text-diff.test.mjs must pass.' }
  const group = (n: number, size: number): ChatMessage[] => [
    { role: 'assistant', content: `Let me look at round ${n}. Wait, actually, maybe... `.repeat(20), tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `file${n}.ts` }) } }] },
    { role: 'tool', tool_call_id: `c${n}`, content: `[read_file: total_lines=9]\n${'x'.repeat(size)}` }
  ]

  it('grows across tool rounds and crosses the warning threshold, with the reserve counted', () => {
    const messages: ChatMessage[] = [system, user]
    const before = measureContext(messages, [], 8192, 1024, policy.context)
    expect(before.level).toBe('normal')
    let previous = before.promptTokens
    let after = before
    // Small rounds, so the estimate climbs through the bands in order rather than jumping.
    for (let n = 0; n < 40 && after.level === 'normal'; n++) {
      messages.push(...group(n, 300))
      after = measureContext(messages, [], 8192, 1024, policy.context)
      expect(after.promptTokens).toBeGreaterThan(previous)
      previous = after.promptTokens
    }
    expect(after.level).toBe('warning')
    expect(after.capacityTokens).toBe(8192 - 1024)
    // A larger reserve leaves less room for the same prompt: the ratio moves with it.
    const bigReserve = measureContext(messages, [], 8192, 4096, policy.context)
    expect(bigReserve.capacityTokens).toBe(4096)
    expect(bigReserve.ratio).toBeGreaterThan(after.ratio)
    expect(['compact', 'aggressive', 'overflow']).toContain(bigReserve.level)
    expect(after.estimated).toBe(true)
  })

  it('folds old rounds into a task state that keeps the task, constraints and evidence, and drops the verbose output', () => {
    const state = emptyTaskState(user.content, ['Only public/text-diff.js may be changed.', 'Acceptance command: node --test tests/text-diff.test.mjs'])
    noteFileChanged(state, 'public/text-diff.js')
    noteCommand(state, 'node --test tests/text-diff.test.mjs', 1, false)
    noteFailure(state, 'node --test tests/text-diff.test.mjs', 'not ok 3 - suffix\n  expected "abc" got "ab"')
    const messages: ChatMessage[] = [system, user, ...Array.from({ length: 5 }, (_v, n) => group(n, 3000)).flat(), { role: 'user', content: '[Conductor] a nudge' }, ...group(9, 3000)]
    const result = compactHistory(messages, state, { mode: 'normal', policy: policy.context, output: policy.toolOutput, tools: [], contextTokens: 32768, reserveTokens: 2048 })
    expect(result.afterTokens).toBeLessThan(result.beforeTokens / 2)
    expect(result.droppedMessages).toBeGreaterThan(6)
    const [first, second, third] = result.messages
    expect(first).toBe(system)
    expect(second).toBe(user)
    expect(third!.role).toBe('user')
    for (const durable of ['TASK', 'Implement public/text-diff.js only', 'CONSTRAINTS', 'Only public/text-diff.js may be changed', 'Acceptance command', 'FILES CHANGED SO FAR', 'public/text-diff.js', 'RECENT COMMANDS', 'FAILED (exit 1)', 'CURRENT FAILURE', 'not ok 3 - suffix', 'REMAINING WORK']) expect(third!.content).toContain(durable)
    // Old scratch narration and old tool dumps are gone; the newest two groups stay, the older of
    // the two with its result shrunk.
    const rest = result.messages.slice(3)
    expect(rest.filter(message => message.role === 'tool')).toHaveLength(2)
    expect(rest.some(message => message.content.includes('a nudge'))).toBe(false)
    expect(rest.filter(message => message.role === 'tool').map(message => message.content.length).sort((a, b) => a - b)[0]).toBeLessThan(policy.toolOutput.supersededChars + 100)
    expect(rest.filter(message => message.role === 'tool').at(-1)!.content.length).toBeGreaterThan(3000)
    expect(rest.filter(message => message.role === 'assistant').every(message => message.content.length <= policy.toolOutput.narrationChars + 80)).toBe(true)
    expect(state.compactions).toBe(1)
    expect(state.conclusion).toBeDefined()
    // The aggressive form keeps one group only.
    const aggressive = compactHistory(messages, emptyTaskState(user.content), { mode: 'aggressive', policy: policy.context, output: policy.toolOutput, tools: [], contextTokens: 32768, reserveTokens: 2048 })
    expect(aggressive.messages.filter(message => message.role === 'tool')).toHaveLength(1)
    expect(renderTaskState(emptyTaskState('t'))).toContain('- none yet')
  })
})

describe('round policy and stagnation detection', () => {
  it('stages soft, strong and finish warnings before the hard limit', () => {
    expect([0, 9, 10, 15, 16, 19, 20, 23, 24].map(round => roundStage(round, policy.rounds))).toEqual(['normal', 'normal', 'soft', 'soft', 'strong', 'strong', 'finish', 'finish', 'limit'])
    expect(roundStageMessage('soft', 10, policy.rounds)).toContain('10 of 24')
    expect(roundStageMessage('finish', 20, policy.rounds)).toMatch(/final answer/)
  })

  it('detects the same failing action repeated, and does not flag productive work', () => {
    const detector = new StagnationDetector(policy.stagnation)
    const failing = { name: 'run_command', arguments: { command: 'node --test  tests/x.test.mjs' }, output: 'not ok 1\nexit code: 1', failed: true }
    expect(detector.observe(failing).action).toBe('none')
    expect(detector.observe({ ...failing, arguments: { command: 'node --test tests/x.test.mjs' } }).action).toBe('none')
    const third = detector.observe(failing)
    expect(third.action).toBe('warn')
    expect(third.message).toMatch(/repeating an unsuccessful action/)
    expect(detector.observe(failing).action).toBe('none')
    expect(detector.observe(failing).action).toBe('none')
    expect(detector.observe(failing).action).toBe('stop')
    expect(detector.warnings).toBe(1)

    const productive = new StagnationDetector(policy.stagnation)
    const verdicts: string[] = []
    for (let n = 0; n < 12; n++) {
      verdicts.push(productive.observe({ name: 'edit_file', arguments: { path: 'src/a.ts', old_text: `v${n}`, new_text: `v${n + 1}` }, output: 'edited src/a.ts (1 replacement)', failed: false }).action)
      verdicts.push(productive.observe({ name: 'run_command', arguments: { command: 'node --test tests/a.test.mjs' }, output: n < 11 ? `not ok ${n}\nexit code: 1` : 'ok 1\nexit code: 0', failed: n < 11 }).action)
    }
    expect(verdicts.every(action => action === 'none')).toBe(true)
    expect(productive.warnings).toBe(0)
    expect(callFingerprint('read_file', { path: 'a', offset: 1 })).toBe(callFingerprint('read_file', { offset: 1, path: 'a' }))
  })

  it('counts the same missing-path failure across tools, warns once and stops at the policy limit', () => {
    const detector = new StagnationDetector(policy.stagnation)
    const path = '/workspace/file.txt'
    const write = `error: ENOENT: no such file or directory, open 'C:\\Users\\x\\ws\\file.txt'`
    const read = `error: ENOENT: no such file or directory, realpath 'C:\\Users\\x\\ws\\file.txt'`
    const calls = [
      { name: 'apply_edits', arguments: { path, edits: [{ old_text: 'a', new_text: 'b' }] }, output: write, failed: true },
      { name: 'apply_edits', arguments: { path, edits: [{ old_text: 'a', new_text: 'b' }] }, output: write, failed: true },
      { name: 'apply_edits', arguments: { path, edits: [{ old_text: 'a', new_text: 'c' }] }, output: write, failed: true },
      { name: 'edit_file', arguments: { path, old_text: 'a', new_text: 'b' }, output: write, failed: true },
      { name: 'edit_file', arguments: { path, old_text: 'a', new_text: 'b' }, output: write, failed: true },
      { name: 'read_file', arguments: { path }, output: read, failed: true },
    ]
    const verdicts = calls.map(call => detector.observe(call))
    expect(verdicts.map(verdict => verdict.action)).toEqual(['none', 'none', 'warn', 'none', 'none', 'stop'])
    expect(detector.warnings).toBe(1)
    expect(verdicts[5]!.message).toContain(`Equivalent failures on ${path} 6 times across apply_edits, edit_file, read_file`)

    // A second tool reaching the warn threshold on the same path is named as a cross-tool pattern.
    const mixed = new StagnationDetector(policy.stagnation)
    mixed.observe({ name: 'apply_edits', arguments: { path }, output: write, failed: true })
    mixed.observe({ name: 'edit_file', arguments: { path }, output: write, failed: true })
    const warned = mixed.observe({ name: 'read_file', arguments: { path }, output: read, failed: true })
    expect(warned.action).toBe('warn')
    expect(warned.message).toContain(`The same failure has now happened 3 times on ${path} across apply_edits, edit_file, read_file`)
    expect(warned.message).toContain('ENOENT: no such file or directory')
    expect(warned.message).toContain('Trying another tool on the same target fails the same way. If the owner asked for this target, report the failure and stop')
  })

  it('does not pool the same error on different paths', () => {
    const detector = new StagnationDetector(policy.stagnation)
    const actions = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((file, n) => detector.observe({ name: n % 2 ? 'read_file' : 'apply_edits', arguments: { path: `/workspace/${file}` }, output: `error: ENOENT: no such file or directory, open 'C:\\ws\\${file}'`, failed: true }))
    // Five unproductive rounds stay below the idle warning; nothing counts as a repeat.
    expect(actions.map(verdict => verdict.action)).toEqual(['none', 'none', 'none', 'none', 'none'])
    expect(Math.max(...actions.map(verdict => verdict.repeats))).toBe(1)

    const explore = new StagnationDetector(policy.stagnation)
    expect(explore.observe({ name: 'read_file', arguments: { path: 'missing.txt' }, output: `error: ENOENT: no such file or directory, realpath 'C:\\ws\\missing.txt'`, failed: true }).action).toBe('none')
    expect(explore.observe({ name: 'list_files', arguments: { path: '.' }, output: 'notes.txt\nsrc/', failed: false }).action).toBe('none')
    expect(explore.observe({ name: 'read_file', arguments: { path: 'other.txt' }, output: `error: ENOENT: no such file or directory, realpath 'C:\\ws\\other.txt'`, failed: true }).action).toBe('none')
  })

  it('cuts off a reply that keeps restarting its own reasoning', () => {
    const settled = { content: 'The function returns the diff. '.repeat(200), reasoning: '' }
    expect(ruminationVerdict(settled, policy.generation)).toBeUndefined()
    const loop = { content: '', reasoning: 'Let me trace this. Wait, actually the index is off. Hmm, let me rethink. But wait, no, that is not it either. '.repeat(40) }
    expect(ruminationVerdict(loop, policy.generation)).toBe('rumination')
    expect(ruminationVerdict({ content: 'Wait. '.repeat(10), reasoning: '' }, policy.generation)).toBeUndefined()
    expect(ruminationVerdict({ content: 'a'.repeat(policy.generation.ruminationMaxChars), reasoning: '' }, policy.generation)).toBe('rumination')
  })
})

describe('completion evidence and contracts', () => {
  it('validates a contract and enforces its paths', () => {
    expect(normaliseContract(undefined)).toBeUndefined()
    const contract = normaliseContract({ allowedPaths: ['public/text-diff.js', 'src/gen/'], acceptance: { command: 'node --test tests/text-diff.test.mjs', timeoutSec: 60 } })!
    expect(contract.allowedPaths).toEqual(['public/text-diff.js', 'src/gen/'])
    expect(pathAllowed(contract, 'public/text-diff.js')).toBe(true)
    expect(pathAllowed(contract, 'public\\text-diff.js')).toBe(true)
    expect(pathAllowed(contract, 'src/gen/deep/file.ts')).toBe(true)
    expect(pathAllowed(contract, 'src/other.ts')).toBe(false)
    expect(pathAllowed(undefined, 'anything')).toBe(true)
    expect(contractConstraints(contract).join(' ')).toMatch(/Only these paths may be changed.*Acceptance command/)
    for (const bad of [{ allowedPaths: [] }, { allowedPaths: ['../x'] }, { allowedPaths: ['C:/x'] }, { acceptance: { command: '' } }, { acceptance: { command: 'a\nb' } }, { extra: 1 }, { acceptance: { command: 'x', timeoutSec: 0 } }, 'text'])
      expect(() => normaliseContract(bad), JSON.stringify(bad)).toThrow()
  })

  it('refuses a final message that claims work the run never did', () => {
    const empty = emptyEvidence()
    expect(unverifiedClaim('All 5 exact replacements done via edit_file (verified each with read_file). Tests passing.', empty)).toMatch(/no write/)
    expect(unverifiedClaim('I ran the tests and they pass.', empty)).toMatch(/no command ran/)
    expect(unverifiedClaim('I could not apply the edits: the file is missing.', empty)).toBeUndefined()
    expect(unverifiedClaim('The answer is 42.', empty)).toBeUndefined()
    const worked = emptyEvidence()
    worked.writes.push({ path: 'src/a.ts', tool: 'edit_file', sha256: 'abc' })
    recordCommand(worked, 'node --test', 1, false)
    expect(unverifiedClaim('I updated src/a.ts.', worked)).toBeUndefined()
    expect(unverifiedClaim('I updated src/a.ts and all tests pass now.', worked)).toMatch(/every command in this turn failed/)
  })

  it('establishes completion only from a passed acceptance inside the allowed paths', () => {
    const contract = normaliseContract({ allowedPaths: ['src/a.ts'], acceptance: { command: 'node --test' } })
    const evidence = emptyEvidence()
    expect(completionEstablished(undefined, evidence).done).toBe(false)
    expect(completionEstablished(contract, evidence)).toMatchObject({ done: false, because: expect.stringMatching(/has not run/) })
    evidence.acceptance = { command: 'node --test', passed: false, exitCode: 1, report: 'not ok', at: 'now' }
    expect(completionEstablished(contract, evidence).done).toBe(false)
    evidence.acceptance = { command: 'node --test', passed: true, exitCode: 0, report: 'ok', at: 'now' }
    evidence.writes.push({ path: 'src/b.ts', tool: 'write_file', sha256: 'x' })
    expect(completionEstablished(contract, evidence)).toMatchObject({ done: false, because: expect.stringMatching(/outside the allowed paths were changed: src\/b\.ts/) })
    evidence.writes.length = 0
    evidence.writes.push({ path: 'src/a.ts', tool: 'write_file', sha256: 'x' })
    expect(completionEstablished(contract, evidence)).toMatchObject({ done: true })
  })
})

describe('bounded coding tools', () => {
  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-tools-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')
    writeFileSync(join(root, 'big.txt'), Array.from({ length: 500 }, (_v, i) => `line ${i + 1}`).join('\n') + '\n', 'utf8')
    return root
  }

  it('returns a bounded window of a large file by default, with the next range named', async () => {
    const root = workspace()
    try {
      const context = { workspace: root, readOnly: true, sandbox: null, timeoutSec: 30 }
      const whole = await runTool('read_file', JSON.stringify({ path: 'big.txt' }), context)
      expect(whole.output).toContain('total_lines=500; returned_lines=1-200; truncated=true; next range: offset=201')
      expect(whole.output.split('\n')).toHaveLength(201)
      const more = await runTool('read_file', JSON.stringify({ path: 'big.txt', offset: 201, limit: 5000 }), context)
      expect(more.output).toContain('returned_lines=201-500')
      const narrow = await runTool('read_file', JSON.stringify({ path: 'big.txt', limit: 20 }), { ...context, readWindow: { defaultLines: 10, maxLines: 15 } })
      expect(narrow.output).toContain('returned_lines=1-15')
      expect(toolSpecs(true)[0]!.function.description).toContain('at most 200 lines')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('applies several exact edits atomically and reports the one that fails', async () => {
    const root = workspace()
    try {
      const context = { workspace: root, readOnly: false, sandbox: null, timeoutSec: 30 }
      const ok = await runTool('apply_edits', JSON.stringify({ path: 'src/a.ts', edits: [{ old_text: 'const a = 1', new_text: 'const a = 10' }, { old_text: 'const c = 3', new_text: 'const c = 30' }] }), context)
      expect(ok).toMatchObject({ failed: false })
      expect(ok.output).toContain('applied 2 edits to src/a.ts (edit 1: ok; edit 2: ok)')
      expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('const a = 10\nconst b = 2\nconst c = 30\n')
      const bad = await runTool('apply_edits', JSON.stringify({ path: 'src/a.ts', edits: [{ old_text: 'const b = 2', new_text: 'const b = 20' }, { old_text: 'const z = 9', new_text: 'nope' }] }), context)
      expect(bad.failed).toBe(true)
      expect(bad.output).toContain('nothing written to src/a.ts. edit 1: ok; edit 2: old_text not found. 1 earlier edit matched')
      expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('const a = 10\nconst b = 2\nconst c = 30\n')
      const dup = await runTool('apply_edits', JSON.stringify({ path: 'src/a.ts', edits: [{ old_text: 'const', new_text: 'let' }] }), context)
      expect(dup.output).toContain('old_text appears 3 times')
      expect((await runTool('apply_edits', JSON.stringify({ path: 'src/a.ts', edits: [] }), context)).output).toMatch(/^denied: edits must be a list/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses writes outside a contract and narrows the tool set for a bounded task', async () => {
    const root = workspace()
    try {
      const contract = normaliseContract({ allowedPaths: ['src/a.ts'] })
      const context = { workspace: root, readOnly: false, sandbox: null, timeoutSec: 30, contract, scope: 'coding' as const }
      expect((await runTool('write_file', JSON.stringify({ path: 'src/b.ts', content: 'x' }), context)).output).toMatch(/^denied: src\/b\.ts is outside the paths this task may change \(src\/a\.ts\)/)
      expect((await runTool('edit_file', JSON.stringify({ path: 'src/a.ts', old_text: 'const b = 2', new_text: 'const b = 3' }), context)).failed).toBe(false)
      expect((await runTool('conductor', JSON.stringify({ method: 'tasks.list', args: {} }), context)).output).toMatch(/^denied:.*not part of this bounded coding task/)
      expect(toolSpecs(false, true, { git: false, research: true }, 'coding').map(spec => spec.function.name)).toEqual(['read_file', 'list_files', 'search', 'write_file', 'edit_file', 'apply_edits', 'run_command'])
      expect(toolSpecs(true, true, { git: false, research: true }, 'coding').map(spec => spec.function.name)).toEqual(['read_file', 'list_files', 'search'])
      expect(() => assertToolAllowed('web_read', false, undefined, 'coding')).toThrow(/bounded coding task/)
      expect(() => assertToolAllowed('web_read', false, undefined, 'full')).not.toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('llama.cpp KV cache configuration', () => {
  const key = 'a'.repeat(64)
  const model = { id: 'local/test', label: '', repo: 'a/b', revision: 'x', file: 'a.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'a'.repeat(64), port: 51435, contextTokens: 32768, gpuLayers: 10, extraArgs: [] as string[] }
  const help = '-c, --ctx-size N\n-fa, --flash-attn [on|off|auto]\n-ctk, --cache-type-k TYPE\n-ctv, --cache-type-v TYPE\n'

  it('passes cache and flash-attention flags only when configured and advertised by the binary', () => {
    const features = parseLlamaServerFeatures(help)
    expect(features).toEqual({ cacheTypeK: true, cacheTypeV: true, flashAttn: true })
    expect(llamaServerArgs(model, key, 'a.gguf', features).some(arg => arg.startsWith('--cache-type') || arg === '--flash-attn')).toBe(false)
    const quantized = llamaServerArgs({ ...model, kvCacheType: 'q8_0' }, key, 'a.gguf', features)
    expect(quantized.slice(quantized.indexOf('--cache-type-k'), quantized.indexOf('--cache-type-k') + 6)).toEqual(['--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--flash-attn', 'on'])
    // An older build that lists neither flag gets neither, whatever the config says.
    expect(llamaServerArgs({ ...model, kvCacheType: 'q8_0', flashAttention: 'on' }, key, 'a.gguf', parseLlamaServerFeatures('-c, --ctx-size N')).some(arg => arg.startsWith('--cache-type') || arg === '--flash-attn')).toBe(false)
    expect(llamaServerArgs({ ...model, kvCacheType: 'q8_0' }, key, 'a.gguf').some(arg => arg.startsWith('--cache-type'))).toBe(false)
    expect(llamaServerArgs({ ...model, flashAttention: 'off' }, key, 'a.gguf', features)).toContain('off')
  })

  it('validates the cache type and refuses a quantized cache with flash attention off', () => {
    const config = (extra: Record<string, unknown>) => ({ version: 1 as const, llamaServer: 'llama-server', models: { [model.id]: { ...model, ...extra } }, sandbox: DEFAULT_SANDBOX })
    expect(() => validateConfig(config({ kvCacheType: 'q8_0' }))).not.toThrow()
    expect(() => validateConfig(config({ kvCacheType: 'q3_k' }))).toThrow(/kvCacheType/)
    expect(() => validateConfig(config({ flashAttention: 'maybe' }))).toThrow(/flashAttention/)
    expect(() => validateConfig(config({ kvCacheType: 'q4_0', flashAttention: 'off' }))).toThrow(/needs flash attention/)
  })
})
