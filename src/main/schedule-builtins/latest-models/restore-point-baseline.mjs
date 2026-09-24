// Latest known-good local build, used only as a comparison baseline for CLI drift findings.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const directory = process.env.CONDUCTOR_LOCAL_UPDATES_DIR
  || (process.env.APPDATA ? resolve(process.env.APPDATA, 'Conductor', 'local-updates') : '')
let points = []
try {
  const value = JSON.parse(readFileSync(resolve(directory, 'restore-points.json'), 'utf8'))
  if (value?.schemaVersion === 1 && Array.isArray(value.points)) points = value.points
} catch {}
const known = points.filter(point => point?.knownGood === true && typeof point.version === 'string' && point.cliVersions)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null
console.log(JSON.stringify({ knownGood: known ? { version: known.version, createdAt: known.createdAt, commit: known.commit ?? null, cliVersions: known.cliVersions } : null }, null, 2))
