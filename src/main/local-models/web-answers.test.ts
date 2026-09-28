import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { citeSources, datedPage, hitDate, inventedReports, LocalAgentSession, pickPages, READ_FOR_YOU, readForYou, searchHits, stalePage, systemPrompt, wantsWeb, WEB_HINT } from './agent.ts'
import { SEARCH_RESULTS_FLOOR, WEB_CALLS_PER_MESSAGE, toolSpecs } from './tools.ts'
import { focusedText, PAGE_HEADER, readPublicWeb, searchPublicWeb } from './web.ts'
import { DOLPHIN_TEMPLATE, templateDate, templateKwargs, writeChatTemplate } from './templates.ts'
import { llamaServerArgs } from './llama.ts'
import { LOCAL_DOLPHIN_X1_8B, LOCAL_ORNITH_9B } from '../../shared/local-models.ts'

vi.mock('./web.ts', async original => ({
  ...(await original<typeof import('./web.ts')>()),
  searchPublicWeb: vi.fn(async (query: string) => `Search: ${query} (via DuckDuckGo)\nUntrusted result titles, links and snippets.\n1. Python 3.14.7\n   https://www.python.org/downloads/latest/\n   2026-08-05 - Python 3.14.7 is out.\n2. Status of Python versions\n   https://devguide.python.org/versions/`),
  readPublicWeb: vi.fn(async (url: string) => `Source: ${url}\nUntrusted web content.\nPython 3.14.7 was released on 2026-08-05.`)
}))

