import { useEffect, useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import type { RemoteHostMirror, RemoteWorkspaceTabs } from '../../../shared/remote-control'
import { conversationsToOpen, mirrorOffLine, type RemoteConversationChoice } from '../layout/remote-workspace-tabs'

/**
 * The conversations a project's host is running, grouped by the host's workspaces, so a project
 * that lives on MAIN opens on the laptop showing MAIN's tabs rather than an empty workspace. Each
 * can be opened here on its own, or a whole workspace at once; one already shown here is marked
 * and left out of "Open all". The list follows the host: it is read again whenever MAIN's tabs change.
 */
export function RemoteConversationsList({ projectId, machineId, hostName, onOpen }: {
  projectId: string
  machineId: string
  hostName: string
  onOpen(choices: RemoteConversationChoice[]): void
}): React.JSX.Element | null {
  const [listing, setListing] = useState<RemoteWorkspaceTabs | null>(null)
  const [error, setError] = useState('')
  const [mirror, setMirror] = useState<RemoteHostMirror | null | undefined>(undefined)

  // Whether the host mirrors everything here: when it does, its conversations open by themselves
  // and this list is only the way back to one the owner closed; when it does not, one line says why.
  useEffect(() => {
    let live = true
    const take = (state: { hostMirrors?: Record<string, RemoteHostMirror | null> }): void => { if (live) setMirror(state.hostMirrors?.[machineId]) }
    void window.conductor.remote.state().then(take).catch(() => undefined)
    const stop = window.conductor.remote.onState(take)
    return () => { live = false; stop() }
  }, [machineId])
  const off = mirrorOffLine(hostName, mirror)
  const notice = off ? <small className="launcher-mirror-off" role="status">{off}</small> : null

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = (): void => {
      void window.conductor.remote.workspaceTabs(projectId)
        .then(result => { if (live) { setListing(result); setError('') } })
        .catch((reason: unknown) => { if (live) setError((reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) })
    }
    read()
    // A host opens and closes tabs in bursts (a swarm dispatching four coworkers); one read settles them.
    const stop = window.conductor.remote.onTabsChanged(event => {
      if (event.machineId !== machineId) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(read, 400)
    })
    return () => { live = false; stop(); if (timer) clearTimeout(timer) }
  }, [projectId, machineId])

  if (error) return <div className="launcher-attach launcher-remote-conversations">{notice}<small className="launcher-placement-error">Cannot list the tabs running on {hostName}: {error}</small></div>
  if (!listing) return <div className="launcher-attach launcher-remote-conversations">{notice}<small>Looking for tabs running on {hostName}…</small></div>
  const workspaces = listing.workspaces.filter(workspace => workspace.tabs.length)
  if (!workspaces.length) return <div className="launcher-attach launcher-remote-conversations">{notice}<small>No conversations are open on {hostName} for this project.</small></div>
  return (
    <div className="launcher-attach launcher-remote-conversations" aria-label={`Tabs running on ${hostName}`}>
      {notice}
      <small className="launcher-remote-heading">Tabs running on {hostName}{mirror?.mirror ? ' · mirrored here by themselves' : ''}</small>
      {workspaces.map(workspace => {
        const unopened = conversationsToOpen(workspace.id, workspace.tabs)
        return (
          <section key={workspace.id} className="launcher-remote-workspace">
            <header>
              <strong>{workspace.name}</strong>
              {unopened.length > 0 && (
                <button type="button" onClick={() => onOpen(unopened)}>Open all {unopened.length}</button>
              )}
            </header>
            <ul className="launcher-attach-list">
              {workspace.tabs.map(tab => (
                <li key={tab.agentSessionId}>
                  <button type="button" onClick={() => onOpen([{ remoteSessionId: workspace.id, tab }])}>
                    <MessagesSquare size={13} />
                    <span>
                      <strong>{tab.title}</strong>
                      <small>{tab.provider}{tab.phase ? ` · ${tab.phase.replaceAll('_', ' ')}` : ''}{tab.localSessionId ? ' · open here' : ''}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
