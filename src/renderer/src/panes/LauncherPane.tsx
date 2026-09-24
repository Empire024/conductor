import { useEffect, useState } from 'react'
import { ProviderIcon } from '../components/ProviderIcon'
import {
  Bot,
  ChevronRight,
  MonitorSmartphone,
  Plug,
  RefreshCw,
  Sparkles,
  TerminalSquare
} from 'lucide-react'
import { LOCAL_MODELS } from '../../../shared/local-models'
import type { AgentProviderId, PaneKind, ProjectRecord } from '../../../shared/models'
import type { MachineDescriptor } from '../../../shared/remote-control'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import type { RemoteTerminalSummary } from '../../../shared/remote-terminals'
import { checkRemoteProjectPlacement } from '../../../shared/project-identity'
import { checkProjectPlacement, requiredMachineId } from '../layout/machine-placement'
import { DurableJobLauncherOption } from '../components/DurableJobsPane'

interface LauncherPaneProps {
  projectId: string
  /** The project itself, so one that lives on another machine can only be launched there. */
  project?: Pick<ProjectRecord, 'remote'>
  /** The machine a new tab should run on; the caller remembers the owner's last choice. */
  machineId?: string
  /** A placement the other machine refused, shown where the choice was made. */
  error?: string
  onSelectMachine?(machineId: string): void
  onOpen(kind: PaneKind, provider?: AgentProviderId, model?: string): void
  workspaceId?: string
  onOpenJob?(job: { id: string; title: string }): void
  /** Binds a tab to a shell already running on that machine instead of starting another. */
  onAttachTerminal?(machineId: string, remoteTerminalId: string, title: string): void
}

const choices: Array<{
  kind: PaneKind
  provider?: AgentProviderId
  /** Providers whose model is chosen when the session is created rather than in the composer. */
  model?: string
  icon: typeof Bot
  title: string
  /** Second line, naming the family a runtime belongs to when its title alone does not. */
  detail?: string
  tone: string
  key: string
}> = [
  { kind: 'agent', provider: 'claude', icon: Sparkles, title: 'Claude Code', tone: 'amber', key: 'C' },
  { kind: 'agent', provider: 'codex', icon: Bot, title: 'Codex', tone: 'green', key: 'X' },
  { kind: 'agent', provider: 'grok', icon: Sparkles, title: 'Grok', tone: 'gray', key: 'R' },
  ...LOCAL_MODELS.map((model, index) => ({
    kind: 'agent' as PaneKind, provider: 'local' as AgentProviderId, model: model.id, icon: Bot,
    title: model.label, detail: 'Local model', tone: 'cyan', key: index === 0 ? 'L' : ''
  })),
  { kind: 'agent', provider: 'qwen', icon: Bot, title: 'Qwen Code', tone: 'cyan', key: 'Q' },
  { kind: 'agent', provider: 'kimi', icon: Sparkles, title: 'Kimi Code', tone: 'violet', key: 'K' },
  { kind: 'agent', provider: 'gemini', icon: Sparkles, title: 'Gemini CLI', tone: 'blue', key: 'G' },
  { kind: 'terminal', icon: TerminalSquare, title: 'PowerShell', tone: 'blue', key: 'T' }
]

/**
 * Where a tab in this project can run, and why not, machine by machine.
 *
 * There is one rule and it is not a preference: a project belongs to the computer whose disk holds
 * it. A project of this computer's runs here; a project that lives on a paired machine runs there
 * and nowhere else. Every other machine is listed disabled with the reason rather than hidden,
 * because "my desktop is missing from the list" is a worse puzzle than being told why.
 *
 * What used to be here - a project here mapped onto a project there, so both were offered and the
 * owner had to remember which mapping they confirmed - is gone. Both machines' projects are in the
 * one list, each marked with the machine it is on, so the choice is made by opening a project.
 */
export function machinePlacementOptions(
  machines: MachineDescriptor[],
  projectId: string,
  project?: Pick<ProjectRecord, 'remote'>
): Array<{ machine: MachineDescriptor; reason: string }> {
  return machines
    .filter(machine => machine.status !== 'revoked')
    .map(machine => {
      const scoped = checkProjectPlacement(project, machine.id, machine.name)
      if (!scoped.ok) return { machine, reason: scoped.message }
      if (machine.kind === 'local') return { machine, reason: '' }
      if (machine.status !== 'online') return { machine, reason: `${machine.name} is offline.` }
      // The host of a project that lives there still has to be the machine still sharing it: a
      // project swapped, moved or unshared over there must stop work going to it, not silently
      // land in whatever now sits at that id.
      const link = machine.projects.find(entry => entry.grant.localProjectId === projectId)
      const placement = checkRemoteProjectPlacement({ machineName: machine.name, grant: link?.grant, advertised: link?.observed })
      return { machine, reason: placement.ok ? '' : placement.message }
    })
}

