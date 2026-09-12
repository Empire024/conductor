import { execFileSync } from 'node:child_process'
import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type {
  AgentEffort,
  AgentProviderId,
  AgentProviderInfo,
  AgentSpec,
  NormalizedAgentEvent,
  RuntimeEnsureResult
} from '../shared/models'
import { makeId } from '../shared/models'
import type { ConductorDatabase } from './database'
import { parseUsageLimitReset } from './usage-limit'
import { extendResizeActivitySuppression, normalizeAgentOutputSignal, shouldSignalAgentOutput } from './agent-activity'
import type { AgentCollaborationRuntime } from './agent-collaboration-runtime'
import { captureMemories, capturedMemoryKey, formatRecalledMemories, MEMORY_PROTOCOL } from './memory'
import { LOCAL_MODELS } from '../shared/local-models'
import { NativeCliManager } from './native-cli-manager'
import { loadConfig } from './local-models/config.ts'
import { StructuredSessions } from './structured-sessions'
import { projectTaskBriefing } from './project-backlog'

export { parseUsageLimitReset } from './usage-limit'

interface ProviderLaunch {
  executable: string
  args: string[]
}

interface AgentProvider {
  id: AgentProviderId
  displayName: string
  resolveExecutable(): string | null
  launch(spec: AgentSpec, executable: string): ProviderLaunch
  installUrl: string
  models: Array<{ id: string; label: string }>
  efforts: Array<{ id: AgentEffort; label: string }>
}

const modelArg = (spec: AgentSpec): string[] => spec.model && spec.model !== 'default'
  ? ['--model', spec.model]
  : []

export const CODEX_EFFORTS: Array<{ id: AgentEffort; label: string }> = [
  { id: 'auto', label: 'Automatic' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' }
]

const standardEfforts: Array<{ id: AgentEffort; label: string }> = [
  ...CODEX_EFFORTS,
  { id: 'max', label: 'Maximum' }
]

const claudeEfforts: Array<{ id: AgentEffort; label: string }> = [...standardEfforts]

export const CODEX_MODELS = [
  { id: 'default', label: 'Default for account' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }
]

const findOnPath = (command: string, configured?: string): string | null => {
  if (configured?.trim()) return configured.trim()
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which'
    const output = execFileSync(finder, [command], { encoding: 'utf8', windowsHide: true })
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
  } catch {
    return null
  }
}

