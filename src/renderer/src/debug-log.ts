import type { AppDiagnostics, DebugLogEntry, DebugLogLevel, IssueReportContext } from '../../shared/models'
export type { DebugLogEntry, DebugLogLevel, IssueReportContext } from '../../shared/models'

export interface IssueScreenshotContext {
  capturedAt: string
  width: number
  height: number
  description?: string
}

const GITHUB_ISSUE_URL = 'https://github.com/Empire024/conductor/issues/new'
const MAX_ISSUE_DRAFT_LENGTH = 6_000

export const buildIssueDraftUrl = (report: string, description = ''): string => {
  const normalizedDescription = description.trim().replace(/\s+/g, ' ')
  const title = normalizedDescription ? normalizedDescription.slice(0, 90) : 'Conductor issue'
  const body = report.length <= MAX_ISSUE_DRAFT_LENGTH
    ? report
    : `${report.slice(0, 4_200)}\n\n<!-- Long report shortened for the GitHub draft. Copy the full report from Conductor if needed. -->\n\n${report.slice(-1_500)}`
  return `${GITHUB_ISSUE_URL}?${new URLSearchParams({ title, body }).toString()}`
}

const MAX_ENTRIES = 300
const listeners = new Set<(entries: DebugLogEntry[]) => void>()
let entries: DebugLogEntry[] = []
let enabled = false
let nextId = 1

const stringify = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack }
      return item
    }).slice(0, 8_000)
  } catch {
    return String(value).slice(0, 8_000)
  }
}

const publish = (): void => {
  const snapshot = [...entries]
  for (const listener of listeners) listener(snapshot)
}

export const debugLog = (
  scope: string,
  message: string,
  detail?: unknown,
  level: DebugLogLevel = 'debug'
): void => {
  if (!enabled) return
  entries = [...entries, {
    id: nextId++,
    createdAt: new Date().toISOString(),
    level,
    scope,
    message,
    detail: stringify(detail)
  }].slice(-MAX_ENTRIES)
  publish()
}

export const setDebugLoggingEnabled = (next: boolean): void => {
  if (enabled === next) return
  enabled = next
  if (enabled) debugLog('debug', 'Debug logging enabled', undefined, 'info')
}

export const getDebugEntries = (): DebugLogEntry[] => [...entries]

export const clearDebugEntries = (): void => {
  entries = []
  publish()
}

export const subscribeToDebugEntries = (listener: (next: DebugLogEntry[]) => void): (() => void) => {
  listeners.add(listener)
  listener(getDebugEntries())
  return () => listeners.delete(listener)
}

const formatConsoleArgs = (args: unknown[]): { message: string; detail?: unknown } => ({
  message: args.map((item) => item instanceof Error ? item.message : typeof item === 'string' ? item : stringify(item)).join(' '),
  detail: args.find((item) => item instanceof Error)
})

const named = (reason: unknown, key: 'name' | 'message'): string =>
  typeof reason === 'object' && reason !== null && key in reason ? String((reason as Record<string, unknown>)[key]) : ''

/** Cancellation is how editors and fetches unwind abandoned work; it carries no
 * information for a bug report. */
export const isCancellation = (reason: unknown): boolean =>
  ['Canceled', 'Cancelled', 'AbortError'].includes(named(reason, 'name')) || named(reason, 'message') === 'Canceled'

export const installDebugLogging = (): (() => void) => {
  const nativeWarn = console.warn
  const nativeError = console.error
  const captureWarn = (...args: unknown[]): void => {
    nativeWarn(...args)
    const formatted = formatConsoleArgs(args)
    debugLog('console', formatted.message, formatted.detail, 'warn')
  }
  const captureError = (...args: unknown[]): void => {
    nativeError(...args)
    const formatted = formatConsoleArgs(args)
    debugLog('console', formatted.message, formatted.detail, 'error')
  }
  const onError = (event: ErrorEvent): void => {
    debugLog('window', event.message, event.error ?? { filename: event.filename, line: event.lineno, column: event.colno }, 'error')
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    // Monaco cancels its own delayed work whenever a model or a view state is
    // swapped, and never attaches a handler to the promise it rejects. Those
    // are not faults, and reporting them as errors buries the real ones.
    if (isCancellation(event.reason)) {
      event.preventDefault()
      debugLog('promise', 'Canceled pending work', event.reason, 'debug')
      return
    }
    debugLog('promise', 'Unhandled promise rejection', event.reason, 'error')
  }
  console.warn = captureWarn
  console.error = captureError
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    if (console.warn === captureWarn) console.warn = nativeWarn
    if (console.error === captureError) console.error = nativeError
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}

export const buildIssueReport = (
  diagnostics: AppDiagnostics,
  context: IssueReportContext,
  recentEntries = entries,
  screenshot?: IssueScreenshotContext
): string => {
  const logLines = recentEntries.slice(-100).map((entry) => {
    const detail = entry.detail ? ` ${entry.detail}` : ''
    return `${entry.createdAt} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}${detail}`
  })
  return [
    '# Conductor issue report',
    '',
    '## What happened',
    '<!-- Briefly describe what you expected and what happened. -->',
    '',
    '## Diagnostics',
    `- Conductor: ${diagnostics.appVersion}`,
    `- Platform: ${diagnostics.platform} ${diagnostics.arch}`,
    `- Electron: ${diagnostics.electronVersion}`,
    `- Chrome: ${diagnostics.chromeVersion}`,
    `- Node: ${diagnostics.nodeVersion}`,
    `- Projects/workspaces: ${context.projectCount}/${context.sessionCount}`,
    `- Active workspace: ${context.activeSessionName ?? 'none'} (${context.activeSessionId ?? 'none'})`,
    `- Active tab kinds: ${context.activeTabKinds.join(', ') || 'none'}`,
    `- Attention resources: ${context.attentionCount}`,
    `- Theme/zoom: ${context.theme} / ${Math.round(context.zoomFactor * 100)}%`,
    '',
    ...(screenshot ? [
      '## Screenshot',
      `- Captured: ${screenshot.capturedAt}`,
      `- Size: ${screenshot.width} × ${screenshot.height}`,
      '- Attachment: paste the screenshot from your clipboard here. GitHub will turn it into a permanent link.',
      '',
      screenshot.description?.trim() || '<!-- Describe what is visibly wrong in the screenshot. -->',
      '',
      '<!-- Paste screenshot here -->',
      ''
    ] : []),
    '## Recent debug log',
    '```text',
    ...(logLines.length ? logLines : ['No debug entries captured.']),
    '```'
  ].join('\n')
}
