import { rosterRole, rosterStartPrompt } from '../shared/agent-roster'
import type { OrchestrationAgent, StartOrchestrationAgentInput, StartOrchestrationAgentResult } from '../shared/orchestration'

/** What starting a roster entry needs: the roster itself, and app control acting for the owner
 *  (the same tabs.open and agents.submit a controller uses, so the tab is opened and checked the
 *  same way and the owner's window shows it in front). */
export interface RosterStartDeps {
  agent(agentId: string): OrchestrationAgent | null
  ownerScope(input: { projectId: string; workspaceId?: string }): unknown
  call(scope: unknown, method: string, args: Record<string, unknown>): Promise<unknown>
}

interface OpenedTab { id: string; resourceId?: string; state?: { provider?: string; model?: string; effort?: string } }

/**
 * Opens a roster entry as a tab on its provider, model, effort and permission and sends it its
 * instructions with the owner's goal. The entry's own provider and model win (the owner may have
 * edited them); effort and permission come from the role it was seeded as. A cloud coworker is a
 * session created from its prompt, so it needs a goal and is not sent a second message.
 */
export async function startRosterAgent(deps: RosterStartDeps, input: StartOrchestrationAgentInput): Promise<StartOrchestrationAgentResult> {
  if (!input || typeof input.agentId !== 'string' || !input.agentId) throw new Error('Choose a roster agent to start')
  const agent = deps.agent(input.agentId)
  if (!agent) throw new Error('That roster agent no longer exists')
  if (agent.status === 'archived') throw new Error(`${agent.name} is archived; set it active to start it`)
  const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
  if (goal.length > 20_000) throw new Error('The goal is too long')
  const role = rosterRole(agent.role)
  const provider = agent.provider
  const model = agent.model ?? (role && role.provider === provider ? role.model : null)
  const effort = role && role.provider === provider && role.model === model ? role.effort ?? null : null
  const permission = role && role.provider === provider ? role.permission : null
  const prompt = rosterStartPrompt(agent.instructions || `You are ${agent.name}. ${agent.role}`, goal)
  const scope = deps.ownerScope({ projectId: agent.projectId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) })
  if (role?.cloud && provider === role.provider) {
    if (!goal) throw new Error(`${agent.name} starts a cloud session from its goal; give it one`)
    const opened = await deps.call(scope, 'tabs.open', { kind: 'agent', provider: 'cloud', ...(model ? { model } : {}), ...(effort ? { effort } : {}), title: agent.name, prompt, focus: true }) as OpenedTab
    return { tabId: opened.id, agentSessionId: opened.resourceId ?? null, provider, model, effort, permission: null }
  }
  const opened = await deps.call(scope, 'tabs.open', {
    kind: 'agent', provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    // The role states its mode; exactPermission keeps it as stated instead of the coworker default.
    ...(permission ? { permission, exactPermission: true } : {}),
    title: agent.name, focus: true
  }) as OpenedTab
  if (!opened.resourceId) throw new Error('The roster agent\'s tab opened without a conversation')
  await deps.call(scope, 'agents.submit', { agentSessionId: opened.resourceId, prompt })
  return { tabId: opened.id, agentSessionId: opened.resourceId, provider, model: opened.state?.model ?? model, effort: opened.state?.effort ?? effort, permission }
}
