import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEventData } from '../shared/structured-agent'
import type { PhoneActivityItem, PhoneActivityKind, PhoneActivityPage } from '../shared/phone-activity'

export const ACTIVITY_WINDOW_MS = 7 * 86400000
export const ACTIVITY_KINDS: PhoneActivityKind[] = ['email', 'deployment', 'production', 'commit', 'update', 'approval', 'task']
type Receipt = Pick<PhoneActivityItem, 'kind' | 'title' | 'detail'> & { key?: string }
const line = (value: string, size = 240): string => value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, size)

/** Only completed facts qualify. A command mentioning send/deploy is not a receipt. */
export function activityReceipt(data: AgentEventData): Receipt | null {
  if (data.type === 'interaction' && data.interaction.status === 'resolved') return {
    kind: 'approval', title: 'Answered: ' + line(data.interaction.title || 'Request'),
    detail: line(data.interaction.outcome || 'Answered in Conductor')
  }
  if (data.type !== 'tool' || data.status !== 'completed' || (data.exitCode !== undefined && data.exitCode !== 0)) return null
  const output = (data.output || '').slice(-24000)
  const explicit = /^ACTIVITY_RECEIPT:\s*(\{[^\r\n]+\})$/m.exec(output)
  if (explicit) {
    try {
      const value = JSON.parse(explicit[1]!) as Record<string, unknown>
      if (ACTIVITY_KINDS.includes(value.kind as PhoneActivityKind) && typeof value.title === 'string' && value.title.trim() && typeof value.key === 'string' && value.key) return { kind: value.kind as PhoneActivityKind, title: line(value.title), key: value.key.slice(0, 200), ...(typeof value.detail === 'string' ? { detail: line(value.detail, 600) } : {}) }
    } catch { /* Malformed output is not a receipt. */ }
  }
  const sent = /^SENT:\s*(.+)$/m.exec(output)
  const message = /Message-ID\s*:?\s*(<[^>\r\n]+>)[^\r\n]*recipients:\s*([^\r\n]+)/i.exec(output)
  if (sent && message) return { kind: 'email', key: 'email:' + message[1], title: 'Sent email to ' + line(message[2]!), detail: 'SMTP receipt ' + line(sent[1]!, 160) + ' · Message-ID ' + message[1] }
  // Structured tool results are accepted only with their explicit terminal success word.
  const raw = data.input
  const input = typeof raw === 'string' ? raw.slice(0, 4000) : raw && typeof raw === 'object' && !Array.isArray(raw)
    ? [raw.method, raw.command, raw.cmd].filter(value => typeof value === 'string').map(value => String(value).slice(0, 1200)).join(' ') : ''
  const method = data.name + ' ' + input
  if (/production\.(run|retest|verify|audit|status)/.test(method) && /"status"\s*:\s*"completed"/.test(output)) return { kind: 'production', title: 'Production run completed', detail: 'Completed result recorded by Conductor.' }
  if (/\bdeploy\b/i.test(method) && /(?:Deployment complete|Successfully deployed|"status"\s*:\s*"(?:deployed|ready)")/i.test(output)) return { kind: 'deployment', title: 'Deployment completed', detail: 'Deployment tool reported success.' }
  return null
}

/** Small indexed materialization beside the event journal. No query scans event_json. */
export class PhoneActivityStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS phone_activity (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
      at TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT, tab_title TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS phone_activity_time ON phone_activity(at DESC, id DESC);`)
  }
  record(entry: Omit<PhoneActivityItem, 'projectName'>): PhoneActivityItem {
    const at = new Date(entry.at).toISOString()
    this.db.prepare(`INSERT INTO phone_activity(id,kind,title,detail,at,project_id,session_id,tab_title)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(entry.id, entry.kind, line(entry.title), entry.detail ? line(entry.detail, 600) : null, at, entry.projectId, entry.sessionId, line(entry.tabTitle))
    return { ...entry, at, projectName: '' }
  }
  key(sessionId: string, key: string): string { return createHash('sha256').update(sessionId + '\0' + key).digest('hex') }
  list(now = Date.now(), before?: string): PhoneActivityPage {
    const since = new Date(now - ACTIVITY_WINDOW_MS).toISOString()
    const until = before && Number.isFinite(Date.parse(before)) ? new Date(Math.min(now + 1, Date.parse(before))).toISOString() : new Date(now + 1).toISOString()
    const rows = this.db.prepare(`SELECT a.*, p.name AS project_name FROM phone_activity a
      LEFT JOIN projects p ON p.id=a.project_id WHERE a.at>=? AND a.at<? ORDER BY a.at DESC,a.id DESC LIMIT 101`).all(since, until) as Array<Record<string, unknown>>
    return { since, hasMore: rows.length > 100, items: rows.slice(0, 100).map(row => ({
      id: String(row.id), kind: row.kind as PhoneActivityKind, title: String(row.title), at: String(row.at),
      projectId: String(row.project_id), projectName: String(row.project_name || 'Project'), sessionId: row.session_id ? String(row.session_id) : null,
      tabTitle: String(row.tab_title), ...(row.detail ? { detail: String(row.detail) } : {})
    })) }
  }
}
