import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerDay, datedPage, datesIn, inventedReports, keyExcerpt, LocalAgentSession, pageDate, pickPages, readForYou, searchHits, stalePage } from './agent.ts'
import { runTool, scriptIsCode } from './tools.ts'
import { PAGE_HEADER } from './web.ts'
import { LOCAL_DOLPHIN_X1_8B } from '../../shared/local-models.ts'

vi.mock('./web.ts', async original => ({
  ...(await original<typeof import('./web.ts')>()),
  searchPublicWeb: vi.fn(async (query: string) => `Search: ${query} (via DuckDuckGo)
Results.
1. Python 3.14.7
   https://www.python.org/downloads/latest/
   2026-08-05 - Python 3.14.7 is out.`),
  readPublicWeb: vi.fn(async (url: string) => `Source: ${url}
Untrusted web content.
Menu Downloads
Python 3.14.7 was released on 2026-08-05.`)
}))

// The results VR9d's parked runs got from the real search (2026-09-26, artifacts/verification/2026-09-26-vr9d).
const YANKEES = searchHits([
  'Search: yankees game final score September 25 2026 (via Bing News and Seznam)',
  'Results.',
  '1. Baltimore Orioles vs New York Yankees Final Score — September 25, 2026', '   https://www.si.com/mlb/scoreboard/orioles-vs-yankees-9-25-2026-1976', '   2026-09-24 - Get a preview of Baltimore Orioles at New York Yankees, including matchup info, probable pitchers and start time.',
  '2. Yankees 6-4 Mets (Sep 11, 2026 ) Final Score - ESPN', '   https://www.espn.com/mlb/game/_/gameId/401816894/mets-yankees', '   Game summary of the New York Yankees vs. New York Mets MLB game, final score 6-4, from September 11, 2026 on ESPN.',
  '3. Texas 24-23 Ohio State (Sep 12, 2026 ) Final Score - ESPN', '   https://www.espn.com/college-football/game/_/gameId/401856682/ohio-state-texas', '   Game summary of the Texas Longhorns vs. Ohio State Buckeyes Ncaaf game, final score 24-23, from September 12, 2026 on ESPN.',
  '4. Yankees scores and schedule', '   https://www.mlb.example/yankees/scores', '   Live scores, box scores and the schedule of the New York Yankees.'
].join('\n'))
const IOS = searchHits([
  'Search: latest ios version September 2026 (via Bing News and Seznam)',
  'Results.',
  '1. iOS 27 Release Date: Apple Confirms September 14 Launch', '   https://itechify.com/2026/09/14/ios-27-release-date/', '   2026-09-13 - Apple has confirmed the iOS 27 release date is Monday, September 14, 2026. Here\'s who gets it, what\'s new, and how to prepare your iPhone.',
  '2. iOS 27: Release Date, New Features, and Compatible iPhones', '   https://www.macrumors.com/2026/09/13/ios-27-release-date-new-features/', '   2026-09-13 - At its September 9 event unveiling the iPhone 18 Pro, AirPods 5, Apple Watch Series 12, and more, Apple announced that iOS 27 will be released tomorrow.',
  '3. Apple iOS 27 Release Date: When You Can Download The New iPhone Software — Starts Now', '   https://www.forbes.com/sites/davidphelan/2026/06/11/ios-27-release-date-beta-public-release/', '   2026-06-11 - Apple has unveiled iOS 27 at its Worldwide Developers Conference, introducing Apple ...',
  '4. iOS 27 Issues and Solutions | Official Information as of September 19, 2026', '   https://note.com/keke3331/n/n1a42a452e41a?hl=en', '   2026-09-18 - Since the day after I updated to iOS 27, my battery has been dying by the afternoon.',
  '5. Latest iOS Version : iOS 26 Release History & Supported iPhones...', '   https://www.testmuai.com/latest-version/latest-ios-version/', '   IOS 26.5.2 is the latest iOS version , released June 29, 2026 . See the full iOS 26 release history, iOS 27 beta timeline, supported iPhone models, and how to update.'
].join('\n'))
const SI_PAGE = `Source: https://www.si.com/mlb/scoreboard/orioles-vs-yankees-9-25-2026-1976\n${PAGE_HEADER}\nBaltimore Orioles vs New York Yankees Final Score — September 25, 2026\nYankee Stadium, Bronx · Sep 25, 2026\nFinal\nOrioles Baltimore Orioles W\n10\nYankees New York Yankees\n2`
const SATURDAY = new Date(2026, 8, 26, 6)
const YANKEES_Q = 'what was the final score of the yankees game last night'

