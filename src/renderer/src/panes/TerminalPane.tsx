import { useEffect, useState } from 'react'
import { SessionArchiveDormantPane } from '../components/SessionArchiveDormantPane'
import { RuntimeTerminal, type RuntimeTerminalProps } from './RuntimeTerminal'

export interface TerminalPaneProps extends RuntimeTerminalProps {
  archiveDormant?: boolean
  machineId?: string
  onArchiveActivated?(): void
}

export async function activateArchivedRuntime(
  kind: 'agent' | 'terminal',
  id: string,
  activated: () => void,
  activate: (kind: 'agent' | 'terminal', id: string) => Promise<void> = window.conductor.sessionArchive.activateResource
): Promise<void> {
  await activate(kind, id)
  activated()
}

/** Imported runtimes stop here until the owner explicitly chooses to reconnect or start a shell. */
export function TerminalPane({ archiveDormant = false, machineId = 'local', onArchiveActivated, ...runtime }: TerminalPaneProps): React.JSX.Element {
  const [dormant, setDormant] = useState(archiveDormant)
  useEffect(() => setDormant(archiveDormant), [archiveDormant, runtime.resourceId])
  const kind = runtime.mode === 'agent' ? 'agent' : 'terminal'
  if (dormant) return <SessionArchiveDormantPane kind={kind} title={runtime.title} machineId={machineId} onActivate={() => activateArchivedRuntime(kind, runtime.resourceId, () => {
    setDormant(false)
    onArchiveActivated?.()
  })} />
  return <RuntimeTerminal {...runtime} />
}
