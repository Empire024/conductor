import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { join } from 'node:path'
import type { AgentSpec, RuntimeEnsureResult } from '../shared/models'
import type { SessionSettings, StructuredProvider } from '../shared/structured-agent'
import type { StructuredSessions } from './structured-sessions'
import type { ConductorDatabase } from './database'
import { providerEnvironment } from './provider-environment'

export function nativeCliArgs(provider: StructuredProvider, nativeId: string, settings: SessionSettings, fresh = false, claudeFullAutoAuthorized = false): string[] {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(nativeId)) throw new Error('Invalid native conversation ID')
  const model = settings.model && settings.model !== 'default' ? ['--model', settings.model] : []
  if (provider === 'codex') return [
    'resume', nativeId, ...model,
    ...(settings.effort && settings.effort !== 'auto' ? ['-c', 'model_reasoning_effort=' + JSON.stringify(settings.effort)] : []),
    ...(settings.sandbox && settings.sandbox !== 'inherit' ? ['--sandbox', settings.sandbox] : settings.permission === 'read-only' ? ['--sandbox', 'read-only'] : []),
    ...(settings.approvalPolicy && settings.approvalPolicy !== 'inherit' ? ['-c', 'approval_policy=' + JSON.stringify(settings.approvalPolicy)] : [])
  ]
  // Grok's TUI takes Claude-compatible session flags and its own permission-mode names.
  if (provider === 'grok') return [fresh ? '--session-id' : '--resume', nativeId, ...model,
    ...(settings.effort && settings.effort !== 'auto' ? ['--reasoning-effort', settings.effort] : []),
    '--permission-mode', settings.plan ? 'plan' : settings.permission === 'accept-edits' ? 'acceptEdits' : settings.permission === 'read-only' ? 'dontAsk' : settings.permission === 'auto' ? 'auto' : 'default']
  return [fresh ? '--session-id' : '--resume', nativeId, ...model,
    ...(settings.effort && settings.effort !== 'auto' ? ['--effort', settings.effort] : []),
    '--permission-mode', settings.plan ? 'plan' : settings.permission === 'accept-edits' ? 'acceptEdits' : settings.permission === 'read-only' ? 'plan' : settings.permission === 'auto' ? (claudeFullAutoAuthorized && !settings.claudeGuardedAuto ? 'bypassPermissions' : 'auto') : 'manual',
    ...(claudeFullAutoAuthorized && settings.permission === 'auto' && !settings.plan && !settings.claudeGuardedAuto ? ['--allow-dangerously-skip-permissions'] : [])]
}
export interface NativeCliInputState { draft: string; submitted: boolean }

/** The native TUI does not expose a turn lifecycle API. A non-empty Enter is the one reliable
 * execution signal available; Ctrl+C and process exit are the corresponding reliable stops. */
export function trackNativeCliInput(state: NativeCliInputState, data: string): NativeCliInputState {
  let draft = state.draft
  let submitted = state.submitted
  for (const character of data) {
    if (character === '\x03') { draft = ''; submitted = false; continue }
    if (character === '\x15') { draft = ''; continue }
    if (character === '\x7f' || character === '\b') { draft = draft.slice(0, -1); continue }
    if (character === '\r' || character === '\n') {
      if (/\S/.test(draft)) submitted = true
      draft = ''
      continue
    }
    if (character >= ' ') draft = (draft + character).slice(-600_000)
  }
  return { draft, submitted }
}

