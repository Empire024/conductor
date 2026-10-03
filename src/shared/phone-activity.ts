/** A bounded receipt of completed work, never a copy of a command or its credentials. */
export type PhoneActivityKind = 'email' | 'deployment' | 'production' | 'commit' | 'update' | 'approval' | 'task'
export interface PhoneActivityItem {
  id: string
  kind: PhoneActivityKind
  title: string
  detail?: string
  at: string
  projectId: string
  projectName: string
  sessionId: string | null
  tabTitle: string
}
export interface PhoneActivityPage { items: PhoneActivityItem[]; hasMore: boolean; since: string }
