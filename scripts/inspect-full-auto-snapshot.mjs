// Read-only, redacted diagnosis of a disposable Full Auto fixture conversation.
import { DatabaseSync } from 'node:sqlite'

const [databasePath, agentSessionId] = process.argv.slice(2)
if (!databasePath || !/^agent_[a-z0-9_]+$/i.test(agentSessionId ?? '')) throw new Error('Usage: node scripts/inspect-full-auto-snapshot.mjs <fixture conductor.db> <agentSessionId>')
const database = new DatabaseSync(databasePath, { readOnly: true })
try {
  const row = database.prepare('SELECT projection_json FROM structured_sessions WHERE id=?').get(agentSessionId)
  if (!row) throw new Error('No such disposable fixture conversation')
  const state = JSON.parse(row.projection_json)
  const settings = state.settings ?? {}
  const effective = state.capabilities?.effectiveSettings ?? {}
  const last = database.prepare('SELECT event_json FROM structured_events WHERE session_id=? ORDER BY sequence DESC LIMIT 1').get(agentSessionId)
  const lastEvent = last ? JSON.parse(last.event_json) : null
  console.log(JSON.stringify({
    agentSessionId,
    phase: state.phase,
    runtimeId: state.runtimeId ?? null,
    nativeSessionIdPresent: Boolean(state.nativeSessionId),
    sequence: state.sequence,
    settings: { permission: settings.permission ?? null, plan: settings.plan ?? null, claudeGuardedAuto: settings.claudeGuardedAuto ?? null },
    effective: Object.fromEntries(['requestedPermissionMode', 'permissionMode', 'permissionModeStatus', 'permissionModeError', 'claudeFullAutoAuthorized'].map(key => [key, effective[key] ?? null])),
    itemCount: state.items?.length ?? 0,
    lastEvent: lastEvent ? { sequence: lastEvent.sequence, type: lastEvent.data?.type ?? null, phase: lastEvent.data?.phase ?? null, nativeMethod: lastEvent.native?.method ?? null } : null
  }, null, 2))
} finally {
  database.close()
}
