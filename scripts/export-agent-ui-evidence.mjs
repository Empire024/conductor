import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Explicit local evidence only; never starts Electron or a provider.
function sanitize(value) {
  if (typeof value === 'string') return value
    .replace(/C:\\Users\\[^\\\r\n]+/gi, 'C:\\Users\\OWNER')
    .replace(/C:\/Users\/[^/\r\n]+/gi, 'C:/Users/OWNER')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|api_?key|access_?token|refresh_?token|password|secret|env|environment)$/i.test(key) ? '[REDACTED]' : sanitize(item)]))
  return value
}
const sources = [
  { source: 'artifacts/local-update-ui', target: 'docs/evidence/local-updates', images: ['local-update-pending.png'] },
  { source: 'artifacts/live-codex/replacement-a-preflight-4', target: 'docs/evidence/agent-ui/live-codex-replacement', images: ['live-a.png', 'live-diff.png'] }
]
for (const entry of sources) {
  const result = sanitize(JSON.parse(await readFile(resolve(entry.source, 'results.json'), 'utf8')))
  result.screenshots = entry.images
  await mkdir(resolve(entry.target), { recursive: true })
  await writeFile(resolve(entry.target, 'results.json'), JSON.stringify(result, null, 2) + '\n')
  for (const name of entry.images) await copyFile(join(entry.source, name), join(entry.target, name))
  console.log(entry.target)
}
