#!/usr/bin/env node
// Which exact allow rules does the installed claude CLI honour for a compound Bash command?
// Deterministic: every case runs headless `claude -p --permission-mode manual`, where a Bash call no
// rule allows is refused outright (nobody can be asked), so the auto-mode classifier plays no part.
// Each command only prints "pong" in a temp folder; each case is one short Haiku turn.
// The expectations are claude 2.1.282's behaviour, probed on 2026-09-28 (docs/permissions-classifier.md),
// which src/shared/permission-grants.ts (nativeGrantRules, changesDirectoryBeforeInput) relies on.
// Usage: node scripts/probe-permission-rule-matching.mjs   (exit 1 when any case differs)
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const A = `node -e "console.log('pong')"`, B = `node -e "console.log('ping')"`
const cases = [
  { name: 'no rule refuses (control)', command: A, rules: [], expect: 'REFUSED' },
  { name: 'exact rule allows a simple command', command: A, rules: [A], expect: 'RAN' },
  { name: 'exact whole rule does NOT allow a pipeline', command: `${A} 2>&1 | tail -5`, rules: [`${A} 2>&1 | tail -5`], expect: 'REFUSED' },
  { name: 'exact rule for the non-read-only part allows the pipeline', command: `${A} 2>&1 | tail -5`, rules: [`${A} 2>&1`], expect: 'RAN' },
  { name: 'cd chain + pipe: exact part rule allows', command: `cd app && ${A} 2>&1 | tail -5`, rules: [`cd app && ${A} 2>&1`, 'tail -5'], expect: 'RAN' },
  { name: '&& chain: exact whole rule allows', command: `${A} && ${B}`, rules: [`${A} && ${B}`], expect: 'RAN' },
  { name: 'input redirect: exact rule allows the same file', command: `${A} < input.txt`, rules: [`${A} < input.txt`], expect: 'RAN' },
  { name: 'input redirect: exact rule does not allow another file', command: `${A} < other.txt`, rules: [`${A} < input.txt`], expect: 'REFUSED' },
  { name: 'input redirect without cd, in a pipeline: part rule allows', command: `${A} < app/input.txt 2>&1 | tail -5`, rules: [`${A} < app/input.txt 2>&1`], expect: 'RAN' },
  { name: 'cd then input redirect: no rule allows it', command: `cd app && ${A} < input.txt 2>&1 | tail -5`, rules: [`cd app && ${A} < input.txt 2>&1 | tail -5`, `cd app && ${A} < input.txt 2>&1`, 'tail -5'], expect: 'REFUSED' }
]

const run = entry => new Promise(resolve => {
  const dir = mkdtempSync(join(tmpdir(), 'rule-matching-'))
  mkdirSync(join(dir, 'app'))
  for (const file of ['input.txt', 'other.txt', join('app', 'input.txt')]) writeFileSync(join(dir, file), 'x\n')
  const settings = join(dir, 'grant-settings.json')
  writeFileSync(settings, JSON.stringify({ permissions: { allow: entry.rules.map(rule => `Bash(${rule})`) } }))
  const args = ['-p', `Run this exact Bash command once, unchanged, and reply with only its output or the exact error you got:\n\n${entry.command}`, '--permission-mode', 'manual', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '3', '--settings', settings]
  const child = spawn('claude', args, { cwd: dir, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.on('close', () => {
    const calls = new Map()
    for (const line of out.split('\n')) {
      let frame; try { frame = JSON.parse(line) } catch { continue }
      for (const block of frame.message?.content ?? []) {
        if (block.type === 'tool_use' && block.name === 'Bash') calls.set(block.id, { command: block.input?.command })
        if (block.type === 'tool_result' && calls.has(block.tool_use_id)) calls.get(block.tool_use_id).result = (Array.isArray(block.content) ? block.content.map(item => item.text ?? '').join('') : String(block.content)).slice(0, 200)
      }
    }
    const target = [...calls.values()].filter(call => call.command === entry.command)
    const verdict = target.some(call => /^p[io]ng/m.test(call.result ?? '')) ? 'RAN' : target.length ? 'REFUSED' : 'NOT-ATTEMPTED'
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    resolve({ verdict, detail: target.at(-1)?.result })
  })
})

let failed = 0
for (const entry of cases) {
  const { verdict, detail } = await run(entry)
  const ok = verdict === entry.expect
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'DIFF'} ${entry.name}: ${verdict}${ok ? '' : ` (expected ${entry.expect}) ${detail ?? ''}`}`)
}
console.log(failed ? `${failed} case(s) differ from claude 2.1.282; revisit nativeGrantRules and changesDirectoryBeforeInput` : 'All cases match claude 2.1.282')
process.exit(failed ? 1 : 0)