interface LiveCli { spec: AgentSpec; process: IPty; exited: boolean; transcript: string; sequence: number; input: NativeCliInputState; stopped: Promise<void>; resolveStopped(): void; launchedFullAuto?: boolean; policyBlocked?: boolean }
export class NativeCliManager {
  private live = new Map<string, LiveCli>()
  private returning = new Map<string, Promise<void>>()
  private switching = new Map<string, Promise<RuntimeEnsureResult & { sequence: number }>>()
  private claudeFullAutoPolicy: () => boolean = () => false
  setClaudeFullAutoPolicy(policy: () => boolean): void { this.claudeFullAutoPolicy = policy }
  /** Interactive Claude CLIs that were launched with bypassPermissions and are still running. */
  claudeFullAutoTabs(): Array<{ agentSessionId: string; title: string; projectId: string }> {
    return [...this.live].filter(([, live]) => !live.exited && live.spec.provider === 'claude' && live.launchedFullAuto)
      .map(([id, live]) => ({ agentSessionId: id, title: this.database.structured.snapshot(id)?.title || live.spec.title, projectId: live.spec.projectId }))
  }
  /** The interactive TUI has no acknowledged permission setter. Idle handoffs return to the
   * structured runtime safely; an in-flight command stays alive and is reported as blocked. */
  async refreshClaudeFullAutoPolicy(): Promise<Array<{ agentSessionId: string; status: 'confirmed' | 'blocked'; error?: string }>> {
    const results: Array<{ agentSessionId: string; status: 'confirmed' | 'blocked'; error?: string }> = []
    for (const [id, live] of this.live) {
      if (live.exited || live.spec.provider !== 'claude') continue
      const settings = this.database.structured.snapshot(id)?.settings
      const requested = live.spec.profile !== 'evaluation' && !this.sessions.isApprovalReviewer?.(id) && this.claudeFullAutoPolicy() && settings?.permission === 'auto' && !settings.plan && !settings.claudeGuardedAuto
      if (Boolean(live.launchedFullAuto) === Boolean(requested)) { live.policyBlocked = false; continue }
      if (live.input.submitted) {
        const error = 'The interactive Claude CLI has submitted work and no acknowledged permission-mode control. That work is preserved; additional terminal input is blocked until it can return to Chat safely.'
        if (!live.policyBlocked) this.broadcast('native-cli:data', { id, data: `\r\n[Conductor] ${error}\r\n`, sequence: ++live.sequence })
        live.policyBlocked = true
        results.push({ agentSessionId: id, status: 'blocked', error })
      } else {
        try { await this.switchToChat(id); results.push({ agentSessionId: id, status: 'confirmed' }) }
        catch (error) { results.push({ agentSessionId: id, status: 'blocked', error: error instanceof Error ? error.message : String(error) }) }
      }
    }
    return results
  }
  constructor(private sessions: StructuredSessions, private database: ConductorDatabase, private executable: (provider: StructuredProvider) => string | null, private broadcast: (channel: string, payload: unknown) => void) {}
  ensure(id: string): Promise<RuntimeEnsureResult & { sequence: number }> {
    if (this.returning.has(id)) return Promise.reject(new Error('This conversation is switching to Chat.'))
    const current = this.live.get(id)
    if (current && !current.exited) return Promise.resolve({ id, available: true, status: 'running', transcript: current.transcript, sequence: current.sequence })
    const pending = this.switching.get(id)
    if (pending) return pending
    const task = this.start(id).finally(() => { if (this.switching.get(id) === task) this.switching.delete(id) })
    this.switching.set(id, task); return task
  }
  private async start(id: string): Promise<RuntimeEnsureResult & { sequence: number }> {
    const offline = process.env.CONDUCTOR_OFFLINE_TESTS === '1'
    const spec = this.sessions.cliSpec(id)
    const executable = offline ? process.env.CONDUCTOR_TEST_NODE_EXECUTABLE || process.execPath : this.executable(spec.provider as StructuredProvider)
    if (!executable) throw new Error('The provider CLI is unavailable')
    if (this.database.structured.snapshot(id)?.settings.plan && spec.provider === 'codex') throw new Error('Turn off Plan mode before switching to the Codex CLI.')
    const handoff = await this.sessions.prepareCli(id)
    try {
      const authorized = handoff.spec.provider === 'claude' && handoff.spec.profile !== 'evaluation' && !this.sessions.isApprovalReviewer?.(id) && this.claudeFullAutoPolicy()
      const args = nativeCliArgs(handoff.spec.provider as StructuredProvider, handoff.nativeSessionId, handoff.settings, handoff.fresh, authorized)
      const child = pty.spawn(executable, offline ? [join(process.cwd(), 'scripts/fixtures/native-cli.cjs'), handoff.nativeSessionId] : args, {
        name: 'xterm-256color', cols: 100, rows: 30, cwd: handoff.spec.cwd, useConptyDll: process.platform === 'win32',
        env: { ...providerEnvironment(), CONDUCTOR_AGENT_ID: id, CONDUCTOR_TASK_FILE: 'feature-list.md', ...(offline ? { ELECTRON_RUN_AS_NODE: '1' } : {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
      })
      let resolveStopped!: () => void
      const stopped = new Promise<void>((resolve) => { resolveStopped = resolve })
      const live: LiveCli = { spec: handoff.spec, process: child, exited: false, transcript: '', sequence: 0, input: { draft: '', submitted: false }, stopped, resolveStopped, launchedFullAuto: authorized && args.includes('bypassPermissions') }
      this.live.set(id, live)
      child.onData((data) => {
        if (this.live.get(id) !== live) return
        live.transcript = (live.transcript + data).slice(-256000)
        this.broadcast('native-cli:data', { id, data, sequence: ++live.sequence })
      })
      child.onExit(({ exitCode }) => {
        live.exited = true; live.input = { draft: '', submitted: false }; live.resolveStopped()
        if (this.live.get(id) !== live) return
        this.broadcast('native-cli:status', { id, status: 'exited', exitCode })
      })
      return { id, available: true, status: 'running', transcript: live.transcript, sequence: live.sequence, executable }
    } catch (error) {
      this.sessions.cancelCli(id)
      throw error
    }
  }
  write(id: string, data: string): void {
    const live = this.live.get(id)
    if (!live || live.exited || typeof data !== 'string' || data.length > 1000000) return
    // Stop remains available; new submissions cannot use a mode whose policy was revoked.
    if (live.policyBlocked && data !== '\x03') return
    live.input = trackNativeCliInput(live.input, data)
    live.process.write(data)
    if (live.policyBlocked && data === '\x03') void this.switchToChat(id).catch(error => this.broadcast('native-cli:data', { id, data: `\r\n[Conductor] ${String(error)}\r\n`, sequence: ++live.sequence }))
  }
  hasSubmittedInput(id?: string): boolean {
    if (id) { const live = this.live.get(id); return Boolean(live && !live.exited && live.input.submitted) }
    return [...this.live.values()].some(live => !live.exited && live.input.submitted)
  }
  resize(id: string, cols: number, rows: number): void { const live = this.live.get(id); if (live && !live.exited && Number.isInteger(cols) && Number.isInteger(rows)) live.process.resize(Math.max(2, Math.min(500, cols)), Math.max(2, Math.min(300, rows))) }
  switchToChat(id: string): Promise<void> {
    const pending = this.returning.get(id)
    if (pending) return pending
    const task = this.finishChat(id).finally(() => { if (this.returning.get(id) === task) this.returning.delete(id) })
    this.returning.set(id, task)
    return task
  }
  private async finishChat(id: string): Promise<void> {
    const starting = this.switching.get(id)
    if (starting) await starting
    const live = this.live.get(id)
    if (live && !live.exited) {
      live.process.kill()
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([live.stopped, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The CLI process has not exited yet. Try again shortly.')), 5000) })]) } finally { clearTimeout(timer) }
    }
    await this.sessions.finishCli(id)
    this.live.delete(id)
  }
  killWhere(predicate: (spec: AgentSpec) => boolean): void { for (const [id, live] of this.live) if (predicate(live.spec)) { if (!live.exited) live.process.kill(); this.live.delete(id) } }
  dispose(): void { this.killWhere(() => true) }
}