type Sent = { messages: Array<{ role: string; content: string }>; tool_choice?: string; tools?: Array<{ function: { name: string } }>; chat_template_kwargs?: Record<string, unknown> }
const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })
const call = (id: string, name: string, args: Record<string, unknown>): string => frame({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
const answer = (text: string): string => frame({ content: text }, 'stop')

describe('a local model answering like any other model', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

  /** A llama.cpp stand-in that answers each request from `reply`, given everything sent so far. */
  async function session(reply: (sent: Sent, index: number) => string, grants = { git: false, research: false }) {
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
    const root = mkdtempSync(join(tmpdir(), 'conductor-web-answers-'))
    cleanup.push(() => { server.close(); rmSync(root, { recursive: true, force: true }) })
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const agent = new LocalAgentSession({ endpoint, apiKey: 'k'.repeat(64), model: LOCAL_DOLPHIN_X1_8B, workspace: root, sandbox: null, readOnly: false, grants, timeoutSec: 30, contextTokens: 32768 })
    const tools: Array<{ name: string; output: string }> = []
    const notices: string[] = []
    const run = async (prompt: string) => {
      tools.length = 0; notices.length = 0
      let streamed = '', status = ''
      const outcome = await agent.run(prompt, { text: delta => { streamed += delta }, reasoning: delta => { status += delta }, notice: message => { notices.push(message) }, toolEnd: result => tools.push({ name: result.name, output: result.output }) })
      return { ...outcome, streamed, status }
    }
    return { requests, run, tools, notices }
  }

  it('answers a plain question in one request, offered the web but not pushed to it, with today\'s date in the template', async () => {
    const { requests, run } = await session(() => answer('TCP is reliable and ordered; UDP is connectionless.'))
    const outcome = await run('whats the difference between tcp and udp? short answer pls')
    expect(outcome).toMatchObject({ stopReason: 'completed', text: 'TCP is reliable and ordered; UDP is connectionless.' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.tool_choice).toBe('auto')
    expect(requests[0]!.tools?.map(tool => tool.function.name)).toContain('web_search')
    expect(requests[0]!.chat_template_kwargs).toEqual({ date_string: templateDate(new Date()), tools_in_user_message: false })
    expect(requests[0]!.messages.at(-1)!.content).toBe('whats the difference between tcp and udp? short answer pls')
  })

  it('searches first for a current question, reads a result, and cites the page when the answer names none', async () => {
    const { requests, run, tools } = await session((sent, index) => [
      call('s', 'web_search', { query: 'latest stable python version' }),
      call('r', 'web_read', { url: 'https://www.python.org/downloads/latest/' }),
      call('r2', 'web_read', { url: 'https://devguide.python.org/versions/' }),
      answer('The latest stable Python is 3.14.7, released 2026-08-05.')
    ][index]!)
    const outcome = await run('whats the latest stable python version right now')
    // The hint goes in front, so the owner's words are still the last thing the model reads.
    expect(requests[0]!.messages.at(-1)!.content).toBe(`${WEB_HINT}\n\nwhats the latest stable python version right now`)
    expect(requests[0]!.tool_choice).toBe('required')
    expect(requests[0]!.tools?.map(tool => tool.function.name)).toEqual(['web_search', 'web_read'])
    expect(requests[1]!.tool_choice).toBe('auto')
    expect(requests[1]!.tools?.map(tool => tool.function.name)).toContain('read_file')
    // Two pages: one alone was too often an index page or a price page drawn by script (FX42).
    expect(tools.map(tool => tool.name)).toEqual(['web_search', 'web_read', 'web_read'])
    expect(outcome.text).toBe('The latest stable Python is 3.14.7, released 2026-08-05.\n\nSources: https://www.python.org/downloads/latest/ , https://devguide.python.org/versions/')
    expect(outcome.streamed).toContain('Sources: https://www.python.org/downloads/latest/')
  })

  it('searches for the model when it writes prose instead of the search it was asked for', async () => {
    const { run, tools } = await session((sent, index) => [
      answer('Here are the results from my search: the RTX 5070 is great (made up).'),
      call('r', 'web_read', { url: 'https://www.python.org/downloads/latest/' }),
      answer('From one page only (held back).'),
      answer('Reviewers call it decent value.')
    ][index]!)
    const outcome = await run('find reviews of the nvidia rtx 5070 online and summarize what they say, with sources')
    // Reviews want two pages: the model opened one, Conductor the next best on another site.
    expect(tools.map(tool => tool.name)).toEqual(['web_search', 'web_read', 'web_read'])
    expect(tools[0]!.output).toContain('Search: reviews of the nvidia rtx 5070')
    // The made-up roundup never became part of the answer.
    expect(outcome.streamed).not.toContain('made up')
    expect(outcome.streamed).not.toContain('held back')
    expect(outcome.text).toBe('Reviewers call it decent value.\n\nSources: https://www.python.org/downloads/latest/ , https://devguide.python.org/versions/')
  })

  it('keeps the from-memory draft of the forced round out of the timeline, and never shows an imitated Conductor note (VR7 row 19)', async () => {
    const fake = ' [Conductor: The assistant has provided a direct answer to the question.]'
    const { run, tools } = await session((sent, index) => [
      answer('Max Verstappen won the 2026 Japanese Grand Prix on October 2, 2026. '.repeat(120) + fake.repeat(40)),
      call('r', 'web_read', { url: 'https://www.python.org/downloads/latest/' }),
      call('r2', 'web_read', { url: 'https://devguide.python.org/versions/' }),
      answer('Python 3.14.7 is the latest stable release.' + fake.repeat(30))
    ][index]!)
    const outcome = await run('whats the latest stable python version right now')
    expect(tools.map(tool => tool.name)).toEqual(['web_search', 'web_read', 'web_read'])
    // Nothing of the draft reaches the timeline, as status or as text.
    expect(outcome.status).not.toContain('Verstappen')
    expect(outcome.status.length).toBeLessThanOrEqual(500)
    expect(outcome.streamed).not.toContain('Verstappen')
    // Model text stops where an imitated Conductor note starts.
    expect(outcome.streamed).not.toContain('[Conductor')
    expect(outcome.text).not.toContain('[Conductor')
    expect(outcome.text).toContain('Python 3.14.7 is the latest stable release.')
  })

  it('opens the best results itself when the model answers from search results alone (VR9a: 0 pages read in 10)', async () => {
    const { requests, run, tools } = await session((sent, index) => [
      call('s', 'web_search', { query: 'latest stable python', limit: 1 }),
      answer('The latest version is not provided in the untrusted web search results.'),
      answer('The latest stable Python is 3.14.7, released 2026-08-05 (https://www.python.org/downloads/latest/).')
    ][index]!)
    const outcome = await run("what's the latest stable version of python?")
    // Conductor read the two best results on two sites, then asked for the answer from them.
    expect(tools.map(tool => tool.name)).toEqual(['web_search', 'web_read', 'web_read'])
    // The best of them is read last: an 8B model answers from the last page it read.
    expect(vi.mocked(readPublicWeb).mock.calls.slice(-2).map(args => args[0])).toEqual(['https://devguide.python.org/versions/', 'https://www.python.org/downloads/latest/'])
    // The page is focused on the question's words.
    expect(vi.mocked(readPublicWeb).mock.calls.at(-1)![2]).toEqual({ terms: ['stable', 'version', 'python'], chars: 5000 })
    const note = requests[2]!.messages.at(-1)!.content
    expect(note.startsWith(READ_FOR_YOU)).toBe(true)
    expect(note).toContain('Pages read: https://devguide.python.org/versions/ ; https://www.python.org/downloads/latest/ (2026-08-05).')
    expect(note).toContain('Latest means already released and stable')
    // A limit of 1 is raised: one result leaves nothing to choose a page from.
    expect(vi.mocked(searchPublicWeb).mock.calls.at(-1)![2]).toBe(SEARCH_RESULTS_FLOOR)
    // The answer from snippets was held back, so the owner reads one answer, not two.
    expect(outcome.streamed).toBe('The latest stable Python is 3.14.7, released 2026-08-05 (https://www.python.org/downloads/latest/).')
  })

  describe('a page the owner named that would not open is not replaced by a search result (idea_mugx6gkj, job_muia5ofo_6n4atg5)', () => {
    const named = 'https://www.instagram.com/wearlegohead?stkn=M2oyc2Z2NThpZjln'
    const netflix = 'https://www.whats-on-netflix.com/news/one-piece-getting-a-lego-tv-adaptation-in-september-2026/'
    const lego = () => vi.mocked(searchPublicWeb).mockResolvedValueOnce(`Search: lego head mask (via Seznam)\nUntrusted result titles, links and snippets.\n1. 'One Piece' Getting a LEGO TV Adaptation in September 2026\n   ${netflix}\n   The Straw Hat crew is getting a blocky makeover.`)
    const snippets = 'I could not read the page; the search results mention a LEGO One Piece special.'
    const reads = () => vi.mocked(readPublicWeb).mock.calls.map(args => args[0])

    it('opens nothing in place of a failed named page, lets the answer stand and says why', async () => {
      vi.mocked(readPublicWeb).mockClear()
      // The trace: Ornith read the link without its ?stkn= query, the read failed, it searched, and answered from snippets.
      vi.mocked(readPublicWeb).mockRejectedValueOnce(new Error('www.instagram.com sent no readable text for a plain request'))
      lego()
      const { run, tools, notices } = await session((sent, index) => [
        call('r', 'web_read', { url: 'https://www.instagram.com/wearlegohead/' }),
        call('s', 'web_search', { query: 'lego head mask' })
      ][index] ?? answer(snippets))
      const outcome = await run(`What is this Instagram page selling right now? ${named}`)
      expect(tools.map(tool => tool.name)).toEqual(['web_read', 'web_search'])
      expect(reads()).toEqual(['https://www.instagram.com/wearlegohead/'])
      expect(notices).toContain(`The page named in the message could not be read (${named}); Conductor opened no search result in its place.`)
      expect(notices.some(notice => notice.includes('Conductor opened the best'))).toBe(false)
      expect(outcome.stopReason).toBe('completed')
      expect(outcome.text).toContain(snippets)
      expect(outcome.text).not.toContain(`Sources: ${netflix}`)
    })
    it('still opens the best result when the message names no page', async () => {
      vi.mocked(readPublicWeb).mockClear()
      lego()
      const { run, notices } = await session((sent, index) => [call('s', 'web_search', { query: 'lego head mask' })][index] ?? answer(snippets))
      await run('What is the wearlegohead Instagram page selling right now?')
      expect(reads()).toEqual([netflix])
      expect(notices.some(notice => notice.includes('Conductor opened the best result'))).toBe(true)
    })
    it('still opens the best result when a named page did open', async () => {
      vi.mocked(readPublicWeb).mockClear()
      // An undated page: the default stand-in is dated 2026-08-05, which a question about now leaves out.
      vi.mocked(readPublicWeb).mockResolvedValueOnce(`Source: https://www.instagram.com/wearlegohead/\n${PAGE_HEADER}\nTitle: LegoHeads™ (@wearlegohead) • Instagram photos and videos\nDescription (the page's own summary): 32K Followers, 21 Posts - "The ski mask everyone asks about."`)
      lego()
      const { run, notices } = await session((sent, index) => [
        call('r', 'web_read', { url: 'https://www.instagram.com/wearlegohead/' }),
        call('s', 'web_search', { query: 'lego head mask' })
      ][index] ?? answer(snippets))
      await run(`What is this Instagram page selling right now? ${named}`)
      expect(reads()).toEqual(['https://www.instagram.com/wearlegohead/', netflix])
      expect(notices.some(notice => notice.includes('could not be read'))).toBe(false)
    })
  })

  it('opens pages instead of a third search, and dates a time-relative search the model left undated', async () => {
    const { run, tools } = await session((sent, index) => index < 6 ? call(`s${index}`, 'web_search', { query: `dodgers last night result ${index}`, limit: 1 }) : answer('The Dodgers lost 4-2 to the Padres.'))
    const outcome = await run('did the dodgers win last night?')
    // The forced search and one more ran; the third search became Conductor's reads.
    expect(tools.slice(0, 4).map(tool => tool.name)).toEqual(['web_search', 'web_search', 'web_read', 'web_read'])
    const yesterday = new Date(Date.now() - 86_400_000)
    const day = `${yesterday.toLocaleString('en-US', { month: 'long' })} ${yesterday.getDate()} ${yesterday.getFullYear()}`
    const dated = vi.mocked(searchPublicWeb).mock.calls.find(args => String(args[0]).startsWith('dodgers result 1'))!
    expect(dated[0]).toBe(`dodgers result 1 ${day}`)
    // A current question's searches put dated news in front of the web's pages.
    expect(dated[3]).toEqual({ news: true })
    expect(outcome.stopReason).toBe('completed')
  })

  it('answers history and conversions without tools, and plain questions still see them offered', async () => {
    const { requests, run, tools } = await session(() => answer('George H. W. Bush.'))
    await run('who was president of the united states when the berlin wall fell?')
    expect(requests[0]!.tools).toBeUndefined()
    expect(tools).toEqual([])
    await run('what is 72 fahrenheit in celsius')
    expect(requests[1]!.tools).toBeUndefined()
  })

  it('ranks results: on the question, recent, one per site, and never video pages', () => {
    const now = new Date(2026, 8, 26)
    const hits = searchHits([
      'Search: dodgers last night result (via DuckDuckGo)',
      'Results.',
      '1. September 2008 in sports - Wikipedia', '   https://en.wikipedia.org/wiki/September_2008_in_sports',
      '2. Dodgers win 2020 World Series', '   https://www.mlb.com/news/dodgers-win-2020-world-series', '   Dodgers beat the Rays.',
      '3. Dodgers highlights', '   https://www.youtube.com/watch?v=abc', '   2026-09-25 - Dodgers vs Padres highlights',
      '4. Padres beat Dodgers 4-2', '   https://www.espn.com/mlb/recap/_/gameId/1', '   2026-09-25 - The Padres beat the Dodgers 4-2 on Wednesday night.',
      '5. Dodgers scores', '   https://www.mlb.com/dodgers/scores', '   Dodgers scores and schedule.'
    ].join('\n'))
    expect(hits).toHaveLength(5)
    expect(hits[1]).toEqual({ rank: 2, title: 'Dodgers win 2020 World Series', url: 'https://www.mlb.com/news/dodgers-win-2020-world-series', snippet: 'Dodgers beat the Rays.' })
    expect(pickPages(hits, 'did the dodgers win last night?', [], 2, now)).toEqual(['https://www.espn.com/mlb/recap/_/gameId/1', 'https://www.mlb.com/dodgers/scores'])
    expect(pickPages(hits, 'did the dodgers win last night?', ['https://www.espn.com/mlb/recap/_/gameId/1'], 1, now)).toEqual(['https://www.mlb.com/dodgers/scores'])
  })

  it('prefers the report from the day a question is about, dated by its snippet or its link', () => {
    const now = new Date(2026, 8, 26, 5)
    const hits = searchHits([
      '1. Stock Market News for Sep 23, 2026', '   https://finance.example/stock-market-news-sep-23', '   2026-09-23 - The S&P 500 declined marginally to finish at 7,764.64.',
      '2. S&P 500 close: stocks rise Friday', '   https://news.example/2026/09/25/stocks-close', '   Stocks closed higher.',
      '3. S&P 500 posts record close', '   https://www.cnbc.com/2026/04/15/stock-market-today.html', '   The S&P 500 closed above 7,000.'
    ].join('\n'))
    expect(hitDate(hits[1]!)).toBe('2026-09-25')
    expect(hitDate(hits[2]!)).toBe('2026-04-15')
    expect(pickPages(hits, 'how did the s&p 500 close yesterday?', [], 1, now)).toEqual(['https://news.example/2026/09/25/stocks-close'])
    const note = readForYou(['https://finance.example/stock-market-news-sep-23', 'https://news.example/2026/09/25/stocks-close'], hits, 'how did the s&p 500 close yesterday?', now)
    expect(note).toContain('Pages read: https://finance.example/stock-market-news-sep-23 (2026-09-23) ; https://news.example/2026/09/25/stocks-close (2026-09-25).')
    expect(note).toContain('The question is about 2026-09-25')
    // Each page read says how old it is against that day.
    expect(datedPage('Source: https://finance.example/stock-market-news-sep-23\nPage text.', 'https://finance.example/stock-market-news-sep-23', hits, 'how did the s&p 500 close yesterday?', now))
      .toBe('Source: https://finance.example/stock-market-news-sep-23\n[Conductor: this page is dated 2026-09-23; the question is about 2026-09-25, 2 days later. Its figures are 2 days old.]\nPage text.')
    expect(datedPage('Source: x\nText.', 'https://www.cnbc.com/2026/04/15/stock-market-today.html', hits, "who's the prime minister of japan?", now)).toBe('Source: x\nText.')
    // More than a day before the day asked about: its figures are withheld; a day before is kept.
    expect(stalePage('https://finance.example/stock-market-news-sep-23', hits, 'how did the s&p 500 close yesterday?', now)).toMatch(/^left out: https:\/\/finance.example\/stock-market-news-sep-23 is dated 2026-09-23, 2 days before 2026-09-25/)
    expect(stalePage('https://news.example/2026/09/25/stocks-close', hits, 'how did the s&p 500 close yesterday?', now)).toBeUndefined()
    expect(stalePage('https://finance.example/stock-market-news-sep-23', hits, "who's the prime minister of japan?", now)).toBeUndefined()
  })

  it('does not spend the web budget on a link that already failed', async () => {
    vi.mocked(readPublicWeb).mockRejectedValueOnce(new Error('Research HTTP 404'))
    const { run, tools } = await session((sent, index) => index === 0 ? call('s', 'web_search', { query: 'bitcoin price' })
      : index <= 4 ? call(`r${index}`, 'web_read', { url: 'https://coins.example/made-up' }) : answer('About $84,000 (https://www.python.org/downloads/latest/).'))
    await run('whats bitcoin trading at right now?')
    const made = tools.filter(tool => tool.name === 'web_read' && tool.output.includes('coins.example'))
    expect(tools.some(tool => tool.output === 'error: Research HTTP 404')).toBe(true)
    expect(made.map(tool => tool.output.slice(0, 8))).toEqual(['not run:', 'not run:', 'not run:'])
    expect(vi.mocked(readPublicWeb).mock.calls.filter(args => args[0] === 'https://coins.example/made-up')).toHaveLength(1)
  })

  it('keeps only the opening of pages read for an earlier question when a new one arrives', async () => {
    const long = 'Python 3.14.7 was released on 2026-08-05. ' + 'Older release line. '.repeat(400)
    vi.mocked(readPublicWeb).mockResolvedValueOnce(`Source: https://www.python.org/downloads/latest/\n${PAGE_HEADER}\n${long}`)
    const { requests, run } = await session((sent, index) => [
      call('s', 'web_search', { query: 'latest stable python' }),
      call('r', 'web_read', { url: 'https://www.python.org/downloads/latest/' }),
      call('r2', 'web_read', { url: 'https://devguide.python.org/versions/' }),
      answer('Python 3.14.7 (https://www.python.org/downloads/latest/).'),
      answer('16 ounces.')
    ][index]!)
    await run("what's the latest stable version of python?")
    const page = (sent: Sent) => sent.messages.find(message => message.role === 'tool' && message.content.startsWith('Source: https://www.python.org/downloads/latest/'))!.content
    expect(page(requests[3]!).length).toBeGreaterThan(5000)
    await run('how many ounces are in a pound?')
    expect(page(requests[4]!).length).toBeLessThan(1300)
    expect(page(requests[4]!)).toContain('Python 3.14.7 was released on 2026-08-05.')
  })

  it('keeps a long page to its opening and the passages about the question', () => {
    const page = 'Menu Home Scores\n' + Array.from({ length: 200 }, (_, n) => `Unrelated paragraph number ${n} about nothing in particular at all, padded out to some length.`).join('\n') + '\nThe Padres beat the Dodgers 4-2 on Wednesday night in San Diego.\n' + 'More filler text here.\n'.repeat(100)
    const focused = focusedText(page, ['dodgers', 'win'], 2000)
    expect(focused.length).toBeLessThanOrEqual(2000)
    expect(focused.startsWith('Menu Home Scores')).toBe(true)
    expect(focused).toContain('The Padres beat the Dodgers 4-2')
  })

  it('refuses to merge reports nobody sent (VR9a: "Person A worked 40 hours" combined six times)', () => {
    expect(inventedReports(['Person A worked 40 hours in week 1 and 30 hours in week 2.', 'Person B worked 35 hours in week 1 and 45 hours in week 2.'], 'I have two timesheets, week1.csv and week2.csv. Open one coworker per file.')).toBe(true)
    expect(inventedReports(['week1: ana = 21.75, ben = 19.75', 'week2: ana = 17.25, ben = 12.75'], '[Automatic report: Week 1] ana = 21.75\nben = 19.75\n\nweek2.csv: ana = 17.25, ben = 12.75')).toBe(false)
    expect(inventedReports('not a list', '')).toBe(false)
    // One real report and one made up (B1, FX42 run 2: "feb.csv: rent=1050, ..." never sent).
    const jan = 'jan.csv: rent=950, groceries=350.8, transport=86.5, utilities=118.25, fun=45, total=1550.55'
    expect(inventedReports([jan, 'feb.csv: rent=1050, groceries=380, transport=90, utilities=125, fun=50, total=1615'], `[Automatic report: January] ${jan}\n[Automatic report: February] feb.csv: rent=950, groceries=274.8, utilities=131.75, transport=100, fun=155.5`)).toBe(true)
  })

  it('does not re-read a page, and holds a message to its web budget unless deep research is on', async () => {
    const script = (sent: Sent, index: number): string => index === 0 ? call('r0', 'web_read', { url: 'https://example.com/a' })
      : index === 1 ? call('r1', 'web_read', { url: 'https://example.com/a' })
        : index <= WEB_CALLS_PER_MESSAGE + 1 ? call(`s${index}`, 'web_search', { query: `query number ${index}` })
          : answer('Done (https://example.com/a).')
    const limited = await session(script)
    await limited.run('look up example.com a')
    expect(limited.tools[1]!.output).toMatch(/^Already read above: https:\/\/example\.com\/a is in this conversation/)
    const denied = limited.tools.filter(tool => tool.output.startsWith(`denied: this message has used its ${WEB_CALLS_PER_MESSAGE} web calls`))
    // One read and the searches up to the budget ran; the re-read cost nothing.
    expect(limited.tools.length - denied.length).toBe(WEB_CALLS_PER_MESSAGE + 1)
    expect(denied.length).toBeGreaterThan(0)
    const deep = await session(script, { git: false, research: true })
    await deep.run('look up example.com a')
    expect(deep.tools.some(tool => tool.output.startsWith('denied'))).toBe(false)
  })

  it('offers web search to every full-scope conversation, never to a bounded coding task', () => {
    expect(toolSpecs(false).map(spec => spec.function.name)).toContain('web_search')
    expect(toolSpecs(true).map(spec => spec.function.name)).toEqual(['read_file', 'list_files', 'search', 'web_search', 'web_read', 'calculate'])
    expect(toolSpecs(false, false, undefined, 'coding').map(spec => spec.function.name)).not.toContain('web_search')
    const prompt = systemPrompt('C:/w', false, undefined, 'full', new Date(2026, 8, 25))
    expect(prompt).toContain('Today is 2026-09-25')
    expect(prompt).toContain(`at most ${WEB_CALLS_PER_MESSAGE} web calls`)
    expect(prompt).toContain('answer directly from what you know, with no tool call')
    expect(systemPrompt('C:/w', false, { git: false, research: true }, 'full')).toContain('deep research')
    expect(systemPrompt('C:/w', false, undefined, 'coding')).not.toContain('web_search')
  })

  it('recognizes owner words that ask for current or online facts', () => {
    for (const ask of ['whats the latest stable python version right now', 'what is the newest llama.cpp release on github?', 'find reviews of the nvidia rtx 5070 online', 'look up the dolphin x1 8b model online', 'any news about the eu ai act?'])
      expect(wantsWeb(ask), ask).toBe(true)
    for (const plain of ['whats the difference between tcp and udp? short answer pls', 'how many grams of butter is 1 cup', 'explain mortgage APR vs interest rate', 'fix the failing test in src/app.ts'])
      expect(wantsWeb(plain), plain).toBe(false)
    expect(citeSources('See https://a.example', ['https://b.example'], [])).toBe('')
    expect(citeSources('Answer.', ['https://b.example', 'https://b.example'], ['https://c.example'])).toBe('\n\nSources: https://b.example')
    expect(citeSources('Answer.', [], ['https://c.example'])).toBe('\n\nFrom search results: https://c.example')
  })
})

describe('Conductor chat templates', () => {
  it('passes the template date in the Llama 3.1 format', () => {
    expect(templateDate(new Date(2026, 8, 5))).toBe('5 Sep 2026')
    expect(templateKwargs(new Date(2026, 8, 25))).toEqual({ date_string: '25 Sep 2026', tools_in_user_message: false })
  })
  it('gives Dolphin a template without the code-interpreter line and with its own call format', () => {
    expect(DOLPHIN_TEMPLATE).not.toContain('Environment: ipython')
    expect(DOLPHIN_TEMPLATE).toContain(`'"arguments": '`)
    expect(DOLPHIN_TEMPLATE).not.toContain('"parameters"')
    expect(DOLPHIN_TEMPLATE).toContain('otherwise answer the user directly in plain text')
  })
  it('writes the template for Dolphin only, and the server is started with it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-templates-'))
    try {
      const path = writeChatTemplate(LOCAL_DOLPHIN_X1_8B, dir)!
      expect(readFileSync(path, 'utf8')).toBe(DOLPHIN_TEMPLATE)
      expect(writeChatTemplate(LOCAL_ORNITH_9B, dir)).toBeUndefined()
      const model = { id: LOCAL_DOLPHIN_X1_8B, label: '', repo: 'a/b', revision: 'x', file: 'a.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'a'.repeat(64), port: 51438, contextTokens: 32768, gpuLayers: 999, extraArgs: [] }
      const args = llamaServerArgs(model, 'a'.repeat(64), 'a.gguf', undefined, path)
      expect(args.slice(args.indexOf('--chat-template-file'), args.indexOf('--chat-template-file') + 2)).toEqual(['--chat-template-file', path])
      expect(llamaServerArgs(model, 'a'.repeat(64), 'a.gguf')).not.toContain('--chat-template-file')
      // The owner's own arguments still may not point the server at a template file.
      expect(() => llamaServerArgs({ ...model, extraArgs: ['--chat-template-file'] }, 'a'.repeat(64), 'a.gguf')).toThrow(/Refusing/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