describe('FX44: every date a result carries (VR9d)', () => {
  it('reads dates from titles, snippets and links in every common form', () => {
    expect(datesIn('Yankees 6-4 Mets (Sep 11, 2026 ) Final Score')).toEqual(['2026-09-11'])
    expect(datesIn('Final Score — September 25, 2026 and 25 September 2026, 2026-09-24')).toEqual(['2026-09-25', '2026-09-25', '2026-09-24'])
    expect(datesIn('As of July 17, 2026, the latest public iOS version is iOS 26.5.2')).toEqual(['2026-07-17'])
    expect(datesIn('iOS 27 in September 2026, and Sep 45, 2026')).toEqual([])
    // A scoreboard's 9-25-2026 in its link, and the title's date over the snippet's preview date.
    expect(pageDate({ ...YANKEES[0]!, title: 'Orioles vs Yankees' }, undefined, SATURDAY)).toBe('2026-09-25')
    expect(pageDate(YANKEES[1], '2026-09-25', SATURDAY)).toBe('2026-09-11')
  })

  it('does not read a dated game from another day as a live page for last night (ESPN\'s Sep 11 game)', () => {
    const picked = pickPages(YANKEES, YANKEES_Q, [], 3, SATURDAY)
    expect(picked[0]).toBe('https://www.si.com/mlb/scoreboard/orioles-vs-yankees-9-25-2026-1976')
    // The undated live page ranks above both dated ESPN games of other days.
    expect(picked[1]).toBe('https://www.mlb.example/yankees/scores')
    // The model read si.com as www.si.com: it is the same page and is not opened again.
    expect(pickPages(YANKEES, YANKEES_Q, ['https://si.com/mlb/scoreboard/orioles-vs-yankees-9-25-2026-1976'], 1, SATURDAY)).toEqual(['https://www.mlb.example/yankees/scores'])
  })

  it('does not pick a July page for the latest release in September (testmuai\'s iOS 26.5.2)', () => {
    const picked = pickPages(IOS, "what's the latest version of ios?", ['https://www.itechify.com/2026/09/14/ios-27-release-date/'], 2, SATURDAY)
    expect(picked).toHaveLength(2)
    expect(picked).not.toContain('https://www.testmuai.com/latest-version/latest-ios-version/')
    expect(picked).not.toContain('https://itechify.com/2026/09/14/ios-27-release-date/')
  })

  it('dates the right day\'s box score by its own title, never "a day old" from the preview date', () => {
    const labelled = datedPage(SI_PAGE, 'https://www.si.com/mlb/scoreboard/orioles-vs-yankees-9-25-2026-1976', YANKEES, YANKEES_Q, SATURDAY)
    expect(labelled).toContain('[Conductor: this page is dated 2026-09-25; the question is about 2026-09-25, the same day.]')
    expect(labelled).not.toContain('a day old')
    expect(stalePage('https://www.si.com/mlb/scoreboard/orioles-vs-yankees-9-25-2026-1976', YANKEES, YANKEES_Q, SATURDAY, SI_PAGE)).toBeUndefined()
    expect(readForYou(['https://www.si.com/mlb/scoreboard/orioles-vs-yankees-9-25-2026-1976'], YANKEES, YANKEES_Q, SATURDAY)).toContain('(2026-09-25)')
    // Only the page itself names the day: a snippet dated three days early no longer withholds it.
    const hits = searchHits('1. Orioles at Yankees\n   https://scores.example/game/77\n   2026-09-22 - Preview: Orioles at Yankees.')
    const page = `Source: https://scores.example/game/77\n${PAGE_HEADER}\nOrioles 10, Yankees 2 — Final, September 25, 2026\nBox score.`
    expect(stalePage('https://scores.example/game/77', hits, YANKEES_Q, SATURDAY, page)).toBeUndefined()
    expect(datedPage(page, 'https://scores.example/game/77', hits, YANKEES_Q, SATURDAY)).toContain('the same day')
    // A page that really is from another day is still left out.
    const espn = `Source: https://www.espn.com/mlb/game/_/gameId/401816894/mets-yankees\n${PAGE_HEADER}\nNew York Mets @ New York Yankees\nSep 11, 2026, 10:14 pm - AP`
    expect(stalePage('https://www.espn.com/mlb/game/_/gameId/401816894/mets-yankees', YANKEES, YANKEES_Q, SATURDAY, espn)).toMatch(/^left out: .* is dated 2026-09-11, 14 days before 2026-09-25/)
  })

  it('calls a market price read at the weekend the latest close, and never withholds it', () => {
    const gold = 'how much is an ounce of gold going for right now'
    const hits = searchHits([
      '1. Gold prices settle higher Friday', '   https://www.cnbc.com/2026/09/25/gold-prices.html', '   2026-09-25 - Gold settled at $4,297.51 an ounce.',
      '2. Gold midweek', '   https://news.example/gold-wednesday', '   2026-09-23 - Gold rose on Wednesday.'
    ].join('\n'))
    expect(answerDay('2026-09-26', gold)).toBe('2026-09-25')
    expect(answerDay('2026-09-27', 'whats bitcoin trading at right now')).toBe('2026-09-27')
    const labelled = datedPage('Source: https://www.cnbc.com/2026/09/25/gold-prices.html\nText.', 'https://www.cnbc.com/2026/09/25/gold-prices.html', hits, gold, SATURDAY)
    expect(labelled).toContain('the question is about 2026-09-26, when markets are closed, so the latest figures are from 2026-09-25. Its figures are that latest close.')
    expect(labelled).not.toContain('a day old')
    const sunday = new Date(2026, 8, 27, 10)
    expect(stalePage('https://www.cnbc.com/2026/09/25/gold-prices.html', hits, gold, sunday)).toBeUndefined()
    expect(stalePage('https://news.example/gold-wednesday', hits, gold, sunday)).toMatch(/2 days before 2026-09-25/)
    expect(pickPages(hits, gold, [], 1, sunday)).toEqual(['https://www.cnbc.com/2026/09/25/gold-prices.html'])
    // Crypto trades at weekends: Friday's bitcoin price on a Sunday is two days old.
    const coins = searchHits('1. Bitcoin Friday\n   https://coins.example/2026/09/25/btc\n   2026-09-25 - Bitcoin at $84,650.')
    expect(stalePage('https://coins.example/2026/09/25/btc', coins, 'whats bitcoin trading at right now', sunday)).toMatch(/^left out:/)
  })

  it('keeps the lines of a page that answer the question', () => {
    const page = `Source: https://www.cnbc.com/gold\n${PAGE_HEADER}\nMenu Markets Business\nSign in\nGold settled at $4,297.51 an ounce on Friday.\nSilver fell.\n${'Filler about nothing. '.repeat(40)}\nAn ounce of gold is up 1.2% this week.`
    const excerpt = keyExcerpt(page, ['ounce', 'gold'])
    expect(excerpt).toContain('Gold settled at $4,297.51 an ounce on Friday.')
    expect(excerpt).toContain('An ounce of gold is up 1.2% this week.')
    expect(excerpt).not.toContain('Menu Markets')
    expect(excerpt.length).toBeLessThanOrEqual(600)
  })
})

