import type { AgentProviderId, PaneKind, PaneTab } from '../../../shared/models'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import { createPaneTab } from '../panes/pane-factory'

const KEY = 'conductor.machine-placement'

/**
 * The owner's last placement choice, per workspace. This is the renderer half of the same
 * inheritance rule the agents follow: work opened next stays on the machine the previous work was
 * put on, until the owner says otherwise. It is remembered per workspace rather than globally so
 * a laptop workspace and a render workspace do not keep overwriting each other's choice.
 */
export function readPlacement(sessionId: string): string {
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    const value = stored[sessionId]
    return typeof value === 'string' && value ? value : LOCAL_MACHINE_ID
  } catch { return LOCAL_MACHINE_ID }
}

export function writePlacement(sessionId: string, machineId: string): void {
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored, [sessionId]: machineId }))
  } catch { /* placement is a convenience; losing it must never block opening a tab */ }
}

/** A terminal is a process on the machine that owns it, so only agent tabs can be placed away. */
export function travels(kind: PaneKind): boolean { return kind === 'agent' }

/**
 * Builds the tab for a chosen runtime, placing it on another machine when the owner asked for one.
 * The remote conversation is created before the tab exists, so a machine that refuses the
 * placement leaves no dead tab behind for the owner to clean up.
 */
export async function createPlacedTab(request: {
  kind: PaneKind
  provider?: AgentProviderId
  /** A model the owner chose while creating the tab; only Local picks one up front. */
  model?: string
  machineId: string
  projectId: string
  sessionId: string
}): Promise<PaneTab> {
  const { kind, provider, model, machineId, projectId, sessionId } = request
  if (machineId === LOCAL_MACHINE_ID || !travels(kind)) return createPaneTab(kind, { provider, model })
  const placed = await window.conductor.remote.openTab({ machineId, projectId, sessionId, ...(provider ? { provider } : {}) })
  return createPaneTab(kind, {
    provider,
    model,
    machineId: placed.machineId,
    resourceId: placed.localSessionId,
    title: `${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider ?? 'Agent'} · ${placed.machineName}`
  })
}