export function LauncherPane({ projectId, project, machineId, error, onSelectMachine, onOpen, workspaceId, onOpenJob, onAttachTerminal }: LauncherPaneProps): React.JSX.Element {
  const [machines, setMachines] = useState<MachineDescriptor[]>([])
  const [checking, setChecking] = useState(false)
  const [running, setRunning] = useState<RemoteTerminalSummary[] | null>(null)
  const [runningError, setRunningError] = useState('')
  const [durableModel, setDurableModel] = useState(LOCAL_MODELS[0]!)
  const [creatingJob, setCreatingJob] = useState(false)
  const [jobError, setJobError] = useState('')
  const host = requiredMachineId(project)
  const selected = host ?? machineId ?? LOCAL_MACHINE_ID

  useEffect(() => {
    let live = true
    const read = (): void => { void window.conductor.remote.machines().then(list => { if (live) setMachines(list) }).catch(() => { if (live) setMachines([]) }) }
    read()
    // A paired machine's status is otherwise only whatever the last real call happened to find, so
    // opening the launcher asks what is reachable now rather than showing a machine as unavailable
    // because of one blip that nothing has retried since.
    void window.conductor.remote.refreshMachines().then(list => { if (live) setMachines(list) }).catch(() => undefined)
    // Pairing or a machine coming online changes what this list may offer.
    const stop = window.conductor.remote.onState(read)
    return () => { live = false; stop() }
  }, [])

  const checkAgain = (): void => {
    setChecking(true)
    void window.conductor.remote.refreshMachines()
      .then(setMachines)
      .catch(() => undefined)
      .finally(() => setChecking(false))
  }

  const options = machinePlacementOptions(machines, projectId, project)
  const current = options.find(option => option.machine.id === selected)
  const unavailable = options.filter(option => option.reason && option.machine.id !== selected)
  // A project belongs to one machine, so there is usually exactly one answer here and the picker
  // states it rather than offering a list of options that cannot be chosen.
  const settled = options.filter(option => !option.reason).length <= 1
  // Placement is only worth showing once there is somewhere else to place work, or once the
  // project's own machine is the answer and the owner should be told which one that is.
  const placeable = options.length > 1 || Boolean(host)
  const hostName = current?.machine.name ?? project?.remote?.machineName ?? 'that machine'

  /**
   * Which project id to name when talking to the host - the same single rule `createPlacedTab`
   * follows, so the terminal the owner attaches to and the terminal the tab opens are scoped
   * identically. A project *paired* between two copies is named by our id and mapped through the
   * grant in the main process, exactly as `openTab` has always done. A project that *lives* there
   * has no grant to map through, so it is named by the host's own id, which its origin carries.
   */
  const hostProjectId = project?.remote?.remoteProjectId ?? projectId

  const listRunning = (): void => {
    if (selected === LOCAL_MACHINE_ID) return
    setRunningError('')
    void window.conductor.remote.terminals.list({ machineId: selected, projectId: hostProjectId, sessionId: '' })
      .then(setRunning)
      .catch((reason: unknown) => { setRunning([]); setRunningError(reason instanceof Error ? reason.message : String(reason)) })
  }

  return (
    <div className="launcher-pane">
      {placeable && (
        <div className="launcher-placement">
          <label htmlFor="launcher-machine"><MonitorSmartphone size={13} /> Run on</label>
          <select
            id="launcher-machine"
            value={selected}
            disabled={Boolean(host) || settled}
            onChange={event => onSelectMachine?.(event.target.value)}
          >
            {options.map(({ machine, reason }) => (
              <option key={machine.id} value={machine.id} disabled={Boolean(reason)}>
                {machine.name}{machine.kind === 'local' ? ' (this machine)' : ''}{reason ? ' — unavailable' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="launcher-placement-recheck"
            disabled={checking}
            title="Ask every paired machine whether it is reachable now"
            onClick={checkAgain}
          >
            <RefreshCw size={12} className={checking ? 'spinning' : undefined} /> Check again
          </button>
          <small className={error ? 'launcher-placement-error' : undefined}>
            {error
              || current?.reason
              || (host
                ? `This project lives on ${hostName}. Everything you open here runs there.`
                : selected === LOCAL_MACHINE_ID
                  ? settled && options.length > 1
                    ? 'This project is on this computer, so new tabs run here. Another machine’s projects are in your project list under its name.'
                    : 'New tabs run here.'
                  : `New tabs run on ${hostName}; you drive them from this window.`)}
          </small>
          {/* A disabled option cannot be selected, so its reason would never be readable anywhere.
              Saying "unavailable" without saying why is the puzzle this list exists to avoid. */}
          {unavailable.length > 0 && !host && !settled && (
            <ul className="launcher-placement-reasons">
              {unavailable.map(({ machine, reason }) => <li key={machine.id}>{reason}</li>)}
            </ul>
          )}
        </div>
      )}
      <div className="launcher-grid" aria-label="Open runtime">
        {choices.map(({ kind, provider, model, icon: Icon, title, detail, tone, key }) => {
          // Agents and terminals both travel: the host owns the process and streams it here. Only
          // the providers whose conversations this app can journal can be mirrored. A local model
          // travels as a conversation: the weights and servers stay on the machine that is asked
          // to run it, which is how another device reaches a stack it does not have.
          const elsewhere = selected !== LOCAL_MACHINE_ID
          const mirrorable = provider === 'claude' || provider === 'codex' || provider === 'grok' || provider === 'local'
          const blocked = Boolean(current?.reason) || (elsewhere && kind === 'agent' && !mirrorable)
          return (
            <button
              key={`${kind}-${provider ?? ''}-${model ?? ''}`}
              disabled={blocked}
              title={blocked ? (current?.reason || `${title} cannot run on another machine yet.`) : undefined}
              onClick={() => onOpen(kind, provider, model)}
            >
              <span className={`launch-icon ${tone}`}>{provider ? <ProviderIcon provider={provider} size={21} /> : <Icon size={19} />}</span>
              <span><strong>{title}</strong>{detail && <small>{detail}{elsewhere && mirrorable ? ` · runs on ${hostName}` : provider === 'local' ? ' · runs on this machine' : ''}</small>}</span>
              {key && <kbd>{key}</kbd>}
              <ChevronRight className="launch-arrow" size={15} />
            </button>
          )
        })}
      </div>
      {selected === LOCAL_MACHINE_ID && onOpenJob && <div className="launcher-durable-option">
        <label>Local model for durable work<select aria-label="Durable job local model" value={durableModel.id} onChange={event => setDurableModel(LOCAL_MODELS.find(model => model.id === event.target.value) ?? LOCAL_MODELS[0]!)}>
          {LOCAL_MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select></label>
        <DurableJobLauncherOption model={durableModel} busy={creatingJob} error={jobError} onCreate={input => {
          setCreatingJob(true); setJobError('')
          void window.conductor.durableJobs.create({ projectId, ...(workspaceId ? { workspaceId } : {}), ...input })
            .then(summary => onOpenJob({ id: summary.id, title: summary.title }))
            .catch(reason => setJobError(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => setCreatingJob(false))
        }} />
      </div>}
      {/*
        A shell on the host outlives the tab that was watching it - closing a view is not stopping a
        process - so after a reconnect, a restart or a closed tab there may well be one still
        running with the owner's build in it. Without this, the only way back to it is to start a
        second shell beside it and wonder why the first one still holds the port.
      */}
      {selected !== LOCAL_MACHINE_ID && !current?.reason && onAttachTerminal && (
        <div className="launcher-attach">
          <button type="button" onClick={listRunning}>
            <Plug size={13} /> Attach to a terminal already running on {hostName}
          </button>
          {runningError && <small className="launcher-placement-error">{runningError}</small>}
          {running !== null && running.length === 0 && !runningError && <small>No terminals are running on {hostName} for this project.</small>}
          {running !== null && running.length > 0 && (
            <ul className="launcher-attach-list">
              {running.map(terminal => (
                <li key={terminal.terminalId}>
                  <button type="button" onClick={() => onAttachTerminal(selected, terminal.terminalId, terminal.title)}>
                    <TerminalSquare size={13} />
                    <span><strong>{terminal.title || 'Shell'}</strong><small>{terminal.cwd}{terminal.running ? '' : ` · exited${terminal.exitCode === null ? '' : ` (${terminal.exitCode})`}`}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
