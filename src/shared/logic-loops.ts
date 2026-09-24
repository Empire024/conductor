export interface LogicLoopSummary {
  id: string
  version: number
  title: string
  trigger: string[]
  inputs: string[]
  output?: string
  budget: Record<string, number>
  locked: string[]
  stepCount: number
  path: string
}

export interface LogicLoopStepRun {
  id: string
  runId: string
  stepId: string
  model: string
  startedAt: string
  finishedAt: string
  outcome: string
  tokens?: Record<string, number>
  note?: string
  createdAt: string
}

export interface LogicLoopRun {
  id: string
  projectId: string
  loopId: string
  loopVersion: number
  status: 'ready' | 'paused'
  createdAt: string
  steps: LogicLoopStepRun[]
}

export type LogicLoopMetric = 'tokens' | 'wallTime' | 'rounds' | 'reviewFindings'
export type LogicLoopProposalStatus = 'pending' | 'applied' | 'rejected' | 'reverted'

export interface LogicLoopProposal {
  id: string
  loopId: string
  change: string
  evidence: string
  metric?: LogicLoopMetric
  status: LogicLoopProposalStatus
  createdAt: string
  decidedAt?: string
  appliedBy?: 'agent' | 'owner' | 'wizard'
  appliedVersion?: number
  previousVersion?: number
  baselineMetric?: number
  revertReason?: string
  reasons?: string[]
}

export interface LogicLoopsSnapshot {
  loops: LogicLoopSummary[]
  runs: Record<string, LogicLoopRun[]>
  proposals: LogicLoopProposal[]
}

export interface LogicLoopsBridge {
  snapshot(projectId: string): Promise<LogicLoopsSnapshot>
  apply(projectId: string, proposalId: string): Promise<LogicLoopProposal>
  reject(projectId: string, proposalId: string): Promise<LogicLoopProposal>
  onChanged(callback: (projectId: string) => void): () => void
}
