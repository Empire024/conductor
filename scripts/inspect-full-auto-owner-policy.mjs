// Read-only owner-profile policy check. Supply only the running installed app's conductor.db path.
// Emits this one policy key and never dumps other settings, credentials or conversation content.
import { DatabaseSync } from 'node:sqlite'

const databasePath = process.argv[2]
if (!databasePath) throw new Error('Usage: node scripts/inspect-full-auto-owner-policy.mjs <installed conductor.db>')

const database = new DatabaseSync(databasePath, { readOnly: true })
try {
  const row = database.prepare('SELECT value, updated_at FROM settings WHERE key = ?').get('claudeFullAutoOwnerAuthorization:v1')
  let saved = null
  if (row) {
    try { saved = JSON.parse(row.value) } catch { saved = { malformed: true } }
  }
  const valid = saved && saved.version === 1 && saved.source === 'trusted-owner-control' && typeof saved.enabled === 'boolean' &&
    typeof saved.changedAt === 'string' && Number.isFinite(Date.parse(saved.changedAt)) &&
    (!saved.enabled || (typeof saved.authorizedAt === 'string' && Number.isFinite(Date.parse(saved.authorizedAt))))
  console.log(JSON.stringify({
    present: Boolean(row), valid: Boolean(valid), enabled: valid ? saved.enabled : false,
    source: valid ? saved.source : null, authorizedAt: valid ? saved.authorizedAt ?? null : null,
    changedAt: valid ? saved.changedAt : null, updatedAt: row?.updated_at ?? null
  }))
} finally {
  database.close()
}
