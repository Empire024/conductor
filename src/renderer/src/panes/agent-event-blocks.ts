import type { NormalizedAgentEvent, NormalizedAgentEventType } from '../../../shared/models'
import type {
  AgentVisualBlock,
  AgentVisualBlockKind,
  AgentVisualFileReference,
  AgentVisualTimeline,
  AgentVisualTone,
  BuildAgentVisualTimelineOptions
} from '../../../shared/agent-visual'

interface EventPresentation {
  kind: AgentVisualBlockKind
  tone: AgentVisualTone
  label: string
  fallbackTitle: string
}

const presentation: Record<NormalizedAgentEventType, EventPresentation> = {
  text: { kind: 'message', tone: 'neutral', label: 'Response', fallbackTitle: 'Agent response' },
  activity: { kind: 'activity', tone: 'working', label: 'Activity', fallbackTitle: 'Agent activity' },
  shell_command: { kind: 'command', tone: 'working', label: 'Command', fallbackTitle: 'Ran a command' },
  file_change: { kind: 'file', tone: 'working', label: 'File', fallbackTitle: 'Changed a file' },
  tool_call: { kind: 'tool', tone: 'working', label: 'Tool', fallbackTitle: 'Used a tool' },
  question: { kind: 'question', tone: 'attention', label: 'Question', fallbackTitle: 'Needs your input' },
  error: { kind: 'error', tone: 'danger', label: 'Error', fallbackTitle: 'Something went wrong' },
  task_complete: { kind: 'completion', tone: 'success', label: 'Complete', fallbackTitle: 'Task completed' },
  artifact: { kind: 'artifact', tone: 'success', label: 'Artifact', fallbackTitle: 'Created an artifact' },
  review_finding: { kind: 'finding', tone: 'attention', label: 'Finding', fallbackTitle: 'Review finding' }
}

