import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { StandingGrant } from '../../../shared/permission-grants'
import { usePermissionGrants } from './permission-grants/PermissionGrantCard'
import './PermissionsSettings.css'

const when = (iso: string | undefined): string => {
  const date = iso ? new Date(iso) : undefined
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}

/**
 * Settings > Permissions: every call the owner chose "Always allow" for on a permission card
 * (src/main/permission-grants, StandingGrant). Each is one exact command or file for one project's
 * Claude conversations; Revoke ends it at once, and the next such call asks again.
 */
export function PermissionsSettings(): React.JSX.Element {
  const state = usePermissionGrants()
  const [projects, setProjects] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    void window.conductor.projects.list().then(list => setProjects(new Map(list.map(project => [project.id, project.name])))).catch(() => undefined)
  }, [])
  const standing = [...(state.standing ?? [])].sort((a, b) => (projects.get(a.projectId) ?? a.projectId).localeCompare(projects.get(b.projectId) ?? b.projectId) || b.grantedAt.localeCompare(a.grantedAt))
  const revoke = (entry: StandingGrant): void => {
    setBusy(entry.id); setError(undefined)
    void window.conductor.permissionGrants.revokeStanding(entry.id)
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(undefined))
  }
  return <section className="permissions-settings">
    <div className="settings-section-title"><ShieldCheck size={14} /><div><strong>Always allowed</strong><span>Exact commands and files you chose "Always allow" for on a permission card. They run without asking in that project's Claude conversations.</span></div></div>
    {error && <p className="permissions-settings-error" role="alert">{error}</p>}
    {!standing.length && <p className="permissions-settings-empty">Nothing yet. Choose "Always allow" on a permission card to stop being asked for that exact command or file.</p>}
    {standing.length > 0 && <ol className="permissions-settings-list">
      {standing.map(entry => <li key={entry.id} className="permissions-settings-entry" data-standing-id={entry.id}>
        <div className="permissions-settings-head">
          <strong title={entry.projectId}>{projects.get(entry.projectId) ?? entry.projectId}</strong>
          <small>{entry.tool} · {entry.class} · {when(entry.grantedAt)} by {entry.decidedBy === 'wizard' ? 'a wizard tab' : 'you'}{entry.uses ? ` · used ${entry.uses}×, last ${when(entry.lastUsedAt)}` : ''}</small>
          <button type="button" disabled={busy === entry.id} onClick={() => revoke(entry)}>Revoke</button>
        </div>
        <code className="permissions-settings-rule">{entry.resource}</code>
      </li>)}
    </ol>}
  </section>
}
