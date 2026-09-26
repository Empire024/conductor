import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CALC_HINT, LocalAgentSession, type LocalAgentOptions } from './agent.ts'
import { LOCAL_COWORKER_BRIEF } from './briefing.ts'
import { LOCAL_DOLPHIN_X1_8B } from '../../shared/local-models.ts'

type Sent = { messages: Array<{ role: string; content: string }>; tool_choice?: string; tools?: Array<{ function: { name: string } }> }
const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })
const call = (id: string, name: string, args: Record<string, unknown>): string => frame({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
const answer = (text: string): string => frame({ content: text }, 'stop')
const lastUser = (sent: Sent): string => sent.messages.filter(message => message.role === 'user').at(-1)?.content ?? ''

const jan = 'category,amount\nrent,950\ngroceries,212.4\ntransport,64\ngroceries,87.1\nutilities,118.25\ntransport,22.5\nfun,45\ngroceries,51.3\n'

describe('FX40: budgets that renew and numbers that are computed', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

  async function session(reply: (sent: Sent, index: number) => string, extra: Partial<LocalAgentOptions> = {}) {
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
    const root = mkdtempSync(join(tmpdir(), 'conductor-fx40-'))
    writeFileSync(join(root, 'jan.csv'), jan)
    cleanup.push(() => { server.close(); rmSync(root, { recursive: true, force: true }) })
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const agent = new LocalAgentSession({ endpoint, apiKey: 'k'.repeat(64), model: LOCAL_DOLPHIN_X1_8B, workspace: root, sandbox: null, readOnly: false, timeoutSec: 30, contextTokens: 32768, ...extra })
    const run = async (prompt: string) => {
      const tools: Array<{ name: string; output: string; failed: boolean }> = []
      let streamed = ''
      const outcome = await agent.run(prompt, { text: delta => { streamed += delta }, toolEnd: result => tools.push({ name: result.name, output: result.output, failed: result.failed }) })
      return { ...outcome, streamed, tools }
    }
    return { requests, run, agent }
  }

  it('gives the next owner message a fresh tool budget after a turn ran out of rounds', async () => {
    let phase = 'loop'
    const { requests, run, agent } = await session((_sent, index) => phase === 'loop' ? call(`l${index}`, 'list_files', { path: '.' }) : answer('Done.'), { policy: { task: { maxRounds: 3 } } })
    const blocked = await run('keep listing the files')
    expect(blocked.stopReason).toBe('round_limit')
    expect(blocked.text).toContain('cumulative limit of 3 tool rounds')
    expect(agent.state()?.execution?.lifecycle).toBe('blocked')
    phase = 'answer'
    const before = requests.length
    const next = await run('now just say done')
    expect(next.stopReason).toBe('completed')
    expect(next.text).toBe('Done.')
    expect(requests.length).toBe(before + 1)
    expect(next.report.task).toMatchObject({ maxRounds: 3, requests: 1 })
    // The evidence of the blocked turn stays; only the budget is new.
    expect(agent.state()?.execution?.corrections).toContain('now just say done')
  })

  it('reproduces VR8c B2-run4: after three stagnating turns spent the budget, twelve later requests still use tools', async () => {
    // B2-run4: 18, 18, 11 and 9 conductor calls ended "equivalent results 6 times", and each of the
    // next 12 owner requests failed at once with "cumulative limit of 72 tool rounds", 0 calls.
    let mode: 'stagnate' | 'work' = 'stagnate'
    const control = async (method: string) => { if (method === 'tabs.open') throw new Error('A coworker gets the same permission as this conversation (accept-edits) or less, never more'); return { ok: true } }
    const { run } = await session((sent, index) => {
      if (mode === 'stagnate') return call(`s${index}`, 'conductor', { method: 'tabs.open', args: { title: 'Wide', prompt: 'Reply OK.', permission: 'auto' } })
      return sent.messages.at(-1)!.role === 'tool' ? answer('Opened.') : call(`w${index}`, 'conductor', { method: 'agents.list', args: {} })
    }, { control, policy: { task: { maxRounds: 18 } } })
    for (let turn = 0; turn < 3; turn++) {
      const outcome = await run(`Call tabs.open with a coworker on permission auto (coworker ${turn}).`)
      expect(['stagnation', 'round_limit']).toContain(outcome.stopReason)
    }
    mode = 'work'
    const later = []
    for (let request = 0; request < 12; request++) later.push(await run(`List the agents in this conversation (${request}).`))
    expect(later.map(outcome => outcome.stopReason)).toEqual(Array(12).fill('completed'))
    expect(later.every(outcome => outcome.tools.some(tool => tool.name === 'conductor' && !tool.failed))).toBe(true)
    expect(later.some(outcome => /cumulative limit/.test(outcome.text))).toBe(false)
  })

  it('holds a coworker report with guessed sums once, and sends the one computed with calculate', async () => {
    const reports: string[] = []
    const control = async (method: string, args: Record<string, unknown>) => { if (method === 'agents.report') reports.push(String(args.text)); return { delivered: true } }
    const steps = [
      call('r', 'read_file', { path: 'jan.csv' }),
      // Dolphin's VR8c guess: groceries 299.5.
      call('g', 'conductor', { method: 'agents.report', args: { text: 'jan.csv: rent=950, groceries=299.5' } }),
      call('c', 'calculate', { path: 'jan.csv', column: 'amount', group_by: 'category' }),
      call('p', 'conductor', { method: 'agents.report', args: { text: 'jan.csv: rent=950, groceries=350.8, transport=86.5, utilities=118.25, fun=45' } }),
      answer('Reported the January totals.')
    ]
    const { requests, run } = await session((_sent, index) => steps[index]!, { control })
    const outcome = await run(`${LOCAL_COWORKER_BRIEF}\n\nRead jan.csv with read_file. Add up the amount for each category. Then call the conductor tool with method agents.report and args {"text": "jan.csv: " followed by one category=total pair per category}.`)
    expect(outcome.stopReason).toBe('completed')
    expect(requests[0]!.messages.at(-1)!.content.startsWith(CALC_HINT)).toBe(true)
    expect(requests[0]!.tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['calculate', 'conductor']))
    expect(outcome.tools.find(tool => tool.name === 'conductor')).toMatchObject({ failed: true, output: expect.stringContaining('not sent: this report has numbers you did not compute') })
    expect(reports).toEqual(['jan.csv: rent=950, groceries=350.8, transport=86.5, utilities=118.25, fun=45'])
  })

  it('sends one report per message, so a later made-up one never replaces the right one (FX40 swarm run 3)', async () => {
    const reports: string[] = []
    const control = async (method: string, args: Record<string, unknown>) => { if (method === 'agents.report') reports.push(String(args.text)); return { delivery: 'queued' } }
    const steps = [
      call('c', 'calculate', { path: 'jan.csv', column: 'amount', group_by: 'category' }),
      call('p', 'conductor', { method: 'agents.report', args: { text: 'jan.csv: rent=950, groceries=350.8, transport=86.5, utilities=118.25, fun=45' } }),
      call('q', 'conductor', { method: 'agents.report', args: { text: "The 'amount' column in the 'jan.csv' file does not exist. The sum operation failed." } }),
      answer('Reported.')
    ]
    const { run } = await session((_sent, index) => steps[index]!, { control })
    const outcome = await run(`${LOCAL_COWORKER_BRIEF}\n\nRead jan.csv with read_file. Add up the amount for each category. Then call the conductor tool with method agents.report.`)
    expect(outcome.stopReason).toBe('completed')
    expect(reports).toEqual(['jan.csv: rent=950, groceries=350.8, transport=86.5, utilities=118.25, fun=45'])
    expect(outcome.tools.filter(tool => tool.name === 'conductor').map(tool => tool.failed)).toEqual([false, true])
  })

  it('asks once for a calculation when a merge answer is guessed or written as code, and shows only the computed answer', async () => {
    const steps = [
      answer('```python\njan = {"rent": 950}\nfeb = {"rent": 950}\nprint({k: jan[k] + feb[k] for k in jan})\n```'),
      call('c', 'calculate', { expressions: { rent: '950 + 950', groceries: '350.8 + 274.8', fun: '45 + 155.5' } }),
      answer('January and February together: rent 1900, groceries 625.6, fun 200.5. Fun grew the most.')
    ]
    const { requests, run } = await session((_sent, index) => steps[index]!)
    const outcome = await run('Using only the two reports your coworkers sent, give the total per category for January and February together, and say which category grew the most from January to February.')
    expect(outcome.stopReason).toBe('completed')
    expect(lastUser(requests[1]!)).toContain('you have not called calculate')
    // After the nudge the round offers only calculate, with the call required.
    expect(requests[1]!.tool_choice).toBe('required')
    expect(requests[1]!.tools?.map(tool => tool.function.name)).toEqual(['calculate'])
    expect(outcome.text).toBe('January and February together: rent 1900, groceries 625.6, fun 200.5. Fun grew the most.')
    expect(outcome.streamed).not.toContain('```python')
    expect(outcome.streamed).toContain('groceries 625.6')
  })

  it('appends the computed lines when the merge answer paraphrases them (FX40 swarm v2 run 1)', async () => {
    const reports = ['jan.csv: rent=950, groceries=350.8, transport=86.5, utilities=118.25, fun=45', 'feb.csv: rent=950, groceries=274.8, utilities=131.75, transport=100, fun=155.5']
    const steps = [
      call('c', 'calculate', { combine: reports }),
      answer('The combined total for January and February is $3,162.60. The category with the greatest increase from January to February was entertainment, which grew by $110.50.')
    ]
    const { run } = await session((_sent, index) => steps[index]!)
    const outcome = await run('Using only the two reports your coworkers sent, give the total per category for January and February together, and say which category grew the most from January to February.')
    expect(outcome.stopReason).toBe('completed')
    for (const line of ['rent = 1900 (950 + 950; change +0)', 'groceries = 625.6', 'transport = 186.5', 'utilities = 250', 'fun = 200.5', 'largest increase: fun (+110.5)'])
      expect(outcome.text).toContain(line)
    expect(outcome.streamed).toContain('Computed with calculate:')
    // An answer that already carries every computed number is left as it is.
    const exact = await session((_sent, index) => [call('c', 'calculate', { expression: '12.5 + 7' }), answer('It is 19.5.')][index]!)
    expect((await exact.run('what is the total of 12.5 and 7')).text).toBe('It is 19.5.')
  })

  it('merges the received reports itself when the model answers with code even when held to calculate (FX40 swarm v3 run 2)', async () => {
    const code = answer('```python\njan_totals = calculate(path="jan.csv", column="amount", group_by="category")\n```')
    const { requests, run } = await session((_sent, index) => index < 3 ? code : answer('Rent 1900, groceries 625.6, transport 186.5, utilities 250, fun 200.5; fun grew the most.'))
    // Two reports arrive first, as the coworkers' agents.report messages do.
    await run('jan.csv: rent=950, groceries=350.8, transport=86.5, utilities=118.25, fun=45. Total: 1550.55')
    await run('feb.csv: rent=950, groceries=274.8, utilities=131.75, transport=100, fun=155.5')
    const before = requests.length
    const outcome = await run('Using only the two reports your coworkers sent, give the total per category for January and February together, and say which category grew the most from January to February.')
    expect(outcome.stopReason).toBe('completed')
    const merge = outcome.tools.find(tool => tool.name === 'calculate')!
    expect(merge.output).toContain('fun = 200.5 (45 + 155.5; change +110.5)')
    expect(outcome.text).toContain('fun 200.5')
    expect(outcome.streamed).not.toContain('```python')
    expect(requests.length - before).toBeGreaterThanOrEqual(3)
  })

  it('tells a conversation nobody opened that there is no one to report to, and keeps computed numbers when a turn stops (FX40 swarm v3 run 3)', async () => {
    let controlCalls = 0
    const control = async (method: string) => { controlCalls++; if (method === 'agents.report') throw new Error('No controlling conversation is open for this tab'); return {} }
    const report = (id: string) => call(id, 'conductor', { method: 'agents.report', args: { text: 'Total per category (Jan + Feb): rent = $1900, groceries = $626' } })
    const steps = [call('c', 'calculate', { combine: ['jan.csv: rent=950, groceries=350.8', 'feb.csv: rent=950, groceries=274.8'] }), ...Array.from({ length: 12 }, (_, n) => report(`r${n}`))]
    const { run } = await session((_sent, index) => steps[index] ?? answer('done'), { control })
    const outcome = await run('Using only the two reports your coworkers sent, give the total per category for January and February together.')
    const reports = outcome.tools.filter(tool => tool.name === 'conductor')
    expect(reports[0]!.output).toMatch(/^not sent: no conversation opened this one/)
    expect(controlCalls).toBe(1)
    expect(reports.slice(1).every(tool => tool.output.startsWith('not sent: no conversation opened this one'))).toBe(true)
    // The model kept trying until the stagnation stop; the right numbers it computed survive it.
    expect(outcome.stopReason).toBe('stagnation')
    expect(outcome.text).toContain('Computed with calculate before the stop:\nrent = 1900 (950 + 950; change +0)\ngroceries = 625.6')
  })

  it('leaves a controller that dispatches the numbers to coworkers, and plain questions, alone', async () => {
    const opened: string[] = []
    const control = async (method: string, args: Record<string, unknown>) => { if (method === 'tabs.open') opened.push(String(args.title)); return { agentSessionId: `agent_${opened.length}` } }
    const steps = [
      call('a', 'conductor', { method: 'tabs.open', args: { title: 'January', prompt: 'Read jan.csv. Add up the amount for each category.' } }),
      call('b', 'conductor', { method: 'tabs.open', args: { title: 'February', prompt: 'Read feb.csv. Add up the amount for each category.' } }),
      answer('Both coworkers are open; waiting for their 2 reports.')
    ]
    const { requests, run } = await session((_sent, index) => steps[index]!, { control })
    const outcome = await run('You control a small swarm of coworkers. Use the conductor tool with method tabs.open twice for jan.csv and feb.csv so each adds up the amount per category. After both are open, end your turn and wait for their reports.')
    expect(outcome.stopReason).toBe('completed')
    expect(requests).toHaveLength(3)
    expect(requests[0]!.messages.at(-1)!.content).not.toContain(CALC_HINT)
    expect(opened).toEqual(['January', 'February'])
    const plain = await session(() => answer('A mutex has one owner; a semaphore counts permits.'))
    const reply = await plain.run('whats the difference between a mutex and a semaphore? keep it short')
    expect(plain.requests).toHaveLength(1)
    expect(reply.text).toBe('A mutex has one owner; a semaphore counts permits.')
  })
})