const stringValue = (metadata: Record<string, unknown> | undefined, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = metadata?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

const numberValue = (metadata: Record<string, unknown> | undefined, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = metadata?.[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  }
  return undefined
}

const cleanBody = (value: string): string => value
  .replace(/\r/g, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/\n{4,}/g, '\n\n\n')
  .trim()

const normalizedProjectPrefix = (projectPath?: string): string | null => projectPath
  ? `${projectPath.replaceAll('\\', '/').replace(/\/$/, '')}/`.toLowerCase()
  : null

const normalizeFileReference = (
  value: string,
  projectPath?: string,
  fallbackLine?: number,
  fallbackColumn?: number
): AgentVisualFileReference | null => {
  let raw = value.trim().replace(/^['"`(<[]+/, '').replace(/['"`)>\],;.!?]+$/, '')
  const location = raw.match(/:(\d+)(?::(\d+))?$/)
  const line = location?.[1] ? Number(location[1]) : fallbackLine
  const column = location?.[2] ? Number(location[2]) : fallbackColumn
  if (location) raw = raw.slice(0, -location[0].length)
  let path = raw.replaceAll('\\', '/').replace(/^\.\//, '')
  const projectPrefix = normalizedProjectPrefix(projectPath)
  if (projectPrefix && path.toLowerCase().startsWith(projectPrefix)) {
    path = path.slice(projectPrefix.length)
  } else if (projectPrefix && (/^[A-Za-z]:\//.test(path) || path.startsWith('/'))) {
    return null
  }
  if (!path || path.includes('://') || path === '..' || path.startsWith('../')) return null
  return {
    path,
    ...(line ? { line } : {}),
    ...(column ? { column } : {})
  }
}

const fileReferences = (
  event: NormalizedAgentEvent,
  projectPath?: string
): AgentVisualFileReference[] => {
  const candidates: string[] = []
  const metadata = event.metadata
  for (const key of ['path', 'filePath', 'relativePath', 'artifactPath']) {
    const value = metadata?.[key]
    if (typeof value === 'string') candidates.push(value)
  }
  for (const key of ['paths', 'files', 'changedFiles']) {
    const value = metadata?.[key]
    if (Array.isArray(value)) candidates.push(...value.filter((item): item is string => typeof item === 'string'))
  }
  for (const match of event.message.matchAll(
    /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[\w@.+-]+(?:[\\/][\w@().+-]+)+\.[A-Za-z0-9_-]{1,12}(?::\d+(?::\d+)?)?/g
  )) candidates.push(match[0])

  const fallbackLine = numberValue(metadata, ['line', 'lineNumber'])
  const fallbackColumn = numberValue(metadata, ['column', 'columnNumber'])
  const unique = new Map<string, AgentVisualFileReference>()
  for (const candidate of candidates) {
    const reference = normalizeFileReference(candidate, projectPath, fallbackLine, fallbackColumn)
    if (!reference) continue
    const key = `${reference.path.toLowerCase()}:${reference.line ?? ''}:${reference.column ?? ''}`
    if (!unique.has(key)) unique.set(key, reference)
  }
  return [...unique.values()].slice(0, 20)
}

const eventTitle = (
  event: NormalizedAgentEvent,
  fallback: string,
  files: AgentVisualFileReference[],
  command?: string,
  tool?: string
): string => {
  const explicit = stringValue(event.metadata, ['title', 'summary', 'label'])
  if (explicit) return explicit.slice(0, 180)
  if (event.type === 'file_change' && files[0]) {
    const operation = stringValue(event.metadata, ['operation', 'action']) ?? 'Changed'
    return `${operation.charAt(0).toUpperCase()}${operation.slice(1)} ${files[0].path}`
  }
  if (event.type === 'shell_command' && command) return command.slice(0, 180)
  if (event.type === 'tool_call' && tool) return tool
  return fallback
}

export const normalizedEventToVisualBlock = (
  event: NormalizedAgentEvent,
  projectPath?: string
): AgentVisualBlock => {
  const displayed = presentation[event.type]
  const files = fileReferences(event, projectPath)
  const command = event.type === 'shell_command'
    ? stringValue(event.metadata, ['command', 'cmd', 'input']) ?? cleanBody(event.message).split('\n')[0]?.slice(0, 200)
    : undefined
  const tool = event.type === 'tool_call'
    ? stringValue(event.metadata, ['tool', 'toolName', 'name'])
    : undefined
  const severity = stringValue(event.metadata, ['severity'])?.toLowerCase()
  const tone = event.type === 'review_finding' && severity && ['critical', 'high', 'error'].includes(severity)
    ? 'danger'
    : displayed.tone
  const createdAt = event.createdAt
  const role = event.type === 'text' ? stringValue(event.metadata, ['role']) : undefined
  const isUserMessage = role === 'user'
  return {
    id: `visual-${event.id}`,
    agentSessionId: event.agentSessionId,
    kind: displayed.kind,
    tone,
    label: isUserMessage ? 'You' : displayed.label,
    title: isUserMessage ? 'You' : eventTitle(event, displayed.fallbackTitle, files, command, tool),
    body: cleanBody(event.message),
    createdAt,
    updatedAt: createdAt,
    sourceEventIds: [event.id],
    occurrences: 1,
    files,
    ...(command ? { command } : {}),
    ...(tool ? { tool } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {})
  }
}

const timestamp = (value: string): number => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const mergeFiles = (
  first: AgentVisualFileReference[],
  second: AgentVisualFileReference[]
): AgentVisualFileReference[] => {
  const merged = new Map<string, AgentVisualFileReference>()
  for (const file of [...first, ...second]) {
    const key = `${file.path.toLowerCase()}:${file.line ?? ''}:${file.column ?? ''}`
    if (!merged.has(key)) merged.set(key, file)
  }
  return [...merged.values()].slice(0, 20)
}

/** A stable target for kinds that can repeat on the same thing (a file, a command, a tool) so
 *  successive near-duplicates coalesce; null means this kind has nothing to key a target by. */
const coalesceTarget = (block: AgentVisualBlock): string | null => {
  if (block.kind === 'file') return block.files[0] ? `file:${block.files[0].path.toLowerCase()}` : null
  if (block.kind === 'command') return block.command ? `command:${block.command}` : null
  // A bare tool name is not a target: two unrelated Grep calls would merge and the first one's
  // title and body would be silently overwritten by the second.
  if (block.kind === 'tool') return null
  return null
}

export const buildAgentVisualTimeline = (
  events: NormalizedAgentEvent[],
  options: BuildAgentVisualTimelineOptions = {}
): AgentVisualTimeline => {
  const rawEvents = [...events]
  const seen = new Set<string>()
  const visualEvents = events.filter((event) => {
    if (seen.has(event.id)) return false
    seen.add(event.id)
    return true
  })
  const ordered = visualEvents
    .map((event, index) => ({ event, index }))
    .sort((a, b) => timestamp(a.event.createdAt) - timestamp(b.event.createdAt) || a.index - b.index)
    .map(({ event }) => event)
  const textWindow = Math.max(0, options.mergeTextWithinMs ?? 2500)
  const activityWindow = Math.max(0, options.coalesceActivityWithinMs ?? 5000)
  const blocks: AgentVisualBlock[] = []

  for (const event of ordered) {
    const next = normalizedEventToVisualBlock(event, options.projectPath)
    const previous = blocks.at(-1)
    const gap = previous ? timestamp(next.createdAt) - timestamp(previous.updatedAt) : Number.POSITIVE_INFINITY
    if (
      previous &&
      previous.agentSessionId === next.agentSessionId &&
      previous.kind === 'message' && next.kind === 'message' &&
      previous.metadata?.role === next.metadata?.role &&
      gap >= 0 && gap <= textWindow &&
      previous.body.length + next.body.length <= 24_000
    ) {
      previous.body = `${previous.body}${previous.body && next.body ? '\n' : ''}${next.body}`
      previous.updatedAt = next.updatedAt
      previous.sourceEventIds.push(...next.sourceEventIds)
      previous.files = mergeFiles(previous.files, next.files)
      previous.occurrences += 1
      continue
    }
    if (
      previous &&
      previous.agentSessionId === next.agentSessionId &&
      previous.kind === 'activity' && next.kind === 'activity' &&
      previous.body === next.body && gap >= 0 && gap <= activityWindow
    ) {
      previous.updatedAt = next.updatedAt
      previous.sourceEventIds.push(...next.sourceEventIds)
      previous.occurrences += 1
      continue
    }
    const target = previous ? coalesceTarget(previous) : null
    if (
      previous &&
      previous.agentSessionId === next.agentSessionId &&
      previous.kind === next.kind &&
      target !== null && target === coalesceTarget(next) &&
      gap >= 0 && gap <= activityWindow
    ) {
      // Successive edits/commands/tool calls on the same target with no intervening commentary:
      // the row always reflects the latest, most complete state instead of stacking near-duplicates.
      previous.title = next.title
      previous.body = next.body
      previous.updatedAt = next.updatedAt
      previous.sourceEventIds.push(...next.sourceEventIds)
      previous.files = mergeFiles(previous.files, next.files)
      previous.occurrences += 1
      continue
    }
    blocks.push(next)
  }

  const maxBlocks = Math.min(1000, Math.max(1, options.maxBlocks ?? 160))
  return {
    blocks: blocks.slice(-maxBlocks),
    raw: {
      transcript: options.rawTranscript ?? '',
      events: rawEvents
    }
  }
}
