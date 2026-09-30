import type { AwaitingRecord } from '../shared/awaiting-results'
import type { SessionProjection } from '../shared/structured-agent'

/**
 * supervisor.overview: everything the meta-wizard (docs/meta-wizard.md) needs to judge every tab
 * of every project in one owner call, so a supervisor that runs outside the app every two minutes
 * never walks agents.list and agents.status tab by tab. Read-only; shaped here, gathered by
 * AgentControl.
 */
export interface SupervisorTab {
  agentSessionId: string
  tabId: string
  title: string
  projectId: string
  project: string
  workspaceId: string
  provider: string | null
  phase: string | null
  backgroundTasks: number
  wizard: boolean
  /** The conversation that controls this one (its dispatcher), or null. */
  controller: string | null
  awaiting: { agents: string[]; since: string; deadline: string | null; reason: string | null } | null
  /** The newest tool call; output only for a refused or failed one, target for a message. */
  lastTool: { name: string; status: string; at: string; output?: string; target?: string } | null
  lastAnswer: string | null
  lastError: string | null
  lastActivityAt: string | null
  limitResumeAt: string | null
  /** Approval or question cards waiting, by who answers them. */
  pending: { owner: number; reviewer: number }
}

export interface SupervisorOverview {
  observedAt: string
  pid: number | null
  version: string | null
  updates: unknown
  /** The newest local update build and who asked for it (its offer record). */
  localBuild: { state: string; version: string | null; commit: string | null; verified: boolean | null; finishedAt: string | null; builder: string | null; offered: boolean | null } | null
  tabs: SupervisorTab[]
}

const MESSAGE_TOOL = /^(?:mcp__conductor__|conductor[./:])?(?:send_message|report)$/
const flat = (value: string, limit: number, tail = false): string => {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length <= limit ? line : tail ? '…' + line.slice(-limit) : line.slice(0, limit) + '…'
}

export function supervisorTab(base: Omit<SupervisorTab, 'awaiting' | 'lastTool' | 'lastAnswer' | 'lastError' | 'limitResumeAt' | 'pending'>, state: SessionProjection | null, awaiting: AwaitingRecord | null): SupervisorTab {
  const items = state ? [...state.items].sort((a, b) => (b.updatedSequence ?? b.sequence) - (a.updatedSequence ?? a.sequence)) : []
  const tool = items.find(item => item.data.type === 'tool' && item.data.name !== 'acceptance')
  const text = items.find(item => !item.parentId && item.data.type === 'text' && item.data.role === 'assistant')
  const error = items.find(item => item.data.type === 'error')
  const pending = { owner: 0, reviewer: 0 }
  for (const item of items) if (item.data.type === 'interaction' && item.data.interaction.status === 'pending') pending[item.data.interaction.review?.phase === 'reviewing' ? 'reviewer' : 'owner']++
  let lastTool: SupervisorTab['lastTool'] = null
  if (tool?.data.type === 'tool') {
    const data = tool.data as { name: string; status: string; input?: unknown; output?: string }
    const input = data.input && typeof data.input === 'object' ? data.input as Record<string, unknown> : {}
    lastTool = {
      name: data.name, status: data.status, at: tool.timestamp,
      ...(['rejected', 'failed'].includes(data.status) && typeof data.output === 'string' && data.output.trim() ? { output: flat(data.output, 400) } : {}),
      ...(MESSAGE_TOOL.test(data.name) && typeof input.agentSessionId === 'string' ? { target: input.agentSessionId } : {})
    }
  }
  return {
    ...base,
    awaiting: awaiting ? { agents: awaiting.agents, since: awaiting.since, deadline: (awaiting as { deadline?: string }).deadline ?? null, reason: awaiting.reason ?? null } : null,
    lastTool,
    lastAnswer: text?.data.type === 'text' ? flat(text.data.text, 400, true) : null,
    lastError: error?.data.type === 'error' ? flat(error.data.message, 400) : null,
    limitResumeAt: state?.limitResumeAt ?? null,
    pending
  }
}
