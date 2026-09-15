import { useEffect, useState } from 'react'
import { Laptop, MonitorSmartphone, Unplug } from 'lucide-react'
import type { MachineDescriptor } from '../../../shared/remote-control'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import { describeExecutionTarget, executionTargetSummary } from './execution-target'
import './ExecutionTargetChip.css'

/**
 * Where the work you are about to start will actually happen, always visible beside the composer.
 *
 * Two computers running the same UI over the same projects is exactly the situation in which a
 * command lands on the wrong machine, and the cost is not symmetric: a build fired at the laptop
 * instead of the desktop is a slow annoyance, while an `rm` or a migration fired at MAIN instead
 * of the laptop is not. So this is persistent rather than a hover, and it names the machine rather
 * than merely colouring itself.
 *
 * It repeats the transport's own answer and nothing else: Direct or Relayed only when
 * `connection.path` says so, and "over Tailscale" only for a genuinely Tailscale transport.
 */
export function ExecutionTargetChip({ machineId, localName }: { machineId: string; localName?: string }): React.JSX.Element {
  const [machines, setMachines] = useState<MachineDescriptor[]>([])

  useEffect(() => {
    let live = true
    const read = (): void => { void window.conductor.remote.machines().then(list => { if (live) setMachines(list) }).catch(() => { if (live) setMachines([]) }) }
    read()
    // Attaching, detaching and a host dropping all arrive as remote state, so the chip is never a
    // stale reading of where work went several minutes ago.
    const stop = window.conductor.remote.onState(read)
    return () => { live = false; stop() }
  }, [])

  const target = describeExecutionTarget(machines, machineId, localName)
  // With no second machine anywhere there is no ambiguity to resolve, and a permanent "Local:"
  // badge would be noise in the one setup where it can never be wrong.
  if (target.local && machines.filter(machine => machine.id !== LOCAL_MACHINE_ID).length === 0) return <></>

  const Icon = target.detached ? Unplug : target.local ? Laptop : MonitorSmartphone
  return (
    <div
      className={`execution-target ${target.local ? 'is-local' : 'is-remote'} ${target.detached ? 'is-detached' : ''} ${target.state === 'Offline' ? 'is-offline' : ''}`}
      title={target.detail}
      aria-label={`${target.label} — ${executionTargetSummary(target)}`}
    >
      <Icon size={12} />
      <strong>{target.label}</strong>
      <small>{executionTargetSummary(target)}</small>
    </div>
  )
}
