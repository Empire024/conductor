import type { AgentProviderId } from './models'

export type OrchestrationAgentStatus = 'active' | 'paused' | 'archived'
export type OrchestrationTaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'cancelled'
export type OrchestrationTaskPriority = 'low' | 'normal' | 'high' | 'urgent'
export type RoutineRunStatus = 'running' | 'complete' | 'cancelled'

export interface OrchestrationAgent {
  id: string
  projectId: string
  name: string
  provider: AgentProviderId
  model: string | null
  role: string
  instructions: string
  status: OrchestrationAgentStatus
  createdAt: string
  updatedAt: string
}

export interface SaveOrchestrationAgentInput {
  id?: string
  projectId: string
  name: string
  provider: AgentProviderId
  model?: string | null
  role?: string
  instructions?: string
  status?: OrchestrationAgentStatus
}

export interface OrchestrationTask {
  id: string
  projectId: string
  title: string
  description: string
  status: OrchestrationTaskStatus
  priority: OrchestrationTaskPriority
  assignedAgentId: string | null
  routineId: string | null
  routineRunId: string | null
  routineStepId: string | null
  blockedByTaskId: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface CreateOrchestrationTaskInput {
  projectId: string
  title: string
  description?: string
  status?: OrchestrationTaskStatus
  priority?: OrchestrationTaskPriority
  assignedAgentId?: string | null
}

export interface UpdateOrchestrationTaskInput {
  title?: string
  description?: string
  status?: OrchestrationTaskStatus
  priority?: OrchestrationTaskPriority
  assignedAgentId?: string | null
  sortOrder?: number
}

export interface RoutineStep {
  id: string
  routineId: string
  position: number
  title: string
  instructions: string
  assignedAgentId: string | null
}

export interface RoutineDefinition {
  id: string
  projectId: string
  name: string
  description: string
  enabled: boolean
  steps: RoutineStep[]
  createdAt: string
  updatedAt: string
}

export interface SaveRoutineStepInput {
  id?: string
  title: string
  instructions?: string
  assignedAgentId?: string | null
}

export interface SaveRoutineInput {
  id?: string
  projectId: string
  name: string
  description?: string
  enabled?: boolean
  steps: SaveRoutineStepInput[]
}

export interface RoutineRun {
  id: string
  projectId: string
  routineId: string
  status: RoutineRunStatus
  startedAt: string
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RoutineStartResult {
  run: RoutineRun
  tasks: OrchestrationTask[]
}

export interface OrchestrationSnapshot {
  agents: OrchestrationAgent[]
  tasks: OrchestrationTask[]
  routines: RoutineDefinition[]
  runs: RoutineRun[]
}

export interface OrchestrationBridge {
  snapshot(projectId: string): Promise<OrchestrationSnapshot>
  agents: {
    save(input: SaveOrchestrationAgentInput): Promise<OrchestrationAgent>
    remove(id: string): Promise<void>
  }
  tasks: {
    create(input: CreateOrchestrationTaskInput): Promise<OrchestrationTask>
    update(id: string, input: UpdateOrchestrationTaskInput): Promise<OrchestrationTask>
    remove(id: string): Promise<void>
  }
  routines: {
    save(input: SaveRoutineInput): Promise<RoutineDefinition>
    remove(id: string): Promise<void>
    start(id: string): Promise<RoutineStartResult>
  }
}
