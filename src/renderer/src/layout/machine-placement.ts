import type { AgentProviderId, PaneKind, PaneTab, ProjectRecord } from '../../../shared/models'
import { localModelLabel } from '../../../shared/local-models'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import { createPaneTab } from '../panes/pane-factory'

/**
 * Which kinds of tab can run somewhere other than the window showing them.
 *
 * Terminals travel now. A terminal is still a process on exactly one machine - that has not
 * changed and is the whole reason it needs saying - but the host can own that process and stream
 * its bytes here, which is what `terminals.open` does. The pane is unchanged: it keeps using the
 * ordinary terminal:* channels with a local id that the main process routes to the host.
 */
export function travels(kind: PaneKind): boolean { return kind === 'agent' || kind === 'terminal' }

/** Where a tab runs. Absent state means it has always run on this machine. */
export function tabMachineId(tab: Pick<PaneTab, 'state'>): string {
  const value = tab.state?.machineId
  return typeof value === 'string' && value ? value : LOCAL_MACHINE_ID
}

/** The terminal on the host a placed terminal tab is bound to, so reopening it finds the same shell. */
export function tabRemoteTerminalId(tab: Pick<PaneTab, 'state'>): string | null {
  const value = tab.state?.remoteTerminalId
  return typeof value === 'string' && value ? value : null
}

/**
 * The machine a project's work has to run on, or null when the owner may choose.
 *
 * A project that lives on another machine has exactly one answer, and it is not a preference: the
 * files, the git history, the tooling and the processes are all there. Offering "this machine" for
 * it would be offering to run against a folder that either does not exist here or, far worse, is a
 * different working copy at the same path.
 */
export function requiredMachineId(project: Pick<ProjectRecord, 'remote'> | null | undefined): string | null {
  const machineId = project?.remote?.machineId
  return typeof machineId === 'string' && machineId ? machineId : null
}

/** The host's name, for the sentences that have to name it. */
export function projectHostName(project: Pick<ProjectRecord, 'remote'> | null | undefined): string {
  return project?.remote?.machineName || 'that machine'
}

/**
 * Whether a machine may be chosen for this project, with the reason when it may not. Empty message
 * means yes. The refusal names the host, because "not available here" without saying where the work
 * actually is turns a clear constraint into a puzzle.
 */
export function checkProjectPlacement(
  project: Pick<ProjectRecord, 'remote'> | null | undefined,
  machineId: string,
  machineName = 'that machine'
): { ok: boolean; message: string } {
  const required = requiredMachineId(project)
  if (required) {
    if (machineId === required) return { ok: true, message: '' }
    const host = projectHostName(project)
    return machineId === LOCAL_MACHINE_ID
      ? { ok: false, message: `This project lives on ${host}. Its work runs there; this computer has no copy of it.` }
      : { ok: false, message: `This project lives on ${host}, so it cannot be run on another machine from here.` }
  }
  // The other half of the same rule, and the one that used to have an answer the owner had to
  // configure: a project of this computer's runs on this computer. A paired machine's projects are
  // in the same list under that machine's name, and that is where work meant for it goes.
  if (machineId === LOCAL_MACHINE_ID) return { ok: true, message: '' }
  return { ok: false, message: `This project is on this computer, so its work runs here. Open one of ${machineName}'s own projects to run work on ${machineName}.` }
}

/**
 * Where a workspace's work runs: the host for a project that lives on one, this computer for a
 * project of this computer's. It was once the owner's remembered choice per workspace; a project
 * now belongs to exactly one machine, so there is nothing left to remember and nothing that could
 * make a workspace of a local project open work somewhere else.
 */
export function defaultPlacement(project: Pick<ProjectRecord, 'remote'> | null | undefined): string {
  return requiredMachineId(project) ?? LOCAL_MACHINE_ID
}

/**
 * Closing a placed tab closes the work where it actually runs. The owner closed this tab, so the
 * other machine must not be left showing a pane nobody is watching; a machine that cannot be
 * reached is reported rather than retried, because the tab here is already gone.
 *
 * A terminal is deliberately not closed this way. Closing the view of a shell is not stopping the
 * shell - that rule is the same one that lets a reconnect resume it - so a placed terminal tab is
 * only unbound here and the process on the host keeps running until something stops it there.
 */
