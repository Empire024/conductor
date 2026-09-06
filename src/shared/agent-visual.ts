import type { NormalizedAgentEvent } from './models'

export type AgentVisualBlockKind =
  | 'message'
  | 'activity'
  | 'command'
  | 'file'
  | 'tool'
  | 'question'
  | 'error'
  | 'completion'
  | 'artifact'
  | 'finding'

export type AgentVisualTone = 'neutral' | 'working' | 'attention' | 'success' | 'danger'
export type AgentEventViewMode = 'visual' | 'raw'

export interface AgentVisualFileReference {
  path: string
  line?: number
  column?: number
}

export interface AgentVisualBlock {
  id: string
  agentSessionId: string
  kind: AgentVisualBlockKind
  tone: AgentVisualTone
  label: string
  title: string
  body: string
  createdAt: string
  updatedAt: string
  sourceEventIds: string[]
  occurrences: number
  files: AgentVisualFileReference[]
  command?: string
  tool?: string
  metadata?: Record<string, unknown>
}

/** Visual blocks are additive: the original event stream and CLI transcript remain available. */
export interface AgentVisualTimeline {
  blocks: AgentVisualBlock[]
  raw: {
    transcript: string
    events: NormalizedAgentEvent[]
  }
}

export interface BuildAgentVisualTimelineOptions {
  rawTranscript?: string
  projectPath?: string
  maxBlocks?: number
  mergeTextWithinMs?: number
  coalesceActivityWithinMs?: number
}
