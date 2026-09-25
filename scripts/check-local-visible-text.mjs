// VR7 row 19 "status-items" check over saved local-conversation projections: no status text item
// over ~500 characters, and no "[Conductor" in any visible model text (assistant or status).
//   node scripts/check-local-visible-text.mjs <projection.json | directory>...
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const STATUS_LIMIT = 500
/** Offending items of one projection: status text too long, or model text carrying a Conductor note. */
export function visibleTextOffences(projection) {
  const offences = []
  for (const item of projection.items ?? []) {
    const data = item.data
    if (data?.type !== 'text' || data.role === 'user') continue
    if (data.role === 'status' && data.text.length > STATUS_LIMIT) offences.push({ id: item.id, role: data.role, problem: `status text is ${data.text.length} characters`, excerpt: data.text.slice(0, 160) })
    if (data.text.includes('[Conductor')) offences.push({ id: item.id, role: data.role, problem: 'model text contains "[Conductor"', excerpt: data.text.slice(Math.max(0, data.text.indexOf('[Conductor') - 60), data.text.indexOf('[Conductor') + 100) })
  }
  return offences
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check-local-visible-text.mjs')) {
  const files = process.argv.slice(2).flatMap(path => statSync(path).isDirectory() ? readdirSync(path).filter(name => name.endsWith('.projection.json')).map(name => join(path, name)) : [path])
  let failed = 0
  for (const file of files) {
    const offences = visibleTextOffences(JSON.parse(readFileSync(file, 'utf8')))
    const statusItems = (JSON.parse(readFileSync(file, 'utf8')).items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'status')
    console.log(`${offences.length ? 'FAIL' : 'PASS'} ${file}: ${statusItems.length} status items, longest ${Math.max(0, ...statusItems.map(item => item.data.text.length))} chars, ${offences.length} offences`)
    for (const offence of offences) console.log('  ', JSON.stringify(offence))
    if (offences.length) failed++
  }
  if (!files.length) { console.log('FAIL no projections given'); process.exit(1) }
  process.exit(failed ? 1 : 0)
}