describe('FX44: invented reports with one-digit figures (VR9d bakery run 2)', () => {
  it('refuses "item=orange, sold=7" from files with no orange, and keeps real one-digit figures', () => {
    const received = 'I have two sales files, sat.csv and sun.csv. How many of each item did we sell?\nfailed: column "count" is not a column of sun.csv; its columns are item, sold'
    expect(inventedReports(['sat.csv: item=orange, sold=7', 'sun.csv: item=orange, sold=9'], received)).toBe(true)
    expect(inventedReports([{ orange: 7 }, { orange: 9 }], received)).toBe(true)
    const files = `${received}\nitem,sold\nmuffin,22\nscone,7\nbagel,13\n[Automatic report: Sunday] muffin = 11, scone = 6, bagel = 21`
    expect(inventedReports(['sat.csv: muffin = 22, scone = 7, bagel = 13', 'sun.csv: muffin = 11, scone = 6, bagel = 21'], files)).toBe(false)
  })
})

describe('FX44: run_command with code in script (VR9d timesheet run 1)', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const workspace = (): string => { const root = mkdtempSync(join(tmpdir(), 'conductor-fx44-')); roots.push(root); return root }

  it('tells program text from a path', () => {
    expect(scriptIsCode("const fs = require('fs');\nconsole.log(fs.readFileSync('week1.csv','utf8'))")).toBe(true)
    expect(scriptIsCode('import csv\nprint(1)')).toBe(true)
    expect(scriptIsCode("console.log(require('fs').readdirSync('.'))")).toBe(true)
    expect(scriptIsCode('scratch/sum.mjs')).toBe(false)
    expect(scriptIsCode('scripts/my report (v2).py')).toBe(false)
  })

  it('runs code sent as script as code and says so, and a missing script never reads like missing data', async () => {
    const root = workspace()
    writeFileSync(join(root, 'week1.csv'), 'name,hours\nana,8\n')
    const code = await runTool('run_command', JSON.stringify({ script: "const fs = require('fs');\nconsole.log(fs.readFileSync('week1.csv','utf8'))" }), { workspace: root, readOnly: false, sandbox: null, timeoutSec: 5 })
    expect(code.output).toMatch(/^\[Conductor: script holds program text, not a workspace file path, so it ran as inline code with node\./)
    expect(code.output).not.toMatch(/ENOENT|realpath/)
    const missing = await runTool('run_command', JSON.stringify({ script: 'scratch/sum.mjs' }), { workspace: root, readOnly: false, sandbox: null, timeoutSec: 5 })
    expect(missing.output).toContain('there is no file "scratch/sum.mjs" in the workspace, so nothing ran. This says nothing about any other file.')
    expect(missing.output).not.toMatch(/ENOENT|realpath/)
  })
})

