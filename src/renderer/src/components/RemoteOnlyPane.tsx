import { MonitorSmartphone } from 'lucide-react'
import type { PaneKind } from '../../../shared/models'

/**
 * What a pane shows for a project that lives on another machine and has no remote counterpart.
 *
 * The whole point of this state is that it is explicit. Git, memory, routines, logs and the local
 * model stack are all views of *this* computer, and a project on MAIN has none of them here. The
 * tempting alternative - run the pane against whatever is at the same path locally - is exactly
 * the failure keying a remote project by machine id exists to prevent: it would show a different
 * working copy's history, or an empty folder, with no sign that anything was wrong. So the pane
 * says which machine the project is on, and does nothing.
 */

const WHAT: Partial<Record<PaneKind, { title: string; because: string }>> = {
  diff: { title: 'Changes and diffs', because: 'Git runs where the working copy is.' },
  memory: { title: 'Memory', because: 'Memory is written by the agents that worked on that copy, and is read there.' },
  routine: { title: 'Routines', because: 'A routine runs commands, which happens on the machine that holds the project.' },
  logs: { title: 'Logs', because: 'These are this computer’s own logs.' },
  preview: { title: 'Preview', because: 'A preview reads the file from this computer’s disk. Open the file in the editor instead, which goes through the host.' }
}

export function RemoteOnlyPane({ kind, machineName }: { kind: PaneKind; machineName: string }): React.JSX.Element {
  const what = WHAT[kind] ?? { title: kind, because: 'It reads this computer’s own state.' }
  return (
    <div className="coming-pane remote-only-pane">
      <span><MonitorSmartphone size={13} /> {what.title}</span>
      <strong>Not available for a project on {machineName}</strong>
      <small>{what.because} Open this project in Conductor on {machineName} to use it there.</small>
    </div>
  )
}
