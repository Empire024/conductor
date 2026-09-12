import type { AgentSpec, DetachedWindowRecord, EditorDraft, ProjectRecord, SessionRecord, TerminalSpec, WorkspaceDocumentState, WorkspaceRecoveryState } from './models'
import type { SessionProjection } from './structured-agent'

export interface SessionArchive {
  format: 'conductor-session'
  version: 1
  name: string
  savedAt: string
  projects: ProjectRecord[]
  workspaces: SessionRecord[]
  detached: DetachedWindowRecord[]
  agents: Array<{ spec: AgentSpec; projection: SessionProjection | null; transcript: string }>
  terminals: Array<{ spec: TerminalSpec; transcript: string }>
  documents?: WorkspaceDocumentState[]
  drafts: EditorDraft[]
  selection: WorkspaceRecoveryState
}

export interface SessionArchiveResult {
  name: string
  selection: WorkspaceRecoveryState
}

export interface SessionArchiveBridge {
  name(): Promise<string>
  save(): Promise<SessionArchiveResult | null>
  open(): Promise<SessionArchiveResult | null>
  activateResource(kind: 'agent' | 'terminal', id: string): Promise<void>
  onChanged(callback: (result: SessionArchiveResult) => void): () => void
}