type Sent = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }
const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })
const call = (id: string, name: string, args: Record<string, unknown>): string => frame({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
const answer = (text: string): string => frame({ content: text }, 'stop')

describe('FX44: the turn ends with an answer', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

  async function session(reply: (sent: Sent, index: number) => string) {
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
    const root = mkdtempSync(join(tmpdir(), 'conductor-fx44-loop-'))
    cleanup.push(() => { server.close(); rmSync(root, { recursive: true, force: true }) })
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const agent = new LocalAgentSession({ endpoint, apiKey: 'k'.repeat(64), model: LOCAL_DOLPHIN_X1_8B, workspace: root, sandbox: null, readOnly: false, grants: { git: false, research: false }, timeoutSec: 30, contextTokens: 32768 })
    const tools: Array<{ name: string; output: string }> = []
    const run = async (prompt: string) => {
      tools.length = 0
      let streamed = ''
      const outcome = await agent.run(prompt, { text: delta => { streamed += delta }, toolEnd: result => tools.push({ name: result.name, output: result.output }) })
      return { ...outcome, streamed }
    }
    return { requests, run, tools }
  }
  const offered = (sent: Sent): string[] => (sent.tools ?? []).map(tool => tool.function.name)

  it('answers from what it has after a turned-off tool, instead of stopping with no answer (VR9d research run 2)', async () => {
    const prose = { combine: ['Review A says the battery is weak.', 'Review B likes the camera.'] }
    const { requests, run, tools } = await session((sent, index) => index <= 2 ? call(`c${index}`, 'calculate', prose) : answer('Reviewers like the camera and find the battery weak.'))
    const outcome = await run('combine these two notes into one line: A says the battery is weak, B likes the camera')
    const calcs = tools.filter(tool => tool.name === 'calculate')
    expect(calcs).toHaveLength(3)
    expect(calcs[2]!.output).toMatch(/^not run: calculate failed the same way twice/)
    expect(offered(requests.at(-1)!)).toEqual([])
    expect(outcome.stopReason).toBe('completed')
    expect(outcome.text).toContain('Reviewers like the camera')
    expect(outcome.text).not.toContain('Could not complete the task')
  })

  it('gives back the key lines of a page the model asks for again, and the next round answers (VR9d gold loop)', async () => {
    const { requests, run, tools } = await session((sent, index) => [
      call('s', 'web_search', { query: 'gold price' }),
      call('r1', 'web_read', { url: 'https://www.python.org/downloads/latest/' }),
      call('r2', 'web_read', { url: 'https://python.org/downloads/latest/' }),
      answer('Python 3.14.7 (https://www.python.org/downloads/latest/).')
    ][Math.min(index, 3)]!)
    const outcome = await run("what's the latest stable version of python?")
    const reread = tools.filter(tool => tool.name === 'web_read')[1]!
    expect(reread.output).toMatch(/^Already read above: https:\/\/www\.python\.org\/downloads\/latest\/ is in this conversation/)
    expect(reread.output).toContain('Python 3.14.7 was released on 2026-08-05.')
    expect(offered(requests[3]!)).toEqual([])
    expect(outcome.stopReason).toBe('completed')
    expect(outcome.text).toContain('Python 3.14.7')
  })
})
