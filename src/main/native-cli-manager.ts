import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { join } from 'node:path'
import type { AgentSpec, RuntimeEnsureResult } from '../shared/models'
import type { SessionSettings, StructuredProvider } from '../shared/structured-agent'
import type { StructuredSessions } from './structured-sessions'
import type { ConductorDatabase } from './database'

export function nativeCliArgs(provider: StructuredProvider, nativeId: string, settings: SessionSettings, fresh = false): string[] {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(nativeId)) throw new Error('Invalid native conversation ID')
  const model = settings.model && settings.model !== 'default' ? ['--model', settings.model] : []
  if (provider === 'codex') return [
    'resume', nativeId, ...model,
    ...(settings.effort && settings.effort !== 'auto' ? ['-c', 'model_reasoning_effort=' + JSON.stringify(settings.effort)] : []),
    ...(settings.sandbox && settings.sandbox !== 'inherit' ? ['--sandbox', settings.sandbox] : settings.permission === 'read-only' ? ['--sandbox', 'read-only'] : []),
    ...(settings.approvalPolicy && settings.approvalPolicy !== 'inherit' ? ['-c', 'approval_policy=' + JSON.stringify(settings.approvalPolicy)] : [])
  ]
  return [fresh ? '--session-id' : '--resume', nativeId, ...model,
    ...(settings.effort && settings.effort !== 'auto' ? ['--effort', settings.effort] : []),
    '--permission-mode', settings.plan ? 'plan' : settings.permission === 'accept-edits' ? 'acceptEdits' : settings.permission === 'read-only' ? 'plan' : settings.permission === 'auto' ? 'auto' : 'manual']
}
interface LiveCli { spec: AgentSpec; process: IPty; exited: boolean; transcript: string; sequence: number; stopped: Promise<void>; resolveStopped(): void }
export class NativeCliManager {
  private live = new Map<string, LiveCli>()
  private returning = new Map<string, Promise<void>>()
  private switching = new Map<string, Promise<RuntimeEnsureResult & { sequence: number }>>()
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
      const args = nativeCliArgs(handoff.spec.provider as StructuredProvider, handoff.nativeSessionId, handoff.settings, handoff.fresh)
      const child = pty.spawn(executable, offline ? [join(process.cwd(), 'scripts/fixtures/native-cli.cjs'), handoff.nativeSessionId] : args, {
        name: 'xterm-256color', cols: 100, rows: 30, cwd: handoff.spec.cwd, useConptyDll: process.platform === 'win32',
        env: { ...process.env, CONDUCTOR_AGENT_ID: id, CONDUCTOR_TASK_FILE: 'feature-list.md', ...(offline ? { ELECTRON_RUN_AS_NODE: '1' } : {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
      })
      let resolveStopped!: () => void
      const stopped = new Promise<void>((resolve) => { resolveStopped = resolve })
      const live: LiveCli = { spec: handoff.spec, process: child, exited: false, transcript: '', sequence: 0, stopped, resolveStopped }
      this.live.set(id, live)
      child.onData((data) => {
        if (this.live.get(id) !== live) return
        live.transcript = (live.transcript + data).slice(-256000)
        this.broadcast('native-cli:data', { id, data, sequence: ++live.sequence })
      })
      child.onExit(({ exitCode }) => {
        live.exited = true; live.resolveStopped()
        if (this.live.get(id) !== live) return
        this.broadcast('native-cli:status', { id, status: 'exited', exitCode })
      })
      return { id, available: true, status: 'running', transcript: live.transcript, sequence: live.sequence, executable }
    } catch (error) {
      this.sessions.cancelCli(id)
      throw error
    }
  }
  write(id: string, data: string): void { const live = this.live.get(id); if (live && !live.exited && typeof data === 'string' && data.length <= 1000000) live.process.write(data) }
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
