import { useEffect, useRef } from 'react'
import type { AgentSpec, PaneTab, ProjectRecord, SessionRecord } from '../../../shared/models'
import { suspendedConversationSpec } from './tab-keep-alive'

/** The spec main was last given per conversation in this window, so an unchanged one is not re-sent. */
const registered = new Map<string, string>()

const announce = (id: string, phase: string): void => {
  window.dispatchEvent(new CustomEvent('conductor:agent-activity', { detail: { id, phase } }))
}

/**
 * Stands in for the panes of a group's suspended conversations (see tab-keep-alive.ts).
 *
 * A mounted StructuredAgentPane registers its conversation with main on mount and again when the
 * workspace's continuation setting changes; that registration is what re-arms a usage-limit wait
 * persisted across a restart and keeps continue-on-limit current. This does the same for the
 * conversations whose views are not mounted, with the identical spec.
 *
 * A mounted pane also reports its phase through `conductor:agent-activity`, which the tab strip,
 * the sidebar and the restart-to-update gate follow. For a suspended conversation that report is
 * seeded from main's recorded phase and then follows main's own `agent:status` broadcasts.
 */
export function useSuspendedConversations(tabs: readonly PaneTab[], mounted: ReadonlySet<string>, project: ProjectRecord, session: SessionRecord): void {
  const specs = tabs.flatMap(tab => {
    if (mounted.has(tab.id)) return []
    const spec = suspendedConversationSpec(tab, project, session)
    return spec ? [spec] : []
  })
  const signature = JSON.stringify(specs)
  const suspendedIds = useRef(new Set<string>())

  useEffect(() => {
    const current = JSON.parse(signature) as AgentSpec[]
    const previous = suspendedIds.current
    suspendedIds.current = new Set(current.map(spec => spec.id))
    for (const spec of current) {
      const key = JSON.stringify(spec)
      if (registered.get(spec.id) === key) continue
      registered.set(spec.id, key)
      void window.conductor.agents.ensure(spec).catch(() => {
        // The next change or mount states it again; a registration is never worth an error here.
        if (registered.get(spec.id) === key) registered.delete(spec.id)
      })
    }
    const newlySuspended = current.map(spec => spec.id).filter(id => !previous.has(id))
    if (!newlySuspended.length) return
    // A broadcast that lands while the seed is in flight is newer than the seed.
    const heard = new Set<string>()
    const off = window.conductor.agents.onStatus(event => { if (event.phase) heard.add(event.id) })
    void window.conductor.agents.activityPhases(newlySuspended).then(phases => {
      // Only conversations still suspended here: a selected one reports for itself again.
      for (const [id, phase] of Object.entries(phases)) if (!heard.has(id) && suspendedIds.current.has(id)) announce(id, phase)
    }).catch(() => { /* Indicators then follow the next broadcast. */ }).finally(off)
  }, [signature])

  useEffect(() => {
    const off = window.conductor.agents.onStatus(event => {
      if (event.phase && suspendedIds.current.has(event.id)) announce(event.id, event.phase)
    })
    // An unmounted group reports nothing more, including a seed still in flight.
    return () => { off(); suspendedIds.current = new Set() }
  }, [])
}
