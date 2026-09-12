import { LOCAL_MACHINE_ID } from '../../shared/remote-control'
import { openWorkspaceFile } from './components/workspace-files-state'
import { statMachineFile } from './remote-files'

interface ConversationFileOpenRequest {
  machineId: string
  projectId: string
  path: string
  line?: number
}

interface ConversationFileOpenDependencies {
  stat(machineId: string, projectId: string, path: string): Promise<{ isFile: boolean }>
  openRemote(machineId: string, projectId: string, path: string, line?: number): void
  openLocal(path: string, line?: number): void
}

const defaults: Omit<ConversationFileOpenDependencies, 'openLocal'> = {
  stat: statMachineFile,
  openRemote: (machineId, projectId, path, line) => openWorkspaceFile(projectId, path, 'editor', line, undefined, machineId)
}

/**
 * Routes a file click from the durable conversation owner. Only an explicit `local` may delegate
 * to legacy local UI routing; unresolved and remote values must cross the guarded remote bridge.
 * The request is captured before the await so a late session-context reply cannot retarget it.
 */
export async function openConversationFile(
  request: ConversationFileOpenRequest,
  openLocal: ConversationFileOpenDependencies['openLocal'],
  dependencies: Omit<ConversationFileOpenDependencies, 'openLocal'> = defaults
): Promise<void> {
  const captured = { ...request }
  if (captured.machineId === LOCAL_MACHINE_ID) {
    openLocal(captured.path, captured.line)
    return
  }
  const info = await dependencies.stat(captured.machineId, captured.projectId, captured.path)
  if (!info.isFile) throw new Error('That path is not a file.')
  dependencies.openRemote(captured.machineId, captured.projectId, captured.path, captured.line)
}
