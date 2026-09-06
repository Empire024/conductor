import type { AppDiagnostics, DebugLogEntry, DebugLogLevel, IssueReportContext } from '../../shared/models'
export type { DebugLogEntry, DebugLogLevel, IssueReportContext } from '../../shared/models'

export interface IssueScreenshotContext {
  capturedAt: string
  width: number
  height: number
  description?: string
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
      '- Attachment: save and attach the PNG from the debug console.',
      '',
      screenshot.description?.trim() || '<!-- Describe what is visibly wrong in the screenshot. -->',
      ''
    ] : []),
    '## Recent debug log',
    '```text',
    ...(logLines.length ? logLines : ['No debug entries captured.']),
    '```'
  ].join('\n')
}