export function closePlacedTab(tab: PaneTab, report: (message: string) => void): void {
  if (tab.kind !== 'agent' || !tab.resourceId || tabMachineId(tab) === LOCAL_MACHINE_ID) return
  void window.conductor.remote.closeTab(tab.resourceId)
    .then(result => { if (result.message) report(`That machine was not told to close “${tab.title}”: ${result.message}`) })
    .catch((reason: unknown) => report(`That machine was not told to close “${tab.title}”: ${reason instanceof Error ? reason.message : String(reason)}`))
}

/** A terminal opened before the pane has measured itself still needs a shape; this is the shell's default. */
const DEFAULT_TERMINAL_SIZE = { cols: 80, rows: 24 }

export interface PlacedTabRequest {
  kind: PaneKind
  provider?: AgentProviderId
  /** A model the owner chose while creating the tab; only Local picks one up front. */
  model?: string
  machineId: string
  projectId: string
  sessionId: string
  /**
   * A terminal already running on that machine. Given one, the tab binds to that shell instead of
   * starting another - which is what a reopened tab and "attach to a terminal already running on
   * MAIN" both need. Leaving a stray shell behind on every reopen is the failure this prevents.
   */
  remoteTerminalId?: string
  cols?: number
  rows?: number
}

/**
 * Builds the tab for a chosen runtime, placing it on another machine when the owner asked for one.
 * The remote conversation or shell is created before the tab exists, so a machine that refuses the
 * placement leaves no dead tab behind for the owner to clean up.
 */
export async function createPlacedTab(request: PlacedTabRequest): Promise<PaneTab> {
  const { kind, provider, model, machineId, projectId, sessionId, remoteTerminalId } = request
  if (machineId === LOCAL_MACHINE_ID || !travels(kind)) return createPaneTab(kind, { provider, model })

  if (kind === 'terminal') {
    const terminals = window.conductor.remote.terminals
    const binding = remoteTerminalId
      ? await terminals.attach({ machineId, projectId, sessionId, remoteTerminalId })
      : await terminals.open({
        machineId, projectId, sessionId,
        cols: request.cols ?? DEFAULT_TERMINAL_SIZE.cols,
        rows: request.rows ?? DEFAULT_TERMINAL_SIZE.rows
      })
    // The pane drives `localTerminalId` through the ordinary terminal:* channels; the main process
    // is what knows that id leads to a shell on the host. The remote id is kept so reopening this
    // tab re-attaches to the same shell rather than starting another one beside it.
    return createPaneTab(kind, {
      machineId: binding.machineId,
      resourceId: binding.localTerminalId,
      remoteTerminalId: binding.remoteTerminalId,
      title: `Terminal · ${binding.machineName}`
    })
  }

  // The model travels with the request: a local model is chosen up front, and the machine that
  // runs it is the one that has to be asked for that exact model rather than its first one.
  const placed = await window.conductor.remote.openTab({
    machineId, projectId, sessionId, ...(provider ? { provider } : {}), ...(model ? { model } : {})
  })
  const runtime = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider === 'grok' ? 'Grok'
    : provider === 'local' ? localModelLabel(model) : provider ?? 'Agent'
  return createPaneTab(kind, {
    provider,
    model,
    machineId: placed.machineId,
    resourceId: placed.localSessionId,
    title: `${runtime} · ${placed.machineName}`
  })
}

/**
 * Re-binds a placed terminal tab that came back from a saved workspace. It always attaches and
 * never opens: the owner is looking at a tab they already had, and a second shell appearing behind
 * it - doing nothing, holding a cwd, costing a process on the host - is not a recovery.
 */
export async function reattachPlacedTerminal(tab: PaneTab, projectId: string, sessionId: string): Promise<PaneTab> {
  const machineId = tabMachineId(tab)
  const remoteTerminalId = tabRemoteTerminalId(tab)
  if (machineId === LOCAL_MACHINE_ID || !remoteTerminalId) return tab
  const binding = await window.conductor.remote.terminals.attach({ machineId, projectId, sessionId, remoteTerminalId })
  return { ...tab, resourceId: binding.localTerminalId, state: { ...tab.state, machineId, remoteTerminalId: binding.remoteTerminalId } }
}
