import { createReadStream, existsSync } from 'node:fs'
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
export function historyEvent(item: NativeHistoryItem, handoff: string): AdapterEvent {
  return { itemId: 'cli:' + handoff + ':' + item.id, turnId: item.turnId, data: item.data, native: { method: 'cli/history', payload: { itemId: item.id } } }
}
