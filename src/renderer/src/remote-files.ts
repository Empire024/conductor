import type { EditorFileWriteResult } from '../../shared/models'
import { LOCAL_MACHINE_ID } from '../../shared/remote-control'
import type { RemoteFileIdentity, RemoteFileStat } from '../../shared/remote-files'

export const fileMachineId = (machineId?: string): string => machineId || LOCAL_MACHINE_ID
export const isRemoteFileMachine = (machineId?: string): boolean => fileMachineId(machineId) !== LOCAL_MACHINE_ID

const identity = (machineId: string | undefined, projectId: string, path: string): RemoteFileIdentity => ({
  machineId: fileMachineId(machineId), projectId, path
})

/** Machine-scoped editor access. Remote failures deliberately never retry against local disk. */
export async function statMachineFile(machineId: string | undefined, projectId: string, path: string): Promise<RemoteFileStat | { size: number; isFile: boolean; modifiedAt: string }> {
  if (!isRemoteFileMachine(machineId)) return window.conductor.files.stat(projectId, path)
  return window.conductor.remote.files.stat(identity(machineId, projectId, path))
}

export async function readMachineFile(machineId: string | undefined, projectId: string, path: string, allowBinary = false): Promise<string | null> {
  if (!isRemoteFileMachine(machineId)) return window.conductor.files.readForEditor(projectId, path, allowBinary)
  return (await window.conductor.remote.files.read(identity(machineId, projectId, path))).content
}

export async function writeMachineFile(machineId: string | undefined, projectId: string, path: string, content: string, expectedContent?: string | null): Promise<EditorFileWriteResult> {
  if (!isRemoteFileMachine(machineId)) return window.conductor.files.write(projectId, path, content, expectedContent)
  return (await window.conductor.remote.files.write({ ...identity(machineId, projectId, path), content, expectedContent: expectedContent ?? null })).result
}
