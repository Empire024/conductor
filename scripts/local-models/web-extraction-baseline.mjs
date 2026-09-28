// Deterministic extraction diagnostic; no network, browser, model, or installed dependency.
// node --experimental-transform-types scripts/local-models/web-extraction-baseline.mjs
import { pageText, focusedText, PAGE_TEXT_CHARS } from '../../src/main/local-models/web.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const acceptance = process.argv.includes('--assert')
const comparable = text => text.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim()

const filler = 'Ordinary documentation text without a target value. '.repeat(12)
const cases = [
  { id: 'article-facts', html: `<nav>Navigation noise</nav><article><h1>Measurements</h1><p>${filler}</p><p>Quartz completed 17 jobs.</p></article>`, facts: ['Quartz completed 17 jobs.'], absent: ['Navigation noise'] },
  { id: 'table-association', html: `<main><p>${filler}</p><table><tr><th>Model</th><th>Count</th></tr><tr><td>Quartz</td><td>17</td></tr><tr><td>Jasper</td><td>29</td></tr></table></main>`, facts: ['Quartz 17', 'Jasper 29'], absent: [] },
  { id: 'multiple-articles', html: `<article><p>${filler}</p><p>Quartz count is 17.</p></article><article><p>${filler}</p><p>Jasper count is 29.</p></article>`, facts: ['Quartz count is 17.', 'Jasper count is 29.'], absent: [] },
  { id: 'article-header-date', html: `<article><header><time datetime="2026-09-27">Published 27 September 2026</time></header><p>${filler}</p><p>Quartz count is 17.</p></article>`, facts: ['Published 27 September 2026', 'Quartz count is 17.'], absent: [] },
  { id: 'long-page-target', html: `<main>${Array.from({ length: 40 }, (_, i) => `<p>Section ${i}: ${filler}</p>`).join('')}<p>Jasper exact total is 29.</p></main>`, facts: ['Jasper exact total is 29.'], absent: [], focus: ['Jasper', 'total'] },
  { id: 'script-shell', html: '<html><body><div id="root"></div><script>const hidden = "Quartz count is 17."</script></body></html>', facts: [], absent: ['Quartz count is 17.'], emptyExpected: true }
]
const rows = cases.map(c => {
  const started = performance.now()
  const full = pageText(c.html)
  const returned = c.focus ? focusedText(full, c.focus, 6000) : full.slice(0, PAGE_TEXT_CHARS)
  return {
    id: c.id, fixtureSha256: createHash('sha256').update(c.html).digest('hex'),
    fullChars: full.length, returnedChars: returned.length,
    retained: c.facts.filter(f => comparable(returned).includes(comparable(f))), missing: c.facts.filter(f => !comparable(returned).includes(comparable(f))),
    unwanted: c.absent.filter(f => returned.includes(f)), emptyExpected: !!c.emptyExpected,
    correctlyEmpty: c.emptyExpected ? full.trim().length === 0 : null,
    elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
    returnedText: returned
  }
})
const result = {
  kind: 'synthetic extraction diagnostic, not live web or model quality',
  generatedAt: new Date().toISOString(), cases: rows.length,
  expectedFacts: cases.reduce((n, c) => n + c.facts.length, 0),
  retainedFacts: rows.reduce((n, r) => n + r.retained.length, 0),
  missingFacts: rows.flatMap(r => r.missing.map(f => ({ case: r.id, fact: f }))), rows
}
const directory = 'artifacts/verification/2026-09-28-web-extraction'
mkdirSync(directory, { recursive: true })
// Preserve the historical baseline when checking a candidate.
writeFileSync(`${directory}/${acceptance ? 'candidate' : 'baseline'}.json`, JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ ...result, rows: rows.map(({ returnedText, ...r }) => r) }))
if (acceptance && rows.some(row => row.missing.length || row.unwanted.length || (row.emptyExpected && !row.correctlyEmpty))) process.exitCode = 1
