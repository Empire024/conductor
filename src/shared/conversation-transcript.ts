import type { TimelineItem } from './structured-agent'

type ToolData = Extract<TimelineItem['data'], { type: 'tool' }>
const oneLine = (text: string, max = 160): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
/** Inline code that survives backticks inside it (a shell command often has them). */
const inlineCode = (text: string): string => {
  const fence = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(run => run[0].length)) + 1)
  return fence + (fence.length > 1 || text.startsWith('`') ? ' ' + text + ' ' : text) + fence
}
function field(input: unknown, ...names: string[]): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  for (const name of names) {
    const value = (input as Record<string, unknown>)[name]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}
/** The one thing a tool call acted on - its command, file, pattern or target - on one line. */
export function toolSubject(tool: ToolData): string {
  const subject = field(tool.input, 'command', 'cmd', 'script') ?? field(tool.input, 'pattern', 'query')
    ?? field(tool.input, 'file_path', 'path', 'filePath', 'notebook_path') ?? field(tool.input, 'url', 'skill', 'subagent_type') ?? tool.description ?? field(tool.input, 'description')
  return subject ? oneLine(subject) : ''
}
function toolLine(tool: ToolData): string {
  const subject = toolSubject(tool)
  const status = tool.status === 'completed' ? (tool.exitCode ? 'exit ' + tool.exitCode : '') : tool.status.replaceAll('_', ' ')
  return '- ' + inlineCode(tool.name) + (subject ? ' ' + inlineCode(subject) : '') + (status ? ' (' + status + ')' : '')
}
const quote = (text: string): string => text.split(/\r?\n/).map(line => '> ' + line).join('\n')

export interface TranscriptOptions {
  title: string
  /** How the assistant is named in the headings: "Claude Code", "Codex", a local model's name. */
  assistant: string
  /** Count of events permanently missing before the transcript's first item - gone before this
   *  conversation's durable archive began covering it. Zero or omitted means nothing is missing;
   *  the transcript says so instead of pretending it starts at the beginning. */
  olderUnavailable?: number
}
/** A whole conversation as clean Markdown: one heading per turn change, message text verbatim,
 *  every tool call summarized on one line, approvals and questions with their outcome. Only the
 *  timeline's own activities go in (callers filter with isConversationActivity), so diagnostics,
 *  usage and heartbeats never do. Pure, so the store can build it without the DOM. */
export function conversationMarkdown(items: TimelineItem[], options: TranscriptOptions): { markdown: string; messages: number } {
  const blocks: string[] = ['# ' + oneLine(options.title || 'Conversation', 200)]
  if (options.olderUnavailable) blocks.push(`_… ${options.olderUnavailable.toLocaleString()} earlier ${options.olderUnavailable === 1 ? 'event is' : 'events are'} no longer stored._`)
  let speaker = ''
  let messages = 0
  let list: string[] = []
  const flush = (): void => { if (list.length) blocks.push(list.join('\n')); list = [] }
  const turn = (next: string): void => {
    if (next === speaker) return
    flush()
    speaker = next
    blocks.push('## ' + next)
  }
  for (const item of items) {
    const data = item.data
    if (data.type === 'text') {
      // Status lines are the runtime narrating itself, not a turn of the conversation.
      if (data.role === 'status' || !data.text.trim()) continue
      turn(data.role === 'user' ? (data.origin ? data.origin.label : 'You') : options.assistant)
      flush()
      const attached = data.attachments?.length ? '\n\n_Attached: ' + data.attachments.map(attachment => attachment.name).join(', ') + '_' : ''
      blocks.push(data.text.trim() + attached)
      messages++
      continue
    }
    if (data.type === 'tool') { turn(options.assistant); list.push(toolLine(data)); continue }
    if (data.type === 'interaction') {
      turn(options.assistant)
      const answers = data.interaction.answers ? Object.values(data.interaction.answers).flat().join(', ') : ''
      const outcome = answers || data.interaction.outcome || data.interaction.status
      list.push('- ' + (data.interaction.kind === 'question' ? 'Question' : 'Approval') + ': ' + oneLine(data.interaction.title) + (outcome ? ' → ' + oneLine(outcome, 80) : ''))
      continue
    }
    if (data.type === 'changes') {
      turn(options.assistant)
      for (const change of data.changes) list.push('- Changed ' + inlineCode(change.path) + (change.additions !== undefined || change.deletions !== undefined ? ` (+${change.additions ?? 0} −${change.deletions ?? 0})` : '') + (change.status !== 'applied' ? ' (' + change.status + ')' : ''))
      continue
    }
    if (data.type === 'plan') {
      turn(options.assistant)
      for (const step of data.steps) list.push('- [' + (step.status === 'completed' ? 'x' : ' ') + '] ' + oneLine(step.text))
      continue
    }
    if (data.type === 'subagent') { turn(options.assistant); list.push('- Subagent ' + inlineCode(data.name) + ' (' + data.status + ')'); continue }
    if (data.type === 'error') { turn(options.assistant); flush(); blocks.push(quote('**Error:** ' + data.message.trim())); continue }
    if (data.type === 'notice') { flush(); blocks.push(quote(data.message.trim())); continue }
  }
  flush()
  return { markdown: blocks.join('\n\n') + '\n', messages }
}
