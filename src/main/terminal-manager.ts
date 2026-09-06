import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { RuntimeEnsureResult, TerminalSpec } from '../shared/models'
import type { ConductorDatabase } from './database'

interface LiveTerminal {
  process: IPty
  spec: TerminalSpec
  executable: string
  pendingTranscript: string
  flushTimer?: NodeJS.Timeout
}

const broadcast = (channel: string, payload: unknown): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, LiveTerminal>()

  constructor(private readonly database: ConductorDatabase) {}

  ensure(spec: TerminalSpec): RuntimeEnsureResult {
    const existing = this.terminals.get(spec.id)
    if (existing) {
      return {
        id: spec.id,
        available: true,
        status: 'running',
        transcript: this.database.getTerminalTranscript(spec.id),
        executable: existing.executable
      }
    }
    return this.spawn(spec)
  }

  restart(spec: TerminalSpec): RuntimeEnsureResult {
    this.kill(spec.id)
    return this.spawn(spec)
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 1) return
    try {
      this.terminals.get(id)?.process.resize(cols, rows)
    } catch {
      // PTYs may exit between ResizeObserver delivery and this call.
    }
  }

  kill(id: string): void {
    const terminal = this.terminals.get(id)
    if (!terminal) return
    this.flush(terminal)
    try {
      terminal.process.kill()
    } catch {
      // The process may already have exited.
    }
    this.terminals.delete(id)
    this.database.setTerminalStatus(id, 'exited')
  }

  killProject(projectId: string): void {
    for (const [id, terminal] of this.terminals) {
      if (terminal.spec.projectId === projectId) this.kill(id)
    }
  }

  killSession(sessionId: string): void {
    for (const [id, terminal] of this.terminals) {
      if (terminal.spec.sessionId === sessionId) this.kill(id)
    }
  }

  dispose(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id)
  }

  private spawn(spec: TerminalSpec): RuntimeEnsureResult {
    const transcript = this.database.upsertTerminal(spec, 'starting')
    const executable = spec.shell || this.defaultShell()
    const args = this.shellArgs(executable)

    try {
      const process = pty.spawn(executable, args, {
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
      const live: LiveTerminal = { process, spec, executable, pendingTranscript: '' }
      this.terminals.set(spec.id, live)
      this.database.setTerminalStatus(spec.id, 'running')

      process.onData((data) => {
        broadcast('terminal:data', { id: spec.id, data })
        this.bufferTranscript(live, data)
      })
      process.onExit(({ exitCode }) => {
        this.flush(live)
        this.terminals.delete(spec.id)
        this.database.setTerminalStatus(spec.id, 'exited')
        broadcast('terminal:status', { id: spec.id, status: 'exited', exitCode })
      })

      if (spec.startupCommand) process.write(`${spec.startupCommand}\r`)
      broadcast('terminal:status', { id: spec.id, status: 'running' })
      return { id: spec.id, available: true, status: 'running', transcript, executable }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.database.setTerminalStatus(spec.id, 'error')
      return { id: spec.id, available: false, status: 'error', transcript, message, executable }
    }
  }

  private defaultShell(): string {
    if (process.platform !== 'win32') return process.env.SHELL || '/bin/bash'
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return existsSync(powershell) ? powershell : 'powershell.exe'
  }

  private shellArgs(executable: string): string[] {
    const name = executable.toLowerCase()
    if (name.includes('powershell') || name.endsWith('pwsh.exe') || name.endsWith('pwsh')) {
      return ['-NoLogo']
    }
    return []
  }

  private bufferTranscript(terminal: LiveTerminal, data: string): void {
    terminal.pendingTranscript += data
    if (terminal.flushTimer) return
    terminal.flushTimer = setTimeout(() => this.flush(terminal), 350)
  }

  private flush(terminal: LiveTerminal): void {
    if (terminal.flushTimer) clearTimeout(terminal.flushTimer)
    terminal.flushTimer = undefined
    if (!terminal.pendingTranscript) return
    this.database.appendTerminalTranscript(terminal.spec.id, terminal.pendingTranscript)
    terminal.pendingTranscript = ''
  }
}
