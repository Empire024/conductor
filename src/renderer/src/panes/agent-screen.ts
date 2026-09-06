import type { AgentProviderId } from '../../../shared/models'

export interface AgentScreenSnapshot {
  body: string
  active: boolean
  settled: boolean
  interaction?: 'directory_trust'
}

export interface AgentScreenRow {
  text: string
  wrapped?: boolean
}

/** Rebuild logical terminal lines from xterm's physical buffer rows. */
export const joinWrappedTerminalRows = (rows: AgentScreenRow[]): string => {
  const lines: string[] = []
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text
    else lines.push(row.text)
  }
  return lines.join('\n')
}

const comparable = (value: string): string => value
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()

const isRule = (line: string): boolean => /^[─━═_\-]{12,}$/.test(line.replace(/\s/g, ''))
const isCodexReadyFooter = (line: string): boolean =>
  /^(?:gpt-[\w.-]+|codex)\s+(?:minimal|low|medium|high|xhigh|max|ultra)(?:\s*[·•]|\s*$)/i.test(line.trim())

const isChrome = (line: string, provider: AgentProviderId): boolean => {
  const plain = line.trim()
  if (!plain || isRule(plain)) return false
  if (/^(?:▐|▝|⏵⏵)|(?:shift\+tab|ctrl\+|esc to interrupt|agent\s*\/|\/rc\s*$)/i.test(plain)) return true
  if (/^(?:claude code|codex|gemini|qwen|kimi)(?:\s+v?\d|\s*$)/i.test(plain)) return true
  if (/^(?:opus|sonnet|haiku|gpt-|gemini-|qwen|kimi).*(?:context|effort|model)/i.test(plain)) return true
  if (/^[A-Za-z]:[\\/].*(?:project|conductor)/i.test(plain)) return true
  if (provider === 'codex') {
    if (isCodexReadyFooter(plain)) return true
    if (/^working.*(?:background terminal|\/ps to view|\/stop to close|(?:minimal|low|medium|high|xhigh|max|ultra)\s*[·•])/i.test(plain)) return true
  }
  if (provider === 'claude' && /^(?:[✻✢✣✶✽*]|[◉○].*\/effort|·\s*esc|auto mode on)/i.test(plain)) return true
  return false
}

const isCodexProgressBoundary = (line: string): boolean => {
  const plain = line.trim()
  if (!/^working/i.test(plain)) return false
  if (/background terminal|\/ps to view|\/stop to close|(?:minimal|low|medium|high|xhigh|max|ultra)\s*[·•]/i.test(plain)) return true
  return plain.length <= 30 && !/\s/.test(plain.slice('working'.length))
}

/**
 * Extracts the current provider response from xterm's emulated screen. Unlike
 * stripping the PTY byte stream, this respects cursor movement and overwritten
 * rows, so full-screen CLIs do not leak duplicate chrome into the chat view.
 */
export const extractAgentScreenSnapshot = (
  screen: string,
  provider: AgentProviderId,
  submittedMessage = ''
): AgentScreenSnapshot => {
  if (/do you trust\s+the contents\s+of this directory|quick safety check:[\s\S]*yes, i trust this folder/i.test(screen)) {
    // Interactive provider chrome is published separately as a structured
    // question. It must never become assistant prose in Chat mode.
    return { body: '', active: false, settled: false, interaction: 'directory_trust' }
  }
  const lines = screen.replace(/\r/g, '').replace(/\u00a0/g, ' ').split('\n')
  const messageNeedle = comparable(submittedMessage).slice(0, 90)
  let anchor = -1
  if (messageNeedle) {
    for (let index = 0; index < lines.length; index += 1) {
      const candidate = comparable(lines[index] ?? '')
      if (candidate.includes(messageNeedle) || (messageNeedle.includes(candidate) && candidate.length >= 18)) anchor = index
    }
  }
  if (anchor < 0) {
    for (let index = 0; index < lines.length; index += 1) {
      if (/^[❯›>]\s*(?:\[Conductor|\S)/i.test(lines[index]?.trim() ?? '')) anchor = index
    }
  }

  let after = lines.slice(Math.max(0, anchor + 1))
  if (provider === 'codex') {
    let progressBoundary = -1
    for (let index = after.length - 1; index >= 0; index -= 1) {
      if (!isCodexProgressBoundary(after[index] ?? '')) continue
      progressBoundary = index
      break
    }
    if (progressBoundary >= 0) after = after.slice(progressBoundary + 1)
  }
  const output: string[] = []
  let settled = false
  let active = false
  let sawContent = false
  for (const rawLine of after) {
    let line = rawLine.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trimEnd()
    const trimmed = line.trim()
    if (/\b(?:working|thinking|deciphering|cogitating|frosting|brewing|esc to interrupt)\b/i.test(trimmed)) active = true
    if (/\b(?:done|completed|finished)\b.*\b\d{1,2}:\d{2}\b/i.test(trimmed)) settled = true
    if (/you(?:'|’)ve hit your .*limit|usage limit|rate limit/i.test(trimmed)) settled = true
    if (provider === 'codex' && sawContent && isCodexReadyFooter(trimmed)) settled = true
    if (/^[❯›>]\s*$/.test(trimmed)) {
      if (sawContent && provider !== 'claude') settled = true
      continue
    }
    if (/^[❯›>]\s*\[Conductor/i.test(trimmed)) continue
    if (messageNeedle && comparable(trimmed).includes(messageNeedle)) continue
    if (isRule(trimmed) || isChrome(trimmed, provider)) continue
    line = line.replace(/^\s*[⎿└]\s?/, '').trimStart()
    if (!line.trim()) {
      if (sawContent && output.at(-1) !== '') output.push('')
      continue
    }
    sawContent = true
    output.push(line.trimEnd())
  }
  while (output.at(-1) === '') output.pop()
  const body = output.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { body, active: active && !settled, settled }
}
