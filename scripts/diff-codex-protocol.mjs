// Member-level diff of two generated Codex protocol bundles (docs/codex-compatibility.md).
// The request, notification and item unions are single lines, so a plain diff hides what moved;
// this splits every changed .ts file on ` | `, newlines and `;` and prints the members removed (-)
// and added (+), plus files that exist on one side only.
//
//   node scripts/diff-codex-protocol.mjs                 committed bundle (HEAD) vs working tree
//   node scripts/diff-codex-protocol.mjs <old> <new>     two directories
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const BUNDLE = 'src/main/providers/generated/codex'
let [before, after] = process.argv.slice(2)
let scratch
if (!before) {
  scratch = mkdtempSync(join(tmpdir(), 'codex-protocol-head-'))
  // Read-only: the index and working tree are never touched.
  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD', BUNDLE], { maxBuffer: 256 * 1024 * 1024 })
  execFileSync('tar', ['-x', '-C', scratch], { input: archive })
  before = join(scratch, BUNDLE)
}
after = resolve(after ?? BUNDLE)
const files = dir => { const out = []; const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : out.push(relative(dir, p).replaceAll('\\', '/')) } }; walk(dir); return out }
const members = text => new Set(text.replace(/\r/g, '').split(/ \| |\n|;/).map(s => s.trim()).filter(Boolean))
try {
  const a = new Set(files(before)), b = new Set(files(after))
  for (const f of [...a].filter(f => !b.has(f)).sort()) console.log(`removed file ${f}`)
  for (const f of [...b].filter(f => !a.has(f)).sort()) console.log(`added file ${f}`)
  for (const f of [...b].filter(f => a.has(f) && f.endsWith('.ts')).sort()) {
    const x = members(readFileSync(join(before, f), 'utf8')), y = members(readFileSync(join(after, f), 'utf8'))
    const removed = [...x].filter(m => !y.has(m)), added = [...y].filter(m => !x.has(m))
    if (!removed.length && !added.length) continue
    console.log(`\n=== ${f}`)
    for (const m of removed) console.log(`  - ${m}`)
    for (const m of added) console.log(`  + ${m}`)
  }
} finally { if (scratch) rmSync(scratch, { recursive: true, force: true }) }
