import type { AgentEvent } from '../../../shared/structured-agent'
import { toolSubject } from '../../../shared/conversation-transcript'

/** Where the log stands: the item it last wrote to, whether its last line is still open, and
 *  what has been written per item, so a stream of deltas and the snapshot that closes it print
 *  once and a tool's end is reported once. */
export interface LiveLogState { last: string; open: boolean; phase: string; written: Map<string, { chars: number; ended: boolean }> }
export const createLiveLogState = (): LiveLogState => ({ last: '', open: false, phase: '', written: new Map() })

const dim = (text: string): string => '\x1b[2m' + text + '\x1b[22m'
const color = (code: number, text: string): string => `\x1b[${code}m` + text + '\x1b[39m'
/** Continuation lines line up under the text after a four-column gutter. */
const indent = (text: string): string => text.replace(/\r?\n/g, '\r\n').replace(/\r\n(?!$)/g, '\r\n    ')
/** A tool's output is shown as a head; the Chat card and the event log keep all of it. */
const OUTPUT_LIMIT = 2400
const TERMINAL = new Set(['completed', 'failed', 'rejected', 'interrupted'])

/**
 * The live activity view under a Chat conversation: the same agent's work written as a terminal
 * would show it - prompts, streamed answers, each tool call with its output as it arrives,
 * approvals, errors and the runtime's own diagnostics. It is derived from the conversation's
 * event stream, so it is read-only; the native CLI takes over once Chat is idle.
 */
export function formatLiveEvents(events: AgentEvent[], state: LiveLogState): string {
  let out = ''
  const write = (text: string): void => { if (!text) return; out += text; state.open = !text.replace(/\x1b\[[0-9;]*m/g, '').endsWith('\n') }
  const line = (text: string): void => { if (state.open) write('\r\n'); write(text + '\r\n'); state.last = '' }
  const start = (key: string, header: string): void => {
    if (state.last === key) return
    if (state.open) write('\r\n')
    write(header)
    state.last = key
  }
  for (const event of events) {
    const data = event.data
    const key = event.itemId ?? event.requestId ?? event.id
    const seen = state.written.get(key)
    if (data.type === 'session') {
      if (data.phase !== state.phase) { state.phase = data.phase; line(dim('── ' + data.phase.replaceAll('_', ' ') + ' ──')) }
      continue
    }
    if (data.type === 'text') {
      if (data.role === 'status' || !data.text) continue
      const written = seen?.chars ?? 0
      // A snapshot after its deltas repeats them; only what goes beyond them is new.
      const fresh = data.mode === 'delta' ? data.text : data.text.slice(written)
      if (!fresh) continue
      start(key, data.role === 'user' ? color(36, '❯ ') : '● ')
      write(data.role === 'user' ? color(36, indent(fresh)) : indent(fresh))
      state.written.set(key, { chars: written + fresh.length, ended: false })
      continue
    }
    if (data.type === 'tool') {
      if (!seen) {
        const subject = toolSubject(data)
        start(key, color(33, '● ' + data.name) + (subject ? ' ' + dim(subject) : '') + '\r\n')
        state.written.set(key, { chars: 0, ended: false })
      }
      const entry = state.written.get(key)!
      const output = data.output && entry.chars < OUTPUT_LIMIT ? (data.outputMode === 'delta' ? data.output : entry.chars ? '' : data.output) : ''
      if (output) {
        // Another item wrote in between: say whose output this is again.
        start(key, color(33, '● ' + data.name) + dim(' (continued)') + '\r\n')
        const shown = output.slice(0, OUTPUT_LIMIT - entry.chars)
        write((state.open ? '' : '    ') + dim(indent(shown)))
        entry.chars += output.length
        if (entry.chars >= OUTPUT_LIMIT) write(dim(' … (full output in Chat)'))
      }
      if (TERMINAL.has(data.status) && !entry.ended) {
        entry.ended = true
        const ending = data.status === 'completed' ? (data.exitCode ? 'exit ' + data.exitCode : 'done') : data.status
        line('    ' + (data.status === 'completed' && !data.exitCode ? dim('⎿ ' + ending) : color(31, '⎿ ' + ending)))
      }
      continue
    }
    if (data.type === 'interaction') {
      const interaction = data.interaction
      if (!seen) {
        start(key, color(35, '? ' + interaction.title) + (interaction.status === 'pending' ? dim('  (answer in Chat)') : '') + '\r\n')
        state.written.set(key, { chars: 0, ended: false })
      }
      const entry = state.written.get(key)!
      if (interaction.status !== 'pending' && !entry.ended) { entry.ended = true; line('    ' + dim('⎿ ' + (interaction.outcome ?? interaction.status))) }
      continue
    }
    if (data.type === 'subagent') {
      if (seen?.ended || (seen && state.last === key + ':' + data.status)) continue
      line(color(34, '● Subagent ' + data.name) + ' ' + dim(data.status))
      state.last = key + ':' + data.status
      state.written.set(key, { chars: 0, ended: TERMINAL.has(data.status) })
      continue
    }
    if (data.type === 'changes') {
      for (const change of data.changes) line('    ' + color(32, '✎ ' + change.path) + (change.additions !== undefined ? dim(` +${change.additions} −${change.deletions ?? 0}`) : ''))
      continue
    }
    if (data.type === 'error') { line(color(31, '✗ ' + indent(data.message.trimEnd()))); continue }
    if (data.type === 'notice') {
      // The runtime's own diagnostics are exactly what Chat hides; here they are the point.
      const payload = data.payload
      const stderr = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.stderr === 'string' ? payload.stderr
        : typeof payload === 'string' && event.native?.method.includes('stderr') ? payload : ''
      line(dim('· ' + indent((stderr || data.message).trimEnd())))
    }
  }
  return out
}
