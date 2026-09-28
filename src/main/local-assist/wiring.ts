import { join } from 'node:path'
import type { AgentSpec } from '../../shared/models'
import type { SessionSettings } from '../../shared/structured-agent'
import type { LocalModelRunner, SavingsSummary } from './contract.ts'
import { LocalAssistMcpServer } from './mcp-server.ts'
import { createLocalModelRunner, realRunnerPorts } from './model-runner.ts'
import { FileSavingsLedger } from './savings.ts'
import { LocalAssistTools, type LocalAssistSession } from './tools.ts'

export interface LocalAssistWiringDeps {
  structured: {
    spec<T>(id: string): T | null | undefined
    snapshot(id: string): { settings: SessionSettings } | null | undefined
  }
  userData: string
  /** Where the conductor-local server is handed to each Claude and Codex launch. */
  sessions: { setLocalAssist(server: { configure(spec: AgentSpec): string; release(agentSessionId: string): void }): void }
}

export interface LocalAssist {
  server: LocalAssistMcpServer
  /** The one local-model runner of this process; model intelligence's local decider shares it. */
  runner: LocalModelRunner
  /** Local models saved ≈ N frontier tokens over the last `days` (usage view, local.savings). */
  savings(days?: number): SavingsSummary
  close(): void
}

/** Starts the conductor-local MCP server and hands it to the structured sessions. index.ts calls
 *  this once, after the structured sessions exist and before any conversation launches. */
export async function startLocalAssist(deps: LocalAssistWiringDeps): Promise<LocalAssist> {
  const ledger = new FileSavingsLedger(join(deps.userData, 'local-assist', 'savings.jsonl'))
  const runner = createLocalModelRunner(await realRunnerPorts())
  const session = (agentSessionId: string): LocalAssistSession | undefined => {
    const spec = deps.structured.spec<AgentSpec>(agentSessionId), state = deps.structured.snapshot(agentSessionId)
    if (!spec || !state) return undefined
    return { projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId, provider: spec.provider, cwd: spec.cwd, permission: state.settings.permission, plan: Boolean(state.settings.plan) }
  }
  const server = new LocalAssistMcpServer(new LocalAssistTools({ session, runner, ledger }))
  await server.start()
  deps.sessions.setLocalAssist(server)
  return { server, runner, savings: days => ledger.summary(days), close: () => server.close() }
}
