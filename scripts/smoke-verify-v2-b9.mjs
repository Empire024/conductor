import { spawnSync } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
console.log('[step] running smoke-conversation-followup.mjs')
const b9 = spawnSync(process.execPath, ['scripts/smoke-conversation-followup.mjs'], { encoding: 'utf8', timeout: 180000 })
console.log('[step] finished, status=' + b9.status)
await writeFile(resolve(output, 'b9-result.json'), JSON.stringify({ status: b9.status, stdout: (b9.stdout || '').slice(-4000), stderr: (b9.stderr || '').slice(-4000) }, null, 2))
process.exit(0)
