import { useEffect, useState } from 'react'
import { ProviderIcon } from '../components/ProviderIcon'
import {
  Bot,
  ChevronRight,
  MonitorSmartphone,
  Sparkles,
  TerminalSquare
} from 'lucide-react'
import type { AgentProviderId, PaneKind } from '../../../shared/models'
import type { MachineDescriptor } from '../../../shared/remote-control'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'

interface LauncherPaneProps {
  /** The machine a new tab should run on; the caller remembers the owner's last choice. */
  machineId?: string
  /** A placement the other machine refused, shown where the choice was made. */
  error?: string
  onSelectMachine?(machineId: string): void
  onOpen(kind: PaneKind, provider?: AgentProviderId): void
}

const choices: Array<{
  kind: PaneKind
  provider?: AgentProviderId
  icon: typeof Bot
  title: string
  tone: string
  key: string
}> = [
  { kind: 'agent', provider: 'claude', icon: Sparkles, title: 'Claude Code', tone: 'amber', key: 'C' },
  { kind: 'agent', provider: 'codex', icon: Bot, title: 'Codex', tone: 'green', key: 'X' },
  { kind: 'agent', provider: 'qwen', icon: Bot, title: 'Qwen Code', tone: 'cyan', key: 'Q' },
  { kind: 'agent', provider: 'kimi', icon: Sparkles, title: 'Kimi Code', tone: 'violet', key: 'K' },
  { kind: 'agent', provider: 'gemini', icon: Sparkles, title: 'Gemini CLI', tone: 'blue', key: 'G' },
  { kind: 'terminal', icon: TerminalSquare, title: 'PowerShell', tone: 'blue', key: 'T' }
]

/**
 * Only a machine that is reachable and has this project mapped can run a tab. A machine that is
 * paired but has no confirmed project pair is shown disabled with the reason, rather than hidden,
 * because "my desktop is missing from the list" is a worse puzzle than being told what to fix.
 */
export function machinePlacementOptions(machines: MachineDescriptor[]): Array<{ machine: MachineDescriptor; reason: string }> {
  return machines
    .filter(machine => machine.status !== 'revoked')
    .map(machine => ({
      machine,
      reason: machine.kind === 'local' ? ''
        : machine.status !== 'online' ? `${machine.name} is offline.`
        : !machine.projects.length ? `${machine.name} has no project paired with this one yet. Pair it in Account & machines.`
        : ''
    }))
}

export function LauncherPane({ machineId, error, onSelectMachine, onOpen }: LauncherPaneProps): React.JSX.Element {
  const [machines, setMachines] = useState<MachineDescriptor[]>([])
  const selected = machineId ?? LOCAL_MACHINE_ID

  useEffect(() => {
    let live = true
    const read = (): void => { void window.conductor.remote.machines().then(list => { if (live) setMachines(list) }).catch(() => { if (live) setMachines([]) }) }
    read()
    // Pairing or a machine coming online changes what this list may offer.
    const stop = window.conductor.remote.onState(read)
    return () => { live = false; stop() }
  }, [])

  const options = machinePlacementOptions(machines)
  const current = options.find(option => option.machine.id === selected)
  // Placement is only worth showing once there is somewhere else to place work.
  const placeable = options.length > 1

  return (
    <div className="launcher-pane">
      {placeable && (
        <div className="launcher-placement">
          <label htmlFor="launcher-machine"><MonitorSmartphone size={13} /> Run on</label>
          <select
            id="launcher-machine"
            value={selected}
            onChange={event => onSelectMachine?.(event.target.value)}
          >
            {options.map(({ machine, reason }) => (
              <option key={machine.id} value={machine.id} disabled={Boolean(reason)}>
                {machine.name}{machine.kind === 'local' ? ' (this machine)' : ''}{reason ? ' — unavailable' : ''}
              </option>
            ))}
          </select>
          <small className={error ? 'launcher-placement-error' : undefined}>
            {error
              || current?.reason
              || (selected === LOCAL_MACHINE_ID
                ? 'New tabs run here.'
                : `New tabs run on ${current?.machine.name ?? 'that machine'}; you drive them from this window.`)}
          </small>
        </div>
      )}
      <div className="launcher-grid" aria-label="Open runtime">
        {choices.map(({ kind, provider, icon: Icon, title, tone, key }) => {
          // A terminal is a local process on the machine that owns it; only agent tabs travel, and
          // only the two providers whose conversations this app can journal can be mirrored.
          const elsewhere = selected !== LOCAL_MACHINE_ID
          const mirrorable = provider === 'claude' || provider === 'codex'
          const blocked = kind !== 'agent' ? elsewhere : Boolean(current?.reason) || (elsewhere && !mirrorable)
          return (
            <button
              key={`${kind}-${provider ?? ''}`}
              disabled={blocked}
              title={blocked ? (current?.reason || (kind === 'agent' ? `${title} cannot run on another machine yet.` : 'A terminal always runs on this machine.')) : undefined}
              onClick={() => onOpen(kind, provider)}
            >
              <span className={`launch-icon ${tone}`}>{provider ? <ProviderIcon provider={provider} size={21} /> : <Icon size={19} />}</span>
              <span><strong>{title}</strong></span>
              <kbd>{key}</kbd>
              <ChevronRight className="launch-arrow" size={15} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