const providers: Record<AgentProviderId, AgentProvider> = {
  codex: {
    id: 'codex',
    displayName: 'Codex',
    resolveExecutable: () => findOnPath('codex', process.env.CONDUCTOR_CODEX_PATH),
    installUrl: 'https://developers.openai.com/codex/cli/',
    models: CODEX_MODELS,
    // Codex config currently accepts minimal/low/medium/high/xhigh. `max` is
    // intentionally not offered here: passing it as model_reasoning_effort
    // makes the CLI exit and leaves its pane looking broken.
    efforts: CODEX_EFFORTS,
    launch: (spec, executable) => ({
      executable,
      args: [
        ...modelArg(spec),
        ...(CODEX_EFFORTS.some(({ id }) => id === spec.effort) && spec.effort !== 'auto'
          ? ['-c', `model_reasoning_effort="${spec.effort}"`]
          : []),
        ...(spec.resume ? ['resume', '--last'] : [])
      ]
    })
  },
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    resolveExecutable: () => findOnPath('claude', process.env.CONDUCTOR_CLAUDE_PATH),
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    models: [
      { id: 'default', label: 'Default for account' },
      { id: 'opus', label: 'Claude Opus' },
      { id: 'sonnet', label: 'Claude Sonnet' },
      { id: 'haiku', label: 'Claude Haiku' },
      { id: 'fable', label: 'Claude Fable' }
    ],
    efforts: claudeEfforts,
    launch: (spec, executable) => ({
      executable,
      args: [
        ...modelArg(spec),
        ...(spec.effort && spec.effort !== 'auto' ? ['--effort', spec.effort] : []),
        ...(spec.resume ? ['--continue'] : [])
      ]
    })
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI',
    resolveExecutable: () => findOnPath('gemini', process.env.CONDUCTOR_GEMINI_PATH),
    installUrl: 'https://github.com/google-gemini/gemini-cli',
    models: [
      { id: 'default', label: 'Auto / default' },
      { id: 'pro', label: 'Gemini Pro' },
      { id: 'flash', label: 'Gemini Flash' },
      { id: 'flash-lite', label: 'Gemini Flash Lite' }
    ],
    efforts: [{ id: 'auto', label: 'Provider default' }],
    launch: (spec, executable) => ({ executable, args: modelArg(spec) })
  },
  qwen: {
    id: 'qwen',
    displayName: 'Qwen Code',
    resolveExecutable: () => findOnPath('qwen', process.env.CONDUCTOR_QWEN_PATH),
    installUrl: 'https://github.com/QwenLM/qwen-code',
    models: [
      { id: 'default', label: 'Default for account' },
      { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' },
      { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash' }
    ],
    efforts: [{ id: 'auto', label: 'Provider default' }],
    launch: (spec, executable) => ({ executable, args: modelArg(spec) })
  },
  local: {
    id: 'local',
    displayName: 'Local',
    // The "executable" for this provider is the llama.cpp server the local stack was set up
    // with; finding it is what makes Local available at all. Nothing is launched from here -
    // the adapter starts and reuses the loopback servers itself, and a missing config simply
    // reports the provider as unavailable.
    resolveExecutable: () => {
      try { return loadConfig().llamaServer } catch { return null }
    },
    installUrl: 'https://github.com/ggml-org/llama.cpp',
    models: LOCAL_MODELS.map(model => ({ ...model })),
    efforts: [{ id: 'auto', label: 'Provider default' }],
    launch: () => { throw new Error('Local models run through the structured local runtime, never as a terminal CLI') }
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi Code',
    resolveExecutable: () => findOnPath('kimi', process.env.CONDUCTOR_KIMI_PATH),
    installUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
    models: [
      { id: 'default', label: 'Default for account' },
      { id: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' },
      { id: 'kimi-code/kimi-for-coding-highspeed', label: 'Kimi for Coding High-speed' },
      { id: 'kimi-code/k3', label: 'Kimi K3' }
    ],
    efforts: [{ id: 'auto', label: 'Provider default' }],
    launch: (spec, executable) => ({
      executable,
      args: [...modelArg(spec), ...(spec.resume ? ['--continue'] : [])]
    })
  }
}

interface LiveAgent {
  process: IPty
  spec: AgentSpec
  executable: string
  resumeAttempt: boolean
  resumeFailed: boolean
  pendingTranscript: string
  flushTimer?: NodeJS.Timeout
  activityTimer?: NodeJS.Timeout
  limitProbe: string
  limitDetected: boolean
  limitResumeAt?: string
  lastQuestionAt: number
  capturedMemories: Set<string>
  reportedInteractions: Set<string>
  suppressActivityUntil: number
  workPending: boolean
  inputBuffer: string
  lastOutputSignal: string
  lastVisualBody: string
  status: RuntimeEnsureResult['status']
}

const statusListeners = new Set<() => void>()

/** Every agent phase change - legacy terminal agents here and structured sessions through the
 *  same broadcast - is announced on 'agent:status'. Cross-project activity is recomputed from
 *  the database on this signal, since no renderer sees agents outside its active project. */
export const onAgentStatusChange = (listener: () => void): (() => void) => {
  statusListeners.add(listener)
  return () => { statusListeners.delete(listener) }
}

const broadcast = (channel: string, payload: unknown): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
  if (channel === 'agent:status') for (const listener of [...statusListeners]) listener()
}

const stripAnsi = (value: string): string =>
  value
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

export class AgentManager {
  readonly structured: StructuredSessions
  readonly nativeCli: NativeCliManager
  private readonly agents = new Map<string, LiveAgent>()
  private readonly continuationTimers = new Map<string, NodeJS.Timeout>()
  // Per-session, not persisted: the protocol is handed over once per run, and a repeated
  // assistant snapshot must not bank the same claim twice within that run.
  private readonly memoryBriefed = new Set<string>()
  private readonly memoryCaptures = new Map<string, Set<string>>()
  private disposing = false

  constructor(
    private readonly database: ConductorDatabase,
    private readonly collaboration?: AgentCollaborationRuntime,
    private readonly controlBriefing?: (spec: AgentSpec) => string,
    private readonly mcp?: { configure(spec: AgentSpec): string; release(agentSessionId: string): void }
  ) {
    this.structured = new StructuredSessions(database, (provider) => providers[provider].resolveExecutable(), broadcast,
      undefined,
      (spec, prompt, itemId) => {
        // The write half of the contract is a once-per-session cost: it competes with the
        // user's actual request for attention, and repeating it every turn buys nothing.
        const first = !this.memoryBriefed.has(spec.id)
        if (first) {
          this.memoryBriefed.add(spec.id)
          try { database.forgetStaleMemories(spec.projectId) } catch { /* Pruning is opportunistic; recall works without it. */ }
        }
        const memories = database.recall(spec.projectId, prompt, spec.provider, 8)
        const recalled = formatRecalledMemories(memories)
        // Recall that reached the prompt is recorded against the user message it travelled
        // with, so a memory steering the turn is visible in the conversation instead of
        // being an invisible edit to the prompt.
        if (recalled) {
          try { database.recordMemoryRecall({ projectId: spec.projectId, agentSessionId: spec.id, itemId, prompt, memoryIds: memories.map(memory => memory.id) }) }
          catch { /* The ledger explains a turn; it is never a precondition for sending one. */ }
        }
        const memoryContext = recalled ? `Conductor project memory (current project evidence takes precedence):\n${recalled}` : ''
        return [memoryContext, first ? MEMORY_PROTOCOL : '', collaboration?.briefingFor(spec.id) ?? '', projectTaskBriefing(spec), this.controlBriefing?.(spec) ?? ''].filter(Boolean).join('\n\n')
      },
      (spec, event) => {
        if (event.data.type === 'text' && event.data.role === 'assistant' && event.data.mode === 'snapshot') this.bankMemories(spec, event.itemId, event.data.text)
        if (event.data.type !== 'tool' && event.data.type !== 'changes') return
        try { collaboration?.observeEvent(spec, { id: event.id, agentSessionId: spec.id, type: event.data.type === 'changes' ? 'file_change' : 'tool_call', message: event.data.type === 'tool' ? event.data.name : event.data.changes.map(change => change.path).join(', '), metadata: { structured: true, itemId: event.itemId, input: event.data.type === 'tool' ? event.data.input : undefined }, createdAt: event.timestamp }) } catch { /* Coordination remains advisory. */ }
      },
      mcp)
    this.nativeCli = new NativeCliManager(this.structured, database, (provider) => providers[provider].resolveExecutable(), broadcast)
  }

  /** Reads the agent's memory-write sentinels out of its own reply and banks them as agent-source
   *  memories. A rejected gist is dropped quietly: a bad sentinel must never fail the turn. */
  private bankMemories(spec: AgentSpec, itemId: string | undefined, text: string): void {
    let seen = this.memoryCaptures.get(spec.id)
    if (!seen) { seen = new Set<string>(); this.memoryCaptures.set(spec.id, seen) }
    for (const captured of captureMemories(text)) {
      const key = capturedMemoryKey(itemId, captured)
      if (seen.has(key)) continue
      // Bounded, so a long-running session cannot grow this set without limit.
      if (seen.size >= 500) seen.clear()
      seen.add(key)
      try {
        this.database.remember({
          projectId: spec.projectId, agentKey: spec.provider, source: 'agent', ...captured,
          origin: { agentSessionId: spec.id, workspaceId: spec.sessionId, title: spec.title, provider: spec.provider }
        })
      }
      catch { /* The agent wrote something unusable; that is not the user's problem. */ }
    }
  }

  listProviders(): AgentProviderInfo[] {
    return Object.values(providers).map((provider) => {
      const executable = provider.resolveExecutable()
      return {
        id: provider.id,
        displayName: provider.displayName,
        available: Boolean(executable),
        executable: executable ?? undefined,
        installUrl: provider.installUrl,
        models: provider.models,
        efforts: provider.efforts
      }
    })
  }

  ensure(spec: AgentSpec): RuntimeEnsureResult {
    if (spec.provider === 'codex' || spec.provider === 'claude' || spec.provider === 'local') return this.structured.ensure(spec)
    // Choose and launch the same concrete catalog model shown in this tab.
    if (!spec.model || ['default', 'auto'].includes(spec.model)) spec = { ...spec, model: this.agents.get(spec.id)?.spec.model ?? providers[spec.provider].models.find(model => !['default', 'auto'].includes(model.id))?.id }
    const continuation = this.database.getContinuation(spec.id)
    const parsedContinuation = continuation?.status === 'pending' ? new Date(continuation.resumeAt) : null
    const resumeAt = parsedContinuation && !Number.isNaN(parsedContinuation.getTime())
      ? parsedContinuation
      : null
    if (continuation?.status === 'pending' && !resumeAt) this.database.clearContinuation(spec.id)
    const existing = this.agents.get(spec.id)
    if (existing) {
      existing.spec = spec
      if (resumeAt && resumeAt.getTime() > Date.now()) {
        existing.limitDetected = true
        existing.limitResumeAt = resumeAt.toISOString()
        existing.status = 'limited'
        if (spec.continueOnLimit) this.scheduleContinuation(spec, resumeAt)
        else this.cancelContinuationTimer(spec.id)
      } else if (!spec.continueOnLimit) {
        this.cancelContinuationTimer(spec.id)
      } else if (resumeAt && existing.limitDetected) {
        existing.limitProbe = ''
        existing.limitDetected = false
        existing.limitResumeAt = undefined
        existing.status = 'running'
        this.database.completeContinuation(spec.id)
        this.submitMessage(spec.id, 'continue')
      }
      this.database.upsertAgent(spec, existing.status, existing.workPending ? 'working' : 'idle')
      return {
        id: spec.id,
        available: true,
        status: existing.status,
        transcript: this.database.getAgentTranscript(spec.id),
        executable: existing.executable,
        model: spec.model ?? 'default',
        resumeAt: existing.limitResumeAt
      }
    }
    if (continuation?.status === 'pending') {
      if (resumeAt && resumeAt.getTime() > Date.now()) {
        if (spec.continueOnLimit) this.scheduleContinuation(spec, resumeAt)
        return {
          id: spec.id,
          available: true,
          status: 'limited',
          transcript: this.database.getAgentTranscript(spec.id),
          model: spec.model ?? 'default',
          resumeAt: resumeAt.toISOString()
        }
      } else if (resumeAt && spec.continueOnLimit) {
        const result = this.spawn({ ...spec, resume: true })
        if (result.available) {
          this.database.completeContinuation(spec.id)
          setTimeout(() => this.submitMessage(spec.id, 'continue'), 1200)
        }
        return result
      } else if (resumeAt) {
        this.database.completeContinuation(spec.id)
      }
    }
    return this.spawn(spec)
  }

  restart(spec: AgentSpec): RuntimeEnsureResult {
    if (spec.provider === 'codex' || spec.provider === 'claude') {
      throw new Error('Use Resume for a native structured conversation; restarting must not silently replace context')
    }
    this.kill(spec.id)
    return this.spawn(spec)
  }

  write(id: string, data: string): void {
    const agent = this.agents.get(id)
    if (!agent) return
    agent.process.write(data)
    if (data === '\u007f' || data === '\b') {
      agent.inputBuffer = agent.inputBuffer.slice(0, -1)
    } else {
      agent.inputBuffer = `${agent.inputBuffer}${data.replace(/[\u0000-\u001f\u007f]/g, '')}`.slice(-60_000)
    }
    if (/[\r\n]/.test(data)) {
      const submitted = agent.inputBuffer.trim()
      agent.inputBuffer = ''
      if (submitted) {
        this.emitEvent(agent.spec, 'text', submitted, { role: 'user', source: 'cli' })
      }
      const resetTime = agent.limitResumeAt ? Date.parse(agent.limitResumeAt) : Number.NaN
      if (agent.limitDetected && Number.isFinite(resetTime) && resetTime <= Date.now()) {
        agent.limitDetected = false
        agent.limitResumeAt = undefined
        agent.limitProbe = ''
        this.database.completeContinuation(id)
      }
      if (agent.limitDetected) return
      this.beginWork(agent)
    }
  }

  respond(id: string, data: string): void {
    const agent = this.agents.get(id)
    if (!agent) return
    agent.process.write(data)
    agent.workPending = false
    agent.status = 'running'
    this.database.setAgentStatus(id, 'running', 'idle')
    broadcast('agent:status', { id, status: 'running', phase: 'idle', model: agent.spec.model ?? 'default' })
  }

  reportInteraction(id: string, kind: 'directory_trust'): void {
    const agent = this.agents.get(id)
    if (!agent || agent.reportedInteractions.has(kind)) return
    agent.reportedInteractions.add(kind)
    agent.lastQuestionAt = Date.now()
    agent.workPending = false
    if (agent.activityTimer) clearTimeout(agent.activityTimer)
    agent.status = 'waiting_input'
    this.database.setAgentStatus(id, 'waiting_input', 'waiting_input')
    this.emitEvent(agent.spec, 'question', 'Do you trust the contents of this directory? Trusting it allows project-local config, hooks, and execution policies to load.', {
      title: 'Directory trust required',
      kind,
      options: ['Trust and continue', "Don't trust — quit"],
      acceptInput: agent.spec.provider === 'claude' ? '\u001b[B\r' : '\r',
      rejectInput: agent.spec.provider === 'claude' ? '\r' : '\u001b[B\r'
    })
    broadcast('agent:status', { id, status: 'waiting_input', phase: 'waiting_input', model: agent.spec.model ?? 'default' })
  }

  submit(id: string, message: string, mode: 'manual' | 'edit' | 'plan' | 'auto' = 'edit'): void | Promise<void> {
    const structured = this.database.structured.snapshot(id)
    if (structured) return this.structured.submit(id, message, { ...structured.settings, permission: mode === 'edit' ? 'accept-edits' : 'default', plan: mode === 'plan' })
    const agent = this.agents.get(id)
    if (!agent) throw new Error('Agent session is not running')
    const normalized = message.trim().slice(0, 60_000)
    if (!normalized) return
    agent.lastVisualBody = ''

    const memories = this.database.recall(agent.spec.projectId, normalized, agent.spec.provider, 8)
    const memoryLines: string[] = []
    let memoryLength = 0
    for (const memory of memories) {
      const line = `- [${memory.kind}] ${memory.gist.replace(/\s+/g, ' ').trim().slice(0, 520)}`
      if (memoryLength + line.length > 3_500) break
      memoryLines.push(line)
      memoryLength += line.length
    }
    const modeInstruction = {
      manual: 'Ask before editing files or executing commands.',
      edit: 'Apply the requested edits, respecting the runtime permission prompts.',
      plan: 'Explore and produce a plan only; do not edit files yet.',
      auto: 'Proceed autonomously within the permissions granted by the runtime.'
    }[mode]
    try {
      // Reserve explicitly mentioned files before the provider begins acting,
      // so a concurrently prompted coworker sees the overlap immediately.
      this.collaboration?.observeEvent(agent.spec, {
        id: makeId('intent'),
        agentSessionId: agent.spec.id,
        type: 'activity',
        message: normalized,
        metadata: { source: 'user_submission' },
        createdAt: new Date().toISOString()
      })
    } catch {
      // Coordination is advisory; a storage failure cannot swallow user input.
    }
    const context = memoryLines.length
      ? `\n\nConductor recalled durable project knowledge. Use only what is relevant; current project evidence wins:\n${memoryLines.join('\n')}`
      : ''
    let coworkerBriefing = ''
    try {
      coworkerBriefing = this.collaboration?.briefingFor(id) ?? ''
    } catch {
      // Collaboration context should never prevent a user message from sending.
    }
    const collaborationContext = [coworkerBriefing, this.controlBriefing?.(agent.spec) ?? ''].filter(Boolean).map(context => '\n\n' + context).join('')
    const submitted = `[Conductor ${mode} mode: ${modeInstruction}]${collaborationContext}${context}\n\n${normalized}`
    this.emitEvent(agent.spec, 'text', normalized, {
      role: 'user',
      source: 'composer',
      mode
    })
    this.submitMessage(id, submitted)
    this.emitEvent(agent.spec, 'activity', `Using ${mode} mode${memoryLines.length ? ` with ${memoryLines.length} recalled memories` : ''}.`, {
      mode,
      recalledMemoryCount: memoryLines.length,
      presentation: 'quiet'
    })
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      const agent = this.agents.get(id)
      if (agent && cols >= 2 && rows >= 1) {
        agent.suppressActivityUntil = extendResizeActivitySuppression(agent.suppressActivityUntil)
        agent.process.resize(cols, rows)
      }
    } catch {
      // A provider can exit while its pane is resizing.
    }
  }

  captureVisual(id: string, body: string, active: boolean, settled: boolean): void {
    const live = this.agents.get(id)
    if (!live) return
    const normalized = body.replace(/\r/g, '').replace(/\n{4,}/g, '\n\n').trim().slice(0, 60_000)
    if (active && !settled) {
      if (live.workPending) this.beginWork(live)
      return
    }
    if (!settled) return

    const alreadyStored = normalized && this.database.listAgentEvents(id).some((event) =>
      event.type === 'text' && event.metadata?.source === 'terminal_screen' && event.message === normalized
    )
    if (normalized && normalized !== live.lastVisualBody && !alreadyStored) {
      live.lastVisualBody = normalized
      this.emitEvent(live.spec, 'text', normalized, {
        role: 'assistant',
        provider: live.spec.provider,
        source: 'terminal_screen'
      })
    }

    const reset = parseUsageLimitReset(normalized)
    if (reset) {
      if (!live.limitDetected) {
        live.limitDetected = true
        live.limitResumeAt = reset.toISOString()
        this.database.saveContinuation(id, live.spec.projectId, live.spec.sessionId, reset.toISOString())
        this.emitEvent(live.spec, 'error', `Usage limit reached. Continuation available ${reset.toLocaleString()}.`, {
          title: 'Usage limit reached',
          resumeAt: reset.toISOString(),
          automatic: Boolean(live.spec.continueOnLimit)
        })
      }
      live.workPending = false
      if (live.activityTimer) clearTimeout(live.activityTimer)
      live.status = 'limited'
      this.database.setAgentStatus(id, 'limited', 'limited')
      broadcast('agent:status', {
        id,
        status: 'limited',
        phase: 'limited',
        resumeAt: reset.toISOString(),
        model: live.spec.model ?? 'default'
      })
      if (live.spec.continueOnLimit) this.scheduleContinuation(live.spec, reset)
      return
    }

    if (!live.workPending) return

    live.workPending = false
    if (live.activityTimer) clearTimeout(live.activityTimer)
    live.status = 'complete'
    this.database.setAgentStatus(id, 'complete', 'complete')
    broadcast('agent:status', {
      id,
      status: 'complete',
      phase: 'complete',
      model: live.spec.model ?? 'default'
    })
  }

  interrupt(id: string): void {
    if (this.database.structured.snapshot(id)) { void this.structured.interrupt(id).catch(() => {}); return }
    const live = this.agents.get(id)
    if (!live) return
    live.process.write('\u0003')
    live.workPending = false
    if (live.activityTimer) clearTimeout(live.activityTimer)
    live.status = 'complete'
    this.database.setAgentStatus(id, 'complete', 'complete')
    broadcast('agent:status', {
      id,
      status: 'complete',
      phase: 'complete',
      model: live.spec.model ?? 'default'
    })
  }

  killProject(projectId: string): void {
    this.nativeCli.killWhere((spec) => spec.projectId === projectId)
    this.structured.killWhere(spec => spec.projectId === projectId)
    for (const [id, agent] of this.agents) {
      if (agent.spec.projectId === projectId) this.kill(id)
    }
  }

  killSession(sessionId: string): void {
    this.nativeCli.killWhere((spec) => spec.sessionId === sessionId)
    this.structured.killWhere(spec => spec.sessionId === sessionId)
    for (const [id, agent] of this.agents) {
      if (agent.spec.sessionId === sessionId) this.kill(id)
    }
  }

  dispose(): void {
    this.nativeCli.dispose()
    this.structured.dispose()
    this.disposing = true
    for (const id of [...this.agents.keys()]) this.kill(id, false)
    for (const timer of this.continuationTimers.values()) clearTimeout(timer)
    this.continuationTimers.clear()
  }

  private spawn(spec: AgentSpec, forceFresh = false): RuntimeEnsureResult {
    const provider = providers[spec.provider]
    const transcript = this.database.upsertAgent(spec, 'starting')
    const executable = provider.resolveExecutable()
    if (!executable) {
      const message = `${provider.displayName} CLI was not found. Add it to PATH or set CONDUCTOR_${spec.provider.toUpperCase()}_PATH.`
      this.database.setAgentStatus(spec.id, 'unavailable', 'failed')
      this.emitEvent(spec, 'error', message)
      return { id: spec.id, available: false, status: 'unavailable', transcript, message }
    }

    // After an application restart, a pane with a transcript represents a prior CLI session.
    // Ask the provider to resume its most recent project-scoped conversation when supported.
    const resumeAttempt = !forceFresh && (Boolean(spec.resume) || transcript.length > 0)
    const launch = provider.launch({ ...spec, resume: resumeAttempt }, executable)
    try {
      const process = pty.spawn(launch.executable, launch.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 34,
        cwd: spec.cwd,
        useConptyDll: globalThis.process.platform === 'win32',
        env: { ...globalThis.process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
          string,
          string
        >
      })
      const live: LiveAgent = {
        process,
        spec,
        executable,
        resumeAttempt,
        resumeFailed: false,
        pendingTranscript: '',
        limitProbe: '',
        limitDetected: false,
        lastQuestionAt: 0,
        capturedMemories: new Set(),
        reportedInteractions: new Set(),
        suppressActivityUntil: 0,
        workPending: false,
        inputBuffer: '',
        lastOutputSignal: '',
        lastVisualBody: '',
        status: 'running'
      }
      this.agents.set(spec.id, live)
      this.database.setAgentStatus(spec.id, 'running', 'idle')
      this.emitEvent(spec, 'activity', `${provider.displayName} session started`, {
        executable,
        resumed: Boolean(spec.resume)
      })

      process.onData((data) => {
        const currentSpec = live.spec
        broadcast('agent:data', { id: currentSpec.id, data })
        live.pendingTranscript += data
        const plainText = stripAnsi(data)
        const outputSignal = normalizeAgentOutputSignal(plainText)
        const meaningfulOutput = Boolean(outputSignal && outputSignal !== live.lastOutputSignal)
        if (meaningfulOutput) {
          live.lastOutputSignal = outputSignal
        }
        live.limitProbe = `${live.limitProbe}${plainText}`.slice(-4000)
        // Terminal runtimes carry the same write contract as structured ones, so they share
        // its single parser rather than keeping a second copy of the sentinel and kind list.
        for (const captured of captureMemories(live.limitProbe)) {
          const key = capturedMemoryKey(undefined, captured)
          if (live.capturedMemories.has(key)) continue
          live.capturedMemories.add(key)
          const memory = this.database.remember({
            projectId: currentSpec.projectId,
            agentKey: currentSpec.provider,
            source: 'agent',
            origin: { agentSessionId: currentSpec.id, workspaceId: currentSpec.sessionId, title: currentSpec.title, provider: currentSpec.provider },
            ...captured,
            confidence: captured.confidence ?? 0.72,
            salience: captured.salience ?? 0.58
          })
          this.emitEvent(currentSpec, 'artifact', `Stored distilled ${captured.kind} memory: ${memory.gist}`, { memoryId: memory.id })
        }
        if (meaningfulOutput && !live.limitDetected && shouldSignalAgentOutput(live.workPending, live.suppressActivityUntil)) {
          live.status = 'running'
          this.database.setAgentStatus(currentSpec.id, 'running', 'working')
          broadcast('agent:status', {
            id: currentSpec.id,
            status: 'running',
            phase: 'working',
            model: currentSpec.model ?? 'default'
          })
          if (live.activityTimer) clearTimeout(live.activityTimer)
          live.activityTimer = setTimeout(() => {
            if (!this.agents.has(currentSpec.id) || live.limitDetected) return
            this.database.setAgentStatus(currentSpec.id, 'complete', 'complete')
            live.status = 'complete'
            live.workPending = false
            broadcast('agent:status', {
              id: currentSpec.id,
              status: 'complete',
              phase: 'complete',
              model: live.spec.model ?? 'default'
            })
          }, 4_000)
        }
        const reset = parseUsageLimitReset(live.limitProbe)
        if (reset && !live.limitDetected) {
          live.limitDetected = true
          live.limitResumeAt = reset.toISOString()
          if (live.activityTimer) clearTimeout(live.activityTimer)
          live.status = 'limited'
          this.database.setAgentStatus(currentSpec.id, 'limited', 'limited')
          this.database.saveContinuation(currentSpec.id, currentSpec.projectId, currentSpec.sessionId, reset.toISOString())
          this.emitEvent(currentSpec, 'error', `Usage limit reached. Continuation available ${reset.toLocaleString()}.`, {
            title: 'Usage limit reached',
            resumeAt: reset.toISOString(),
            automatic: Boolean(currentSpec.continueOnLimit)
          })
          broadcast('agent:status', {
            id: currentSpec.id,
            status: 'limited',
            phase: 'limited',
            resumeAt: reset.toISOString(),
            model: currentSpec.model ?? 'default'
          })
          if (currentSpec.continueOnLimit) this.scheduleContinuation(currentSpec, reset)
        } else if (
          !live.limitDetected &&
          Date.now() - live.lastQuestionAt > 4000 &&
          /(?:do you (?:want|trust)|would you like|quick safety check|yes, i trust this folder|please (?:choose|select|confirm)|waiting for (?:your )?input|allow .+\?|approve .+\?)/i.test(live.limitProbe.slice(-1600))
        ) {
          live.lastQuestionAt = Date.now()
          live.workPending = false
          if (live.activityTimer) clearTimeout(live.activityTimer)
          live.status = 'waiting_input'
          this.database.setAgentStatus(currentSpec.id, 'waiting_input', 'waiting_input')
          const directoryTrust = /do you trust\s+the contents\s+of this directory|quick safety check:[\s\S]*yes, i trust this folder/i.test(live.limitProbe.slice(-1600))
          if (directoryTrust) live.reportedInteractions.add('directory_trust')
          this.emitEvent(
            currentSpec,
            'question',
            directoryTrust
              ? 'Do you trust the contents of this directory? Trusting it allows project-local config, hooks, and execution policies to load.'
              : 'Agent is waiting for input.',
            directoryTrust
              ? {
                  title: 'Directory trust required',
                  kind: 'directory_trust',
                  options: ['Trust and continue', "Don't trust — quit"],
                  acceptInput: currentSpec.provider === 'claude' ? '\u001b[B\r' : '\r',
                  rejectInput: currentSpec.provider === 'claude' ? '\r' : '\u001b[B\r'
                }
              : undefined
          )
          broadcast('agent:status', {
            id: currentSpec.id,
            status: 'waiting_input',
            phase: 'waiting_input',
            model: currentSpec.model ?? 'default'
          })
        }
        if (
          live.resumeAttempt &&
          /no (conversation|saved session|session).*?(found|available)|nothing to resume/i.test(plainText)
        ) {
          live.resumeFailed = true
        }
        if (!live.flushTimer) live.flushTimer = setTimeout(() => this.flush(live), 450)
      })
      process.onExit(({ exitCode }) => {
        this.flush(live)
        if (live.activityTimer) clearTimeout(live.activityTimer)
        const currentSpec = live.spec
        // A model/effort restart reuses the same agent id. The old PTY can emit
        // its exit after the replacement has already been installed in the map;
        // never let that stale exit delete or mark the new runtime as exited.
        if (this.agents.get(currentSpec.id) !== live) return
        this.agents.delete(currentSpec.id)
        if (this.database.getContinuation(currentSpec.id)?.status === 'pending') {
          this.database.setAgentStatus(currentSpec.id, 'limited', 'limited')
          return
        }
        this.database.setAgentStatus(currentSpec.id, 'exited', 'idle')
        if (live.resumeFailed && !this.disposing) {
          this.emitEvent(currentSpec, 'activity', `No prior ${provider.displayName} conversation was available; starting fresh.`)
          broadcast('agent:data', { id: currentSpec.id, data: '\u001b[2J\u001b[H' })
          setTimeout(() => this.spawn({ ...currentSpec, resume: false }, true), 150)
          return
        }
        const status = exitCode === 0 ? 'task_complete' : 'error'
        this.emitEvent(currentSpec, status, `${provider.displayName} exited with code ${exitCode}`, { exitCode })
        broadcast('agent:status', { id: currentSpec.id, status: 'exited', exitCode })
      })

      broadcast('agent:status', { id: spec.id, status: 'running', phase: 'idle', model: spec.model ?? 'default' })
      return { id: spec.id, available: true, status: 'running', transcript, executable, model: spec.model ?? 'default' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.database.setAgentStatus(spec.id, 'error', 'error')
      this.emitEvent(spec, 'error', message)
      return { id: spec.id, available: false, status: 'error', transcript, message, executable }
    }
  }

  private kill(id: string, clearContinuation = true): void {
    const live = this.agents.get(id)
    if (!live) return
    this.flush(live)
    if (live.activityTimer) clearTimeout(live.activityTimer)
    try {
      live.process.kill()
    } catch {
      // Already exited.
    }
    this.agents.delete(id)
    try {
      this.collaboration?.releaseAgent(id)
    } catch {
      // Runtime shutdown remains best-effort when collaboration storage is unavailable.
    }
    this.cancelContinuationTimer(id)
    if (clearContinuation) this.database.clearContinuation(id)
    const pendingContinuation = this.database.getContinuation(id)?.status === 'pending'
    this.database.setAgentStatus(id, pendingContinuation ? 'limited' : 'exited', pendingContinuation ? 'limited' : 'idle')
  }

  private cancelContinuationTimer(id: string): void {
    const continuationTimer = this.continuationTimers.get(id)
    if (continuationTimer) clearTimeout(continuationTimer)
    this.continuationTimers.delete(id)
  }

  private scheduleContinuation(spec: AgentSpec, resumeAt: Date): void {
    const current = this.continuationTimers.get(spec.id)
    if (current) clearTimeout(current)
    const delay = Math.max(0, resumeAt.getTime() - Date.now())
    const timer = setTimeout(() => {
      this.continuationTimers.delete(spec.id)
      if (resumeAt.getTime() > Date.now() + 1000) {
        this.scheduleContinuation(spec, resumeAt)
        return
      }
      const live = this.agents.get(spec.id)
      if (live) {
        live.limitProbe = ''
        live.limitDetected = false
        live.limitResumeAt = undefined
        live.status = 'running'
        this.database.completeContinuation(spec.id)
        this.submitMessage(spec.id, 'continue')
      } else {
        const result = this.spawn({ ...spec, resume: true })
        if (!result.available) return
        this.database.completeContinuation(spec.id)
        setTimeout(() => this.submitMessage(spec.id, 'continue'), 1400)
      }
      this.emitEvent(spec, 'activity', 'Usage window reopened; Conductor asked the agent to continue.', {
        resumedAt: new Date().toISOString()
      })
    }, Math.min(delay, 2_147_000_000))
    this.continuationTimers.set(spec.id, timer)
  }

  private submitMessage(id: string, message: string): void {
    const live = this.agents.get(id)
    if (!live) return
    this.beginWork(live)
    live.process.write(message)
    setTimeout(() => {
      if (this.agents.get(id) === live) live.process.write('\r')
    }, 75)
  }

  private beginWork(live: LiveAgent): void {
    if (live.activityTimer) clearTimeout(live.activityTimer)
    live.workPending = true
    live.status = 'running'
    this.database.setAgentStatus(live.spec.id, 'running', 'working')
    broadcast('agent:status', {
      id: live.spec.id,
      status: 'running',
      phase: 'working',
      model: live.spec.model ?? 'default'
    })
    // A provider normally emits output immediately. This fallback prevents a
    // swallowed submission from leaving the UI in a permanent working state.
    live.activityTimer = setTimeout(() => {
      if (this.agents.get(live.spec.id) !== live || !live.workPending || live.limitDetected) return
      live.workPending = false
      live.status = 'complete'
      this.database.setAgentStatus(live.spec.id, 'complete', 'complete')
      broadcast('agent:status', {
        id: live.spec.id,
        status: 'complete',
        phase: 'complete',
        model: live.spec.model ?? 'default'
      })
    }, 8_000)
  }

  private flush(live: LiveAgent): void {
    if (live.flushTimer) clearTimeout(live.flushTimer)
    live.flushTimer = undefined
    if (live.pendingTranscript) {
      this.database.appendAgentTranscript(live.spec.id, live.pendingTranscript)
      live.pendingTranscript = ''
    }
    // The renderer persists provider prose after xterm has applied cursor moves
    // and row overwrites. Raw byte chunks are intentionally transcript-only.
  }

  private emitEvent(
    spec: AgentSpec,
    type: NormalizedAgentEvent['type'],
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    const event: NormalizedAgentEvent = {
      id: makeId('event'),
      agentSessionId: spec.id,
      type,
      message,
      metadata,
      createdAt: new Date().toISOString()
    }
    this.database.appendEvent(spec.projectId, spec.sessionId, event)
    try {
      this.collaboration?.observeEvent(spec, event)
    } catch {
      // Presence extraction is auxiliary and must not disrupt provider output.
    }
    broadcast('agent:event', event)
  }
}
