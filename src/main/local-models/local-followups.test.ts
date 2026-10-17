import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { environmentDownNote, LocalAgentSession, mergeableCalcs, readsRecord, serviceDown, snippetDisclosure, strayNumbers, webReadHistory } from './agent.ts'
import { runTool } from './tools.ts'
import { shapeToolOutput } from './tool-output.ts'
import { resolveLocalAgentPolicy } from './agent-policy.ts'
import { SandboxUnavailableError, type DockerSandbox } from './sandbox.ts'
import { asksAboutOwnReads, wantsWeb } from './web-intent.ts'
import { readPublicWeb, searchPublicWeb } from './web.ts'
import type { ChatMessage } from './client.ts'

// The four failure modes of docs/verification/2026-10-17-local-usefulness.md areas 5, 6, 9 and 10.

vi.mock('./web.ts', async original => ({
  ...(await original<typeof import('./web.ts')>()),
  searchPublicWeb: vi.fn(async (query: string) => `Search: ${query} (via DuckDuckGo)\nUntrusted result titles, links and snippets.\n1. Pixel 10 review: a better phone\n   https://reviews-a.example/pixel-10\n   2026-09-01 - Our verdict: the best Pixel yet.\n2. Pixel 10 review roundup\n   https://reviews-b.example/pixel-10\n   2026-09-02 - Critics like the camera.`),
  readPublicWeb: vi.fn(async (url: string) => `Source: ${url}\nUntrusted web content.\nThe Pixel 10 scores 8/10.`)
}))

type Sent = { messages: Array<{ role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>; tool_choice?: string; tools?: Array<{ function: { name: string } }> }
const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })
const calls = (...list: Array<[string, string, Record<string, unknown>]>): string => frame({ tool_calls: list.map(([id, name, args], index) => ({ index, id, function: { name, arguments: JSON.stringify(args) } })) }, 'tool_calls')
const answer = (text: string): string => frame({ content: text }, 'stop')
const offered = (sent: Sent): string[] => (sent.tools ?? []).map(tool => tool.function.name)

