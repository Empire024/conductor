import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import type { AdapterEvent, AgentEventData, Json } from '../shared/structured-agent'
export interface NativeHistoryItem { id: string; turnId?: string; data: AgentEventData }
export function claudeHistoryPath(cwd: string, nativeId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(nativeId)) throw new Error('Invalid native conversation ID')
  const directory = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', directory, nativeId + '.jsonl')
}
export function hasClaudeHistory(cwd: string, nativeId: string): boolean { return existsSync(claudeHistoryPath(cwd, nativeId)) }
export async function readClaudeHistory(cwd: string, nativeId: string): Promise<NativeHistoryItem[]> {
  const path = claudeHistoryPath(cwd, nativeId)
  if (!existsSync(path)) return []
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const items = new Map<string, NativeHistoryItem>(), tools = new Map<string, { name: string; input: Json }>()
  try {
    for await (const line of lines) {
      if (line.length > 8 * 1024 * 1024) continue
      let row: { type?: string; uuid?: string; sessionId?: string; isSidechain?: boolean; message?: { id?: string; role?: string; content?: string | Array<Record<string, unknown>> } }
      try { row = JSON.parse(line) } catch { continue }
      if (row.isSidechain || row.sessionId && row.sessionId !== nativeId || !['user', 'assistant'].includes(row.type ?? '') || !row.message) continue
      const messageId = row.uuid ?? row.message.id
      if (!messageId) continue
      const content = typeof row.message.content === 'string' ? [{ type: 'text', text: row.message.content }] : row.message.content ?? []
      content.forEach((block, index) => {
        const id = messageId + ':' + index
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) items.set(id, { id, data: { type: 'text', role: row.type === 'user' ? 'user' : 'assistant', mode: 'snapshot', text: block.text } })
        else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const tool = { name: typeof block.name === 'string' ? block.name : 'Tool', input: block.input as Json }
          tools.set(block.id, tool)
          items.set(block.id, { id: block.id, data: { type: 'tool', ...tool, status: 'interrupted' } })
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const tool = tools.get(block.tool_use_id) ?? { name: 'Tool', input: undefined }
          const output = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : ''
          items.set(block.tool_use_id, { id: block.tool_use_id, data: { type: 'tool', ...tool, status: block.is_error ? 'failed' : 'completed', output } })
        }
      })
      while (items.size > 2000) items.delete(items.keys().next().value!)
      while (tools.size > 2000) tools.delete(tools.keys().next().value!)
    }
  } finally { lines.close(); stream.destroy() }
  return [...items.values()]
}
/** Grok keeps each session in `~/.grok/sessions/<encoded cwd>/<session id>/`; the group name is
 *  an encoding of the working directory, so the session is found by its own directory name. */
export function grokHistoryDirectory(nativeId: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(nativeId)) throw new Error('Invalid native conversation ID')
  const root = join(process.env.GROK_HOME || join(homedir(), '.grok'), 'sessions')
  let groups: string[]
  try { groups = readdirSync(root) } catch { return undefined }
  for (const group of groups.slice(0, 4096)) {
    const directory = join(root, group, nativeId)
    if (existsSync(join(directory, 'updates.jsonl')) || existsSync(join(directory, 'summary.json'))) return directory
  }
  return undefined
}
export function hasGrokHistory(nativeId: string): boolean { return Boolean(grokHistoryDirectory(nativeId)) }
/** Messages and tool calls from Grok's own ACP update log, for a conversation continued in its TUI. */
export async function readGrokHistory(nativeId: string): Promise<NativeHistoryItem[]> {
  const directory = grokHistoryDirectory(nativeId)
  const path = directory && join(directory, 'updates.jsonl')
  if (!path || !existsSync(path)) return []
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const items = new Map<string, NativeHistoryItem>()
  let message: { id: string; role: 'user' | 'assistant'; text: string } | undefined, sequence = 0
  const flush = (): void => {
    if (message?.text.trim()) items.set(message.id, { id: message.id, data: { type: 'text', role: message.role, mode: 'snapshot', text: message.text } })
    message = undefined
  }
  try {
    for await (const line of lines) {
      if (line.length > 8 * 1024 * 1024) continue
      let row: Record<string, unknown>
      try { row = JSON.parse(line) } catch { continue }
      // A line is one ACP session update, bare or still in its notification envelope.
      const params = row.params && typeof row.params === 'object' ? row.params as Record<string, unknown> : row
      const update = (params.update && typeof params.update === 'object' ? params.update : params) as Record<string, unknown>
      const kind = update.sessionUpdate
      sequence++
      if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
        const role = kind === 'user_message_chunk' ? 'user' : 'assistant'
        const content = update.content as { type?: string; text?: string } | undefined
        if (message && message.role !== role) flush()
        message ??= { id: `${role}:${sequence}`, role, text: '' }
        if (content?.type === 'text' && typeof content.text === 'string') message.text += content.text
      } else if ((kind === 'tool_call' || kind === 'tool_call_update') && typeof update.toolCallId === 'string') {
        flush()
        const previous = items.get(update.toolCallId)?.data
        const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : previous?.type === 'tool' ? previous.status : 'interrupted'
        const output = Array.isArray(update.content) ? update.content.flatMap((entry: { type?: string; content?: { text?: unknown } }) => entry?.type === 'content' && typeof entry.content?.text === 'string' ? [entry.content.text] : []).join('\n') : ''
        items.set(update.toolCallId, { id: update.toolCallId, data: { type: 'tool',
          name: previous?.type === 'tool' ? previous.name : typeof update.title === 'string' ? update.title : 'Tool',
          ...(update.rawInput !== undefined ? { input: update.rawInput as Json } : previous?.type === 'tool' && previous.input !== undefined ? { input: previous.input } : {}),
          status, ...(output ? { output } : previous?.type === 'tool' && previous.output ? { output: previous.output } : {}) } })
      }
      while (items.size > 2000) items.delete(items.keys().next().value!)
    }
    flush()
  } finally { lines.close(); stream.destroy() }
  return [...items.values()]
}
export function historyEvent(item: NativeHistoryItem, handoff: string): AdapterEvent {
  return { itemId: 'cli:' + handoff + ':' + item.id, turnId: item.turnId, data: item.data, native: { method: 'cli/history', payload: { itemId: item.id } } }
}
