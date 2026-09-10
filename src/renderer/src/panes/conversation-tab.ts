import type { AgentSpec, PaneTab } from '../../../shared/models'
import type { SessionProjection, SessionSettings, StructuredProvider } from '../../../shared/structured-agent'
import { concreteModel } from '../../../shared/agent-model-selection'
import { deriveConversationTitle } from '../../../shared/conversation-title'

export type ConversationIdentity = Pick<AgentSpec, 'id' | 'provider' | 'title' | 'model'> & Pick<SessionSettings, 'effort'> & {
  /** Set by the "Rename conversation" dialog: locks the tab's title immediately and for good. */
  manual?: boolean
  /** Set only when a still-untitled tab's first message is sent. `title` carries the raw prompt,
   *  still to be shortened — deriving it inside bindConversationTab keeps the tab-shape checks
   *  (locked title, machine suffix) and the derivation itself behind one function, not two. */
  auto?: boolean
}

export function conversationIdentity(snapshot: SessionProjection, fallbackProvider: StructuredProvider): ConversationIdentity {
  const provider = snapshot.capabilities?.provider ?? fallbackProvider
  return { id: snapshot.sessionId, provider, title: snapshot.title, model: concreteModel(provider, snapshot.settings.model, snapshot.capabilities), effort: snapshot.settings.effort ?? 'auto' }
}

/** A tab placed on a paired machine carries its location as a trailing " · <machine>" (see
 *  machine-placement.ts's createPlacedTab); replacing the title on such a tab must not erase it. */
function withMachineSuffix(tab: PaneTab, title: string): string {
  if (!tab.state?.machineId) return title
  const at = tab.title.lastIndexOf(' · ')
  return at === -1 ? title : title + tab.title.slice(at)
}

function nextTitle(tab: PaneTab, conversation: ConversationIdentity): string {
  // A fresh explicit rename always wins, even over an already-locked title: `titleLocked` exists
  // to block automatic renaming, not to block the owner from renaming again.
  if (conversation.manual) return conversation.title
  if (tab.titleLocked) return tab.title
  if (conversation.auto) {
    const derived = deriveConversationTitle(conversation.title)
    return derived ? withMachineSuffix(tab, derived) : tab.title
  }
  return withMachineSuffix(tab, conversation.title || tab.title)
}

/** Keep the pane identity stable while its visible native conversation changes. A locked title —
 *  set by hand, or already assigned by the first-message auto-name — is never replaced. */
export function bindConversationTab(tab: PaneTab, conversation: ConversationIdentity): PaneTab {
  const title = nextTitle(tab, conversation)
  const titleLocked = tab.titleLocked || Boolean(conversation.manual) || Boolean(conversation.auto)
  return { ...tab, resourceId: conversation.id, title, titleLocked, state: { ...tab.state, provider: conversation.provider, model: conversation.model, effort: conversation.effort, resume: true, viewMode: 'visual' } }
}