describe('local-model follow-ups from the 2026-10-17 measurement', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

  async function session(reply: (sent: Sent, index: number) => string, files: Record<string, string> = {}, sandbox: DockerSandbox | null = null) {
    const requests: Sent[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const sent = JSON.parse(body) as Sent
        requests.push(sent)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${reply(sent, requests.length - 1)}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const root = mkdtempSync(join(tmpdir(), 'conductor-followups-'))
    for (const [name, content] of Object.entries(files)) { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), content) }
    cleanup.push(() => { server.close(); rmSync(root, { recursive: true, force: true }) })
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const agent = new LocalAgentSession({ endpoint, apiKey: 'k'.repeat(64), model: 'local/ornith1.5-9b', workspace: root, sandbox, readOnly: false, timeoutSec: 30, contextTokens: 32768 })
    const notices: string[] = []
    const tools: Array<{ name: string; input?: string; output: string }> = []
    const run = async (prompt: string) => {
      notices.length = 0; tools.length = 0
      let streamed = ''
      const outcome = await agent.run(prompt, { text: delta => { streamed += delta }, textWithdraw: () => { streamed = '' }, notice: message => { notices.push(message) }, toolEnd: result => tools.push({ name: result.name, output: result.output }) })
      return { ...outcome, streamed }
    }
    return { requests, run, notices, tools, root }
  }

  describe('area 5: per-file results are merged by calculate, not in the model\'s head', () => {
    const week = (rows: Array<[string, number]>): string => `person,hours\n${rows.map(([person, hours]) => `${person},${hours}`).join('\n')}\n`
    const files = { 'week1.csv': week([['Ana', 30], ['Ben', 20.25]]), 'week2.csv': week([['Ana', 28.5], ['Ben', 22]]), 'week3.csv': week([['Ana', 29], ['Ben', 18.5]]) }

    it('finds numbers no calculation returned, and the per-file calls one call can replace', () => {
      expect(strayNumbers('Ana worked 88.5 hours and Ben 60.75; 3 files, 2026-10-17.', ['Ana = 30\nBen = 20.25', 'Ana = 87.5'], 'hours per person in week1.csv')).toEqual(['88.5', '60.75'])
      expect(strayNumbers('Ana 87.50 h, Ben 1,060.75 h', ['Ana = 87.5', 'Ben = 1060.75'], '')).toEqual([])
      expect(mergeableCalcs([{ path: 'week1.csv', column: 'hours', group_by: 'person' }, { path: 'notes.csv', column: 'cost' }, { path: 'week2.csv', column: 'Hours', group_by: 'person' }])).toEqual({ paths: ['week1.csv', 'week2.csv'], column: 'hours', group_by: 'person' })
      expect(mergeableCalcs([{ path: 'week1.csv', column: 'hours' }, { path: 'week1.csv', column: 'hours' }])).toBeUndefined()
    })

    it('replaces an answer merged by hand with one calculate over every file (Ornith: Ana 88.5 for 87.5)', async () => {
      const { requests, run, notices, tools } = await session((sent, index) => {
        if (index === 0) return calls(['c1', 'calculate', { path: 'week1.csv', column: 'hours', group_by: 'person' }], ['c2', 'calculate', { path: 'week2.csv', column: 'hours', group_by: 'person' }], ['c3', 'calculate', { path: 'week3.csv', column: 'hours', group_by: 'person' }])
        if (index === 1) return answer('Ana worked 88.5 hours and Ben 60.75 hours, 149.25 in total.')
        const merged = sent.messages.filter(message => message.role === 'tool').at(-1)!.content
        return answer(merged.includes('Ana = 87.5') ? 'Ana worked 87.5 hours and Ben 60.75 hours, 148.25 in total.' : 'NO MERGE')
      }, files)
      const outcome = await run('How many hours did each person work in total across week1.csv, week2.csv and week3.csv?')
      expect(outcome.stopReason).toBe('completed')
      expect(outcome.text).toContain('Ana worked 87.5 hours')
      expect(outcome.text).not.toContain('88.5')
      expect(outcome.streamed).not.toContain('88.5')
      expect(notices.some(notice => /merged per-file results by hand \(88\.5, 60\.75, 149\.25 came from no calculation\); Conductor totalled 3 files together/.test(notice))).toBe(true)
      const merge = tools.find(tool => tool.output.includes('across 3 files together'))!
      expect(merge.output).toContain('\nAna = 87.5\nBen = 60.75\nall rows = 148.25\n')
      // The wrong answer is not in the conversation the model continues from; the merge and the ask are.
      const last = requests.at(-1)!.messages
      expect(last.some(message => message.role === 'assistant' && message.content.includes('88.5'))).toBe(false)
      expect(last.at(-1)!.content).toMatch(/^\[Conductor\] Your answer had numbers no calculate call returned \(88\.5, 60\.75, 149\.25\)/)
      expect(requests).toHaveLength(3)
    })

    it('asks once for a calculation when there are no per-file totals to merge, and then lets the answer stand', async () => {
      const second = await session((sent, index) => {
        if (index === 0) return calls(['c1', 'calculate', { expression: '30 + 28.5' }])
        if (index === 1) return answer('Ana worked 87.5 hours.')
        if (index === 2) return calls(['c2', 'calculate', { paths: ['week1.csv', 'week2.csv', 'week3.csv'], column: 'hours', group_by: 'person' }])
        return answer('Ana worked 87.5 hours and Ben 60.75 hours.')
      }, files)
      const outcome = await second.run('Total hours per person across week1.csv, week2.csv and week3.csv?')
      expect(outcome.stopReason).toBe('completed')
      expect(second.notices.some(notice => /numbers no calculation returned \(87\.5\)/.test(notice))).toBe(true)
      // The next round offers calculate alone, held to a call.
      expect(offered(second.requests[2]!)).toEqual(['calculate'])
      expect(second.requests[2]!.tool_choice).toBe('required')
      expect(second.requests).toHaveLength(4)
      expect(outcome.text).toContain('87.5')
    })
  })

  describe('area 6: commands that cannot run stop being retried', () => {
    it('says the environment is down once, withdraws run_command, and the model edits instead', async () => {
      const { requests, run, notices, root } = await session((sent, index) => {
        if (index === 0) return calls(['r1', 'run_command', { command: './node_modules/.bin/vitest run src/units.test.ts' }])
        if (index === 1) return calls(['e1', 'edit_file', { path: 'src/units.ts', old_text: 'toKilobytes', new_text: 'bytesToKilobytes' }])
        return answer('Renamed toKilobytes to bytesToKilobytes; the test could not be run here.')
      }, { 'src/units.ts': 'export const toKilobytes = (bytes: number): number => bytes / 1024\n' })
      const outcome = await run('Rename toKilobytes to bytesToKilobytes in src/units.ts and run the test.')
      expect(outcome.stopReason).toBe('completed')
      expect(readFileSync(join(root, 'src/units.ts'), 'utf8')).toContain('bytesToKilobytes')
      expect(offered(requests[0]!)).toContain('run_command')
      expect(offered(requests[1]!)).not.toContain('run_command')
      expect(offered(requests[1]!)).toContain('edit_file')
      // A test command refused before it ran keeps its refusal: shaped as a test report it was empty.
      const result = requests[1]!.messages.at(-1)!.content
      expect(result).toMatch(/^denied: Sandbox unavailable/)
      expect(result).toContain('[Conductor] Commands cannot run on this machine right now')
      expect(result).toContain('no form of run_command (command, code or script) will run')
      expect(notices.filter(notice => notice.startsWith('Commands cannot run on this machine right now'))).toHaveLength(1)
    })

    it('ends the turn when the model keeps calling run_command anyway (Dolphin: 7 calls, never edited)', async () => {
      const { requests, run } = await session((sent, index) => calls([`r${index}`, 'run_command', index % 2 ? { script: `scratch/run-${index}.sh` } : { code: `console.log(${index})`, runtime: 'node' }]))
      const outcome = await run('Fix the failing test and run it.')
      expect(outcome.stopReason).toBe('stagnation')
      expect(outcome.report.detail).toMatch(/kept calling run_command after commands were reported unable to run/)
      // One real attempt and three refusals that never tried again.
      expect(requests).toHaveLength(4)
      expect(requests[2]!.messages.at(-1)!.content).toMatch(/^not run: \[Conductor\] Commands cannot run/)
    })

    it('reports a sandbox that cannot start as unavailable, not as a refused command', async () => {
      const root = mkdtempSync(join(tmpdir(), 'conductor-followups-'))
      cleanup.push(() => rmSync(root, { recursive: true, force: true }))
      const sandbox = { setAnalysisMode: () => undefined, exec: async () => { throw new SandboxUnavailableError('Docker unavailable: Docker Desktop is installed but could not be started.') } } as unknown as DockerSandbox
      const outcome = await runTool('run_command', JSON.stringify({ command: 'ls' }), { workspace: root, readOnly: false, sandbox, timeoutSec: 5 })
      expect(outcome).toMatchObject({ failed: true, unavailable: 'Docker unavailable: Docker Desktop is installed but could not be started.' })
      expect(outcome.output).toBe('denied: Docker unavailable: Docker Desktop is installed but could not be started.')
      // A command that ran and failed for its own reasons is not the environment.
      const ran = { setAnalysisMode: () => undefined, exec: async () => ({ exitCode: 1, stdout: '', stderr: 'boom', truncated: false, timedOut: false, durationMs: 1 }) } as unknown as DockerSandbox
      expect((await runTool('run_command', JSON.stringify({ command: 'false' }), { workspace: root, readOnly: false, sandbox: ran, timeoutSec: 5 })).unavailable).toBeUndefined()
      expect(environmentDownNote('Docker unavailable', 'npm test')).toContain("the task's check (npm test) is Conductor's to run")
      const policy = resolveLocalAgentPolicy({}).toolOutput
      expect(shapeToolOutput('run_command', { command: 'npx vitest run src/a.test.ts' }, 'denied: Docker unavailable: Docker Desktop is not running.', policy).text).toBe('denied: Docker unavailable: Docker Desktop is not running.')
      expect(shapeToolOutput('run_command', { command: 'git diff' }, 'not run: [Conductor] Commands cannot run', policy).text).toBe('not run: [Conductor] Commands cannot run')
    })

    it('treats the same unreachable service from three commands as the environment', async () => {
      expect(serviceDown('stdout:\n\nstderr:\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\nexit code: 1')).toMatch(/^Cannot connect to the Docker daemon/)
      expect(serviceDown('Error: connect ECONNREFUSED 127.0.0.1:5432')).toBe(serviceDown('Error: connect ECONNREFUSED 127.0.0.1:55432'))
      expect(serviceDown('AssertionError: expected 3 to be 4')).toBeUndefined()
      // A sandbox that runs every command, none of which reaches the database it needs.
      let port = 5432
      const refused = { setAnalysisMode: () => undefined, exec: async (command: string) => {
        const marker = /__CONDUCTOR_PAYLOAD_\w+__/.exec(command)![0]
        return { exitCode: 1, stdout: `environment\n\n${marker}\n`, stderr: `\n${marker}\nError: connect ECONNREFUSED 127.0.0.1:${port++}`, truncated: false, timedOut: false, durationMs: 1 }
      } } as unknown as DockerSandbox
      const { requests, run, notices } = await session((sent, index) => index < 3 ? calls([`r${index}`, 'run_command', { command: `node migrate-${index}.mjs` }]) : answer('The database is not reachable, so the migration could not run.'), {}, refused)
      const outcome = await run('Run the migrations.')
      expect(outcome.stopReason).toBe('completed')
      expect(requests).toHaveLength(4)
      expect(requests[1]!.messages.at(-1)!.content).not.toContain('[Conductor]')
      expect(requests[2]!.messages.at(-1)!.content).toContain('[Conductor] This is the second command to fail because a service it needs is not running or not reachable')
      expect(offered(requests[2]!)).toContain('run_command')
      expect(requests[3]!.messages.at(-1)!.content).toContain('[Conductor] Commands cannot run on this machine right now: a service the commands need is not reachable (Error: connect ECONNREFUSED N:N)')
      expect(offered(requests[3]!)).not.toContain('run_command')
      expect(notices).toContain('Three commands failed on the same unreachable service; run_command is off for the rest of this message.')
    })
  })

  describe('area 9: a question about the conversation\'s own reads is answered from its record', () => {
    it('recognizes questions about its own reads, which wantsWeb alone sends to a new search', () => {
      for (const question of ['which of those reviews did you open?', 'Which pages did you actually read?', 'what sources did you use', 'did you open the PhoneArena review?', 'where did you get that number?', 'What were your sources?']) expect(asksAboutOwnReads(question), question).toBe(true)
      for (const question of ['find reviews of the pixel 10', 'which phone has the best reviews?', 'open the docs and read the install section', 'what did you change in src/app.ts?']) expect(asksAboutOwnReads(question), question).toBe(false)
      expect(wantsWeb('which of those reviews did you open?')).toBe(true)
    })

    it('builds the record from the transcript: opened, failed and searched, without repeats', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 's' },
        { role: 'assistant', content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'web_search', arguments: '{"query":"pixel 10 review"}' } }] },
        { role: 'tool', tool_call_id: 's1', content: 'Search: pixel 10 review' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'web_read', arguments: '{"url":"https://a.example/x"}' } }, { id: 'b', type: 'function', function: { name: 'web_read', arguments: '{"url":"https://b.example/y"}' } }] },
        { role: 'tool', tool_call_id: 'a', content: 'Source: https://a.example/x\nText' },
        { role: 'tool', tool_call_id: 'b', content: 'error: b.example answered with a bot check instead of the page' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'a2', type: 'function', function: { name: 'web_read', arguments: '{"url":"https://www.a.example/x/"}' } }] },
        { role: 'tool', tool_call_id: 'a2', content: 'Already read above: https://a.example/x is in this conversation' }
      ]
      expect(webReadHistory(messages)).toEqual([
        { kind: 'search', target: 'pixel 10 review', opened: true },
        { kind: 'read', target: 'https://a.example/x', opened: true },
        { kind: 'read', target: 'https://b.example/y', opened: false, reason: 'b.example answered with a bot check instead of the page' }
      ])
      const record = readsRecord(webReadHistory(messages))
      expect(record).toContain('Pages opened and read: https://a.example/x.')
      expect(record).toContain('Pages that failed to open, so they were not read: https://b.example/y (b.example answered with a bot check instead of the page).')
      expect(readsRecord([])).toContain('this conversation has opened no web page and run no search')
    })

    it('leaves a conversation that never used the web to its tools: "where did you get that number" is about its files', async () => {
      const { requests, run } = await session(() => answer('From week1.csv, row 2.'))
      expect((await run('where did you get that number?')).stopReason).toBe('completed')
      expect(offered(requests[0]!)).toContain('read_file')
      expect(requests[0]!.messages.at(-1)!.content).toBe('where did you get that number?')
    })

    it('answers "which of those reviews did you open" with no tools and no new search', async () => {
      vi.mocked(readPublicWeb).mockClear(); vi.mocked(searchPublicWeb).mockClear()
      vi.mocked(readPublicWeb).mockImplementation(async url => { if (url.includes('reviews-b')) throw new Error('reviews-b.example answered with a bot check instead of the page'); return `Source: ${url}\nUntrusted web content.\nThe Pixel 10 scores 8/10.` })
      const { requests, run } = await session((sent, index) => {
        if (index === 0) return calls(['s1', 'web_search', { query: 'pixel 10 reviews' }])
        if (index === 1) return calls(['a', 'web_read', { url: 'https://reviews-a.example/pixel-10' }], ['b', 'web_read', { url: 'https://reviews-b.example/pixel-10' }])
        if (index === 2) return answer('Reviewers give the Pixel 10 8/10: https://reviews-a.example/pixel-10')
        return answer('I opened https://reviews-a.example/pixel-10; https://reviews-b.example/pixel-10 did not load.')
      })
      try {
        expect((await run('find reviews of the pixel 10 online')).stopReason).toBe('completed')
        const searches = vi.mocked(searchPublicWeb).mock.calls.length
        const followUp = await run('which of those reviews did you open?')
        expect(followUp.stopReason).toBe('completed')
        expect(vi.mocked(searchPublicWeb).mock.calls.length).toBe(searches)
        expect(requests).toHaveLength(4)
        expect(offered(requests[3]!)).toEqual([])
        const asked = requests[3]!.messages.at(-1)!.content
        expect(asked).toContain('Pages opened and read: https://reviews-a.example/pixel-10.')
        expect(asked).toContain('Pages that failed to open, so they were not read: https://reviews-b.example/pixel-10')
        expect(asked).toContain('Searches run: "pixel 10 reviews"')
        expect(asked.endsWith('which of those reviews did you open?')).toBe(true)
      } finally { vi.mocked(readPublicWeb).mockReset() }
    })
  })

  describe('area 10: an answer from search snippets alone says so', () => {
    it('words the note by what happened, and leaves answers that read a page or already say it alone', () => {
      expect(snippetDisclosure('Python 3.14.7.', [], ['https://a.example', 'https://b.example', 'https://a.example'], 1)).toBe('\n\nNote: all 2 pages tried failed to load, so this answer rests only on search-result snippets, not on any page read in full.')
      expect(snippetDisclosure('Python 3.14.7.', [], ['https://a.example'], 1)).toContain('the one page tried failed to load')
      expect(snippetDisclosure('Python 3.14.7.', [], [], 2)).toContain('no page was opened for this answer')
      expect(snippetDisclosure('Python 3.14.7.', ['https://a.example'], ['https://b.example'], 1)).toBe('')
      expect(snippetDisclosure('Python 3.14.7.', [], [], 0)).toBe('')
      expect(snippetDisclosure('From the search snippets: Python 3.14.7.', [], ['https://a.example'], 1)).toBe('')
      expect(snippetDisclosure('I could not open the pages, but results say 3.14.7.', [], ['https://a.example'], 1)).toBe('')
    })

    it('appends the disclosure when every page failed to load (3 of 12 held-out questions)', async () => {
      vi.mocked(readPublicWeb).mockClear()
      vi.mocked(readPublicWeb).mockRejectedValue(new Error('Research HTTP 403'))
      const { run } = await session((sent, index) => index === 0 ? calls(['s1', 'web_search', { query: 'pixel 10 price' }]) : answer('The Pixel 10 costs $799.'))
      try {
        const outcome = await run('what does the pixel 10 cost right now?')
        expect(outcome.stopReason).toBe('completed')
        expect(vi.mocked(readPublicWeb).mock.calls.length).toBeGreaterThanOrEqual(2)
        expect(outcome.text).toContain('The Pixel 10 costs $799.\n\nNote: all 2 pages tried failed to load, so this answer rests only on search-result snippets')
        expect(outcome.streamed).toContain('rests only on search-result snippets')
      } finally { vi.mocked(readPublicWeb).mockReset() }
    })
  })
})
