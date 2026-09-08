import type { AgentSpec, PaneTab } from '../../../shared/models'
import type { SessionProjection, SessionSettings, StructuredProvider } from '../../../shared/structured-agent'
import { concreteModel } from '../../../shared/agent-model-selection'

export type ConversationIdentity = Pick<AgentSpec, 'id' | 'provider' | 'title' | 'model'> & Pick<SessionSettings, 'effort'>

export function conversationIdentity(snapshot: SessionProjection, fallbackProvider: StructuredProvider): ConversationIdentity {
  const provider = snapshot.capabilities?.provider ?? fallbackProvider
  return { id: snapshot.sessionId, provider, title: snapshot.title, model: concreteModel(provider, snapshot.settings.model, snapshot.capabilities), effort: snapshot.settings.effort ?? 'auto' }
}

/** Keep the pane identity stable while its visible native conversation changes. */
export function bindConversationTab(tab: PaneTab, conversation: ConversationIdentity): PaneTab {
  return { ...tab, resourceId: conversation.id, title: conversation.title || tab.title, state: { ...tab.state, provider: conversation.provider, model: conversation.model, effort: conversation.effort, resume: true, viewMode: 'visual' } }
}
