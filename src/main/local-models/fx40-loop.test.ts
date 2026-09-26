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
    // The reports are in the conversation: a merge of numbers nobody sent is refused (inventedReports).
    const outcome = await run(`Using only the two reports your coworkers sent (${reports.join('; ')}), give the total per category for January and February together, and say which category grew the most from January to February.`)
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
    const outcome = await run('Using only the two reports your coworkers sent (jan.csv: rent=950, groceries=350.8; feb.csv: rent=950, groceries=274.8), give the total per category for January and February together.')
    const reports = outcome.tools.filter(tool => tool.name === 'conductor')
    expect(reports[0]!.output).toMatch(/^not sent: no conversation opened this one/)
    expect(controlCalls).toBe(1)
    // The same refusal twice turns the method off; each call to it after that is answered with a
    // round offered no tools (FX44), and a model that still calls it a third time ends the turn.
    expect(reports[1]!.output).toContain('failed with this same error twice, so it is off for the rest of this message')
    expect(reports.slice(2).map(tool => tool.output.slice(0, 8))).toEqual(['not run:', 'not run:', 'not run:'])
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

  it('keeps memory writes out of a swarm task and ends a repeated invalid call early (FX42, VR9a timesheet run 1)', async () => {
    const methods: string[] = []
    const control = async (method: string) => { methods.push(method); return method === 'tabs.open' ? { agentSessionId: 'agent_w1' } : {} }
    // Run 1: one coworker opened, then memory.remember without a gist, eleven times.
    const steps = [
      call('o', 'conductor', { method: 'tabs.open', args: { title: 'Week 1', prompt: 'Add up the hours per person in week1.csv.' } }),
      ...Array.from({ length: 11 }, (_, n) => call(`m${n}`, 'conductor', { method: 'memory.remember', args: { kind: 'episodic', cues: ['week1.csv', `cue ${n}`] } }))
    ]
    const { run } = await session((_sent, index) => steps[index] ?? answer('Waiting for the reports.'), { control })
    const outcome = await run('I have two timesheets, week1.csv and week2.csv. Open one coworker of yourself per file to add up the hours per person and report back to you. When both have reported, tell me how many hours each person worked over the two weeks together, and who worked the most.')
    expect(methods).toEqual(['tabs.open'])
    const memory = outcome.tools.filter(tool => tool.name === 'conductor').slice(1)
    expect(memory[0]!.output).toMatch(/^not saved: memory is not part of this task/)
    expect(memory[1]!.output).toContain('failed with this same error twice, so it is off for the rest of this message')
    expect(memory).toHaveLength(5)
    expect(outcome.stopReason).toBe('stagnation')
  })

  it('says what memory.remember needs when the gist is missing, outside a swarm', async () => {
    const control = async () => ({ ok: true })
    const { run } = await session((sent, index) => index === 0 ? call('m', 'conductor', { method: 'memory.remember', args: { kind: 'semantic', cues: ['node'] } }) : answer('Noted.'), { control })
    const outcome = await run('remember that the build uses node 24')
    expect(outcome.tools[0]!.output).toMatch(/^denied: memory.remember needs gist: the one sentence to remember/)
  })

  it('merges the reports it received when the model slips a made-up one in (FX42, B1 run)', async () => {
    const invented = call('c', 'calculate', { combine: ['jan.csv: rent=950, groceries=350.8, transport=86.5', 'feb.csv: rent=1000, groceries=375, transport=90'] })
    const { run } = await session((_sent, index) => index < 2 ? answer('Noted.') : index === 2 ? invented : answer('Rent 1900, groceries 625.6, transport 186.5.'))
    await run('jan.csv: rent=950, groceries=350.8, transport=86.5')
    await run('feb.csv: rent=950, groceries=274.8, transport=100')
    const outcome = await run('Using only the two reports your coworkers sent, give the total per category for January and February together.')
    expect(outcome.tools[0]!.output).toMatch(/^\[Conductor: a report in this call was not one this conversation received, so the 2 reports it did receive were merged instead\.\]\n/)
    expect(outcome.tools[0]!.output).toContain('rent = 1900 (950 + 950; change +0)')
    expect(outcome.tools[0]!.output).toContain('transport = 186.5')
    expect(outcome.text).toContain('Rent 1900')
  })

  it('answers from a calculation the model repeats instead of stopping on it (FX42 timesheet run)', async () => {
    const merge = call('c', 'calculate', { combine: ['Week 1: ana=21.75, ben=19.75, cara=12.75', 'Week 2: ana=17.25, ben=12.75, cara=17'] })
    const { requests, run } = await session((sent, index) => (sent.tools?.length ?? 0) === 0 && index > 0 ? answer('Ana 39, Ben 32.5, Cara 29.75: Ana worked the most.') : merge)
    const outcome = await run('Week 1: ana=21.75, ben=19.75, cara=12.75. Week 2: ana=17.25, ben=12.75, cara=17. Add up the hours per person over both weeks.')
    expect(outcome.stopReason).toBe('completed')
    expect(outcome.tools.map(tool => tool.name)).toEqual(['calculate', 'calculate'])
    expect(outcome.tools[1]!.output).toMatch(/^Already computed for this message; the result is:\ncombined 2 reports/)
    expect(requests.at(-1)!.tools).toBeUndefined()
    expect(outcome.text).toContain('Ana 39, Ben 32.5, Cara 29.75')
  })

  it('treats a follow-up about received reports as a merge to compute (FX42 timesheet run)', async () => {
    const { requests, run } = await session((sent, index) => index < 2 ? answer('Noted.') : index === 2 ? answer('Ana 39, Ben 32.75, Cara 29.75.') : sent.tool_choice === 'required' ? answer('still no call') : answer('Ana 39, Ben 32.5, Cara 29.75: Ana worked the most.'))
    await run('[Automatic report: Week 1] ana = 21.75\nben = 19.75\ncara = 12.75')
    await run('[Automatic report: Week 2] ana = 17.25\nben = 12.75\ncara = 17')
    const outcome = await run('so, how many hours did each person work over both weeks, and who worked the most?')
    expect(lastUser(requests[2]!)).toContain(CALC_HINT)
    // Asked once, then held to calculate, then Conductor merged the two reports itself.
    const merge = outcome.tools.find(tool => tool.name === 'calculate')!
    expect(merge.output).toContain('ben = 32.5 (19.75 + 12.75')
    expect(outcome.text).toContain('Ben 32.5')
  })

  it('merges only reports the conversation received (FX42, VR9a timesheet run 2)', async () => {
    const invented = call('c', 'calculate', { combine: ['Person A worked 40 hours in week 1 and 30 hours in week 2.', 'Person B worked 35 hours in week 1 and 45 hours in week 2.'] })
    const { run } = await session((_sent, index) => index === 0 ? invented : answer('No coworker has reported yet.'))
    const outcome = await run('so, how many hours did each person work over both weeks, and who worked the most?')
    expect(outcome.tools[0]!.output).toMatch(/^not computed: the numbers of at least one of these reports are not in this conversation/)
    expect(outcome.text).toBe('No coworker has reported yet.')
  })
})
