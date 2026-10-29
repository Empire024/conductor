/** The window's half of threads without a project (src/shared/threads.ts): the General project on
 *  first use, the cross-project Threads view, and the two ways a General thread joins a project. */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { AgentProviderId, AgentSpec, ProjectRecord } from '../shared/models'
import type { PhoneSessionSummary } from '../shared/phone-access'
import type { TimelineItem } from '../shared/structured-agent'
import { buildThreadView, draftThreadHandoff, type GeneralThreadTarget, type ThreadView } from '../shared/threads'
import type { GeneralThreads } from './general-threads'

export interface ThreadsIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  trusted(event: IpcMainInvokeEvent): void
  general: GeneralThreads
  /** Every conversation the phone list would show (PhoneAccessService.phoneState().sessions). */
  sessions(): PhoneSessionSummary[]
  spec(agentSessionId: string): AgentSpec | null
  items(agentSessionId: string): readonly TimelineItem[]
  title(agentSessionId: string): string | null
  getProject(projectId: string): ProjectRecord | null
  /** projects:changed for every window, after the General project appears or is renamed. */
  projectsChanged(): void
  now?(): number
}

const AGENT_ID = /^agent_[A-Za-z0-9_-]{1,150}$/

export const THREAD_CHANNELS = ['threads:new-general', 'threads:general-id', 'threads:list', 'threads:handoff', 'threads:promote'] as const

/** Top-level owner and agent messages, oldest first; status lines and subagent output are left out. */
export function conversationMessages(items: readonly TimelineItem[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const item of items) {
    if (item.parentId || item.data.type !== 'text' || item.data.role === 'status' || !item.data.text.trim()) continue
    messages.push({ role: item.data.role, text: item.data.text })
  }
  return messages
}

export function threadHandoff(deps: Pick<ThreadsIpcDeps, 'general' | 'spec' | 'items' | 'title' | 'getProject'>, agentSessionId: unknown, targetProjectId: unknown): { text: string; provider: AgentProviderId; model?: string } | null {
  if (typeof agentSessionId !== 'string' || !AGENT_ID.test(agentSessionId) || typeof targetProjectId !== 'string' || !targetProjectId) throw new Error('Choose a thread and a project')
  const spec = deps.spec(agentSessionId)
  if (!spec) return null
  const generalId = deps.general.projectId()
  if (!generalId || spec.projectId !== generalId) throw new Error('Only a thread started without a project continues in a project')
  const source = deps.getProject(spec.projectId)
  const target = deps.getProject(targetProjectId)
  if (!source || !target || target.id === source.id) throw new Error('Choose another project that is open in Conductor')
  const text = draftThreadHandoff({ title: deps.title(agentSessionId) || spec.title || 'Thread', folder: source.path, projectName: target.name, messages: conversationMessages(deps.items(agentSessionId)) })
  return { text, provider: spec.provider, ...(spec.model && spec.model !== 'default' ? { model: spec.model } : {}) }
}

export function registerThreadsIpc(deps: ThreadsIpcDeps): () => void {
  const now = deps.now ?? Date.now
  deps.ipcMain.handle('threads:new-general', async (event): Promise<GeneralThreadTarget> => {
    deps.trusted(event)
    const target = await deps.general.ensure()
    deps.projectsChanged()
    return target
  })
  deps.ipcMain.handle('threads:general-id', event => { deps.trusted(event); return deps.general.projectId() })
  deps.ipcMain.handle('threads:list', (event, query: unknown): ThreadView => {
    deps.trusted(event)
    return buildThreadView(deps.sessions(), { generalProjectId: deps.general.projectId(), now: now(), query: typeof query === 'string' ? query.slice(0, 200) : '' })
  })
  deps.ipcMain.handle('threads:handoff', (event, agentSessionId: unknown, targetProjectId: unknown) => { deps.trusted(event); return threadHandoff(deps, agentSessionId, targetProjectId) })
  deps.ipcMain.handle('threads:promote', (event, name: unknown) => {
    deps.trusted(event)
    const project = deps.general.promote(typeof name === 'string' ? name : '')
    deps.projectsChanged()
    return project
  })
  return () => { for (const channel of THREAD_CHANNELS) deps.ipcMain.removeHandler(channel) }
}
