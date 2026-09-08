import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEventData, TimelineItem } from '../../../shared/structured-agent'
import { commandSummary, groupConversationActivities, interactionOutcome, isConversationActivity, legacyAttachedContext, rendererKind, safeExternalLink, safeFileTarget, StructuredActivity, StructuredMarkdown, toolPresentation } from './StructuredAgentRenderers'

const cwd = 'C:\\work\\My project'
function renderActivity(data: AgentEventData): string {
  const item: TimelineItem = { id: 'item', runtimeId: 'runtime', sequence: 1, timestamp: '2026-09-07T00:00:00Z', data }
  return renderToStaticMarkup(createElement(StructuredActivity, { item, sessionId: 'session', cwd, expanded: true, interactive: true, onExpand: vi.fn(), onOpenFile: vi.fn(), onDiff: vi.fn(), onRespond: vi.fn(async () => {}) }))
}
describe('structured renderer contracts (synthetic, zero inference)', () => {
  it('routes native command names without renaming PowerShell as Bash', () => {
    for (const name of ['Bash', 'PowerShell', 'Command', 'commandExecution', 'exec_command']) expect(rendererKind(name)).toBe('command')
    expect(rendererKind('mcp__custom__write')).toBe('custom')
    expect(rendererKind('File change')).toBe('edit')
    const html = renderActivity({ type: 'tool', name: 'PowerShell', status: 'running', input: { command: 'Get-Content "C:\\work\\résumé file.txt"' } })
    expect(html).toContain('PowerShell')
    expect(html).not.toContain('Bash')
    expect(html).toContain('Get-Content')
  })
  it('preserves exact scripts while deriving titles without inference', () => {
    const command = 'git diff -- "résumé file.ts"\r\nWrite-Host "$HOME"'
    expect(toolPresentation({ type: 'tool', name: 'PowerShell', status: 'preparing', input: { command, cwd } })).toMatchObject({ title: 'Run git diff -- "résumé file.ts"', input: command, cwd })
    expect(toolPresentation({ type: 'tool', name: 'Bash', status: 'running', input: { command: 'git diff', description: 'Inspect the current changes' } }).title).toBe('Inspect the current changes')
  })
  it('retains partial tool JSON without pretending execution ran', () => {
    const html = renderActivity({ type: 'tool', name: 'Bash', status: 'preparing', inputDelta: '{"command":"git' })
    expect(html).toContain('Preparing…')
    expect(html).not.toContain('Exit 0')
    expect(html).toContain('IN')
    expect(html).toContain('OUT')
    expect(toolPresentation({ type: 'tool', name: 'Bash', status: 'preparing', input: {}, inputDelta: '{"command":"git' }).input).toBe('{"command":"git')
  })
  it('keeps Windows launcher noise out of collapsed titles without changing exact input', () => {
    const command = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'node --test "résumé panel.test.mjs"\''
    expect(commandSummary(command)).toBe('node --test "résumé panel.test.mjs"')
    const tool = { type: 'tool' as const, name: 'PowerShell', status: 'completed' as const, input: { command } }
    expect(toolPresentation(tool)).toMatchObject({ title: 'Run node --test "résumé panel.test.mjs"', input: command })
    expect(toolPresentation({ ...tool, description: 'Run ' + command.slice(0, 120) }).title).toBe('Run node --test "résumé panel.test.mjs"')
    expect(toolPresentation({ ...tool, description: 'Verify the exact two-line removal' }).title).toBe('Verify the exact two-line removal')
    expect(commandSummary('node --test; Write-Host "done"')).toBe('node --test; Write-Host "done"')
    expect(commandSummary('unknown.exe -Command "body"')).toBe('unknown.exe -Command "body"')
  })
  it('renders nonzero exit status as failed and escapes executable output', () => {
    const html = renderActivity({ type: 'tool', name: 'Command', status: 'completed', input: { command: 'node --test' }, output: '<script>alert(1)</script>', stderr: 'assertion failed', exitCode: 1, durationMs: 2500 })
    expect(html).toContain('Command: failed')
    expect(html).toContain('Exit 1')
    expect(html).toContain('2.50 s')
    expect(html).toContain('stderr')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
  it('does not invent zero usage or execution metadata', () => {
    expect(renderActivity({ type: 'usage', source: 'provider' })).not.toMatch(/0 input|0 output|\$0/)
    const html = renderActivity({ type: 'tool', name: 'Read', status: 'completed', input: { file_path: 'panel.mjs' }, output: 'text' })
    expect(html).not.toContain('Exit')
    expect(html).not.toContain('0.00 s')
  })
  it('renders provider choices and hides controls for expired approvals', () => {
    const base = { id: 'approval', kind: 'approval' as const, title: 'Run command?', input: { command: 'node --test' }, choices: [{ id: 'accept', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }
    expect(renderActivity({ type: 'interaction', interaction: { ...base, status: 'pending' } })).toContain('Allow once</button>')
    expect(renderActivity({ type: 'interaction', interaction: { ...base, status: 'expired' } })).not.toContain('Allow once</button>')
  })
  it('renders provider change counts rather than counting sentences', () => {
    const html = renderActivity({ type: 'changes', changes: [{ path: 'panel.mjs', kind: 'update', status: 'applied', additions: 0, deletions: 2, patch: '@@ -1,4 +1,2 @@\n-old\n-other\n keep\n', artifactId: 'immutable' }] })
    expect(html).toContain('−2')
    expect(html).toContain('Click to expand diff')
    expect(html).not.toContain('Undo')
  })
  it('renders Markdown without executable HTML or remote image loading', () => {
    const text = '# Heading\n\n**Bold** and ' + String.fromCharCode(96) + 'code' + String.fromCharCode(96) + '\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![remote](https://example.com/tracker.png)\n\n[good](https://example.com/docs)'
    const html = renderToStaticMarkup(createElement(StructuredMarkdown, { cwd, onOpenFile: vi.fn(), text }))
    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<img')
    expect(html).toContain('href="https://example.com/docs"')
  })
  it('accepts Unicode Windows paths with spaces and navigable line references', () => {
    expect(safeFileTarget('C:\\work\\My project\\src\\résumé file.ts:23:4', cwd)).toEqual({ path: 'src/résumé file.ts', line: 23 })
    expect(safeFileTarget('src/panel.mjs#L7', cwd)).toEqual({ path: 'src/panel.mjs', line: 7 })
    expect(safeFileTarget('./src/panel.mjs', cwd)).toEqual({ path: 'src/panel.mjs', line: undefined })
  })
  it('rejects traversal, schemes, outside paths and malformed escapes', () => {
    for (const path of ['../secret', '%2e%2e/secret', 'C:\\work\\My project-copy\\file.ts', 'C:\\outside\\file.ts', 'file:///C:/secret', 'javascript:alert(1)', 'src\\..\\secret', '//host/share', '%ZZ', 'file.ts:stream', 'src/\0file']) expect(safeFileTarget(path, cwd)).toBeNull()
  })
  it('limits external links to credential-free HTTP/S', () => {
    expect(safeExternalLink('https://example.com')).toBe(true)
    for (const href of ['file:///C:/a', 'javascript:alert(1)', 'data:text/html,a', 'https://token@example.com', 'mailto:x@example.com']) expect(safeExternalLink(href)).toBe(false)
  })
  it('bounds ordinary output previews while retaining an expanded viewer', () => {
    const html = renderActivity({ type: 'tool', name: 'Command', status: 'completed', output: 'x'.repeat(100_000), outputArtifactId: 'output', input: { command: 'emit' } })
    expect(html.length).toBeLessThan(15_000)
    expect(html).toContain('Expand output')
  })
  it('keeps usage, limits and technical protocol events out of the conversation without altering data', () => {
    const hidden: AgentEventData[] = [
      { type: 'usage', source: 'provider', inputTokens: 123, limits: { remaining: 42 } },
      { type: 'session', phase: 'running' },
      { type: 'notice', message: 'Codex event: future/event', payload: { exact: 'native payload retained' } },
      { type: 'notice', message: 'Codex effective thread settings', payload: { model: 'actual-model' } },
      { type: 'notice', message: 'Native Codex settings updated' },
      { type: 'notice', message: 'Claude system / init', payload: { type: 'system' } }
    ]
    for (const data of hidden) {
      const before = JSON.stringify(data)
      const item: TimelineItem = { id: 'item', runtimeId: 'runtime', sequence: 1, timestamp: '', data }
      expect(isConversationActivity(item)).toBe(false)
      expect(renderActivity(data)).toBe('')
      expect(JSON.stringify(data)).toBe(before)
    }
    expect(renderActivity({ type: 'error', message: 'Turn failed' })).toContain('role="alert"')
    expect(renderActivity({ type: 'notice', message: 'Snapshot unavailable: file is too large' })).toContain('Snapshot unavailable')
    expect(renderActivity({ type: 'notice', message: 'Unsupported Claude control request: new_permission', payload: {} })).toContain('Unsupported Claude control request')
    expect(renderActivity({ type: 'notice', message: 'Saved terminal history', outputArtifactId: 'legacy-output' })).toContain('Expand output')
  })
  it('collapses answered and expired requests while keeping real pending choices actionable', () => {
    const request = { id: 'request', kind: 'approval' as const, title: 'Run tests?', input: { command: 'node --test' }, choices: [{ id: 'accept', label: 'Allow once' }] }
    const resolved = renderActivity({ type: 'interaction', interaction: { ...request, status: 'resolved', outcome: 'Allowed once' } })
    expect(resolved).toContain('<details class="sa-interaction sa-interaction-resolved"')
    expect(resolved).toContain('<summary><span>Run tests?</span><small>Allowed once</small></summary>')
    expect(resolved).not.toContain('<details open')
    expect(resolved).not.toContain('Allow once</button>')
    expect(resolved).not.toContain('Your response is required')
    const pending = renderActivity({ type: 'interaction', interaction: { ...request, status: 'pending' } })
    expect(pending).toContain('needs-attention')
    expect(pending).toContain('Allow once</button>')
  })
  it('omits repetitive assistant labels, native subagent IDs and edit boilerplate', () => {
    expect(renderActivity({ type: 'text', role: 'assistant', text: 'Here is the fix.', mode: 'snapshot' })).not.toContain('sa-role')
    const child = renderActivity({ type: 'subagent', name: 'Review', status: 'completed', nativeSessionId: 'private-native-identity' })
    expect(child).toBe('')
    expect(child).not.toContain('private-native-identity')
    const changes = renderActivity({ type: 'changes', changes: [{ path: 'panel.mjs', kind: 'update', status: 'applied', artifactId: 'saved', patch: '@@ -1 +1 @@\n-var n = 1\n+const n = 1', additions: 1, deletions: 1, limitation: 'Immutable historical warning belongs in expanded review.' }] })
    expect(changes).toContain('data-language="javascript"')
    expect(changes).not.toContain('Immutable historical warning')
    expect(changes).toContain('Click to expand diff')
  })
  it('renders fenced code through safe, language-aware spans and keeps inline code simple', () => {
    const fence = String.fromCharCode(96).repeat(3)
    const text = fence + 'js\nconst message = "<script>";\n' + fence + '\n\n' + String.fromCharCode(96) + 'inline' + String.fromCharCode(96)
    const html = renderToStaticMarkup(createElement(StructuredMarkdown, { cwd, onOpenFile: vi.fn(), text }))
    expect(html).toContain('data-language="javascript"')
    expect(html).toContain('const message = &quot;&lt;script&gt;&quot;;')
    expect(html).toContain('aria-label="Copy code"')
    expect(html).toContain('<code>inline</code>')
    expect(html).not.toContain('<script>')
    const read = renderActivity({ type: 'tool', name: 'Read', status: 'completed', input: { file_path: 'component.ts' }, output: 'const count = 1;' })
    expect(read).toContain('data-language="typescript"')
    const unknownActions = renderActivity({ type: 'tool', name: 'custom', status: 'completed', input: { actions: 'not an array' } })
    expect(unknownActions).toContain('custom')
  })
  it('keeps timeline wrapper classes separate from inner card styles and preserves role classes', () => {
    const cases: AgentEventData[] = [
      { type: 'tool', name: 'Command', status: 'completed', input: { command: 'node --test' } },
      { type: 'interaction', interaction: { id: 'id', kind: 'approval', title: 'Run?', status: 'pending', input: {}, choices: [] } },
      { type: 'plan', steps: [] },
      { type: 'subagent', name: 'Review', status: 'failed' },
      { type: 'changes', changes: [] }
    ]
    for (const data of cases) {
      const html = renderActivity(data)
      expect(html).toContain('<article class="sa-activity sa-kind-' + data.type + '"')
      expect(html).not.toContain('<article class="sa-activity sa-' + data.type + '"')
      expect(html).toContain('class="sa-marker"')
    }
    expect(renderActivity({ type: 'text', role: 'user', text: 'Hello', mode: 'snapshot' })).toContain('sa-activity sa-kind-text sa-user')
  })
  it('uses friendly known approval outcomes without hiding unknown decisions', () => {
    expect(interactionOutcome('accept')).toBe('Accepted')
    expect(interactionOutcome('decline')).toBe('Declined')
    expect(interactionOutcome('cancel')).toBe('Cancelled')
    expect(interactionOutcome('acceptForSession')).toBe('Accepted for session')
    expect(interactionOutcome('answered')).toBe('Answered')
    expect(interactionOutcome('A future native outcome')).toBe('A future native outcome')
    const html = renderActivity({ type: 'interaction', interaction: { id: 'id', kind: 'approval', title: 'Run?', status: 'resolved', outcome: 'accept', input: {}, choices: [] } })
    expect(html).toContain('<small>Accepted</small>')
    const expired = renderActivity({ type: 'interaction', interaction: { id: 'id', kind: 'approval', title: 'Run?', status: 'expired', outcome: 'Delivery uncertain after disconnect', input: {}, choices: [] } })
    expect(expired).toContain('Delivery uncertain after disconnect')
  })
})

it('shows attachment names below a user message without embedding file content', () => {
  const html = renderActivity({ type: 'text', role: 'user', text: 'Review this file', mode: 'snapshot', attachments: [{ id: 'a', kind: 'file', name: 'panel.mjs', path: 'panel.mjs' }] })
  expect(html).toContain('Review this file')
  expect(html).toContain('panel.mjs')
  expect(html).toContain('aria-label="Attached context"')
})

it('places optional request details after the answer choices and retains native accessible inputs', () => {
  const html = renderActivity({ type: 'interaction', interaction: { id: 'q', kind: 'question', title: 'Claude needs your input', input: { question: 'Pick a color' }, status: 'pending', choices: [], questions: [{ id: 'color', question: 'Pick a color', options: [{ label: 'Blue', description: 'Calm' }, { label: 'Green' }], multiSelect: false }] } })
  expect(html.indexOf('Submit answers')).toBeLessThan(html.indexOf('Request details'))
  expect(html).toContain('type="radio"')
  expect(html).toContain('sa-choice-indicator')
  expect(html).toContain('<form class="sa-interaction needs-attention"')
  expect(html).toContain('type="submit"')
  expect(html).toContain('disabled=""')
})


it('groups only adjacent successful tools and retains failures and substantive messages', () => {
  const item = (id: string, data: AgentEventData): TimelineItem => ({ id, data, runtimeId: 'runtime', timestamp: '', sequence: Number(id) })
  const command = { type: 'tool' as const, name: 'PowerShell', status: 'completed' as const }
  const items = [
    item('1', command), item('2', { ...command, output: 'exact output' }),
    item('3', { ...command, status: 'running' }), item('4', command),
    item('5', { ...command, exitCode: 1 }), item('6', command),
    item('7', { type: 'text', role: 'assistant', text: 'Meaningful update', mode: 'snapshot' }),
    item('8', command), item('9', command)
  ]
  const before = JSON.stringify(items)
  const groups = groupConversationActivities(items)
  expect(groups.map(group => group.map(item => item.id))).toEqual([['1', '2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8', '9']])
  expect(groups.flat()).toEqual(items)
  expect(JSON.stringify(items)).toBe(before)
})

it('summarizes inline scripts without losing their original source', () => {
  const script = "@'\nfrom pathlib import Path\nprint('example')\n'@ | python -X utf8 -"
  expect(commandSummary(script)).toBe('Python script')
  expect(toolPresentation({ type: 'tool', name: 'PowerShell', status: 'completed', input: { command: script }, description: "Run @'" })).toMatchObject({ title: 'Run Python script', input: script })
  expect(commandSummary("@'\nWrite-Output example\n'@")).toBe('PowerShell script')
})

it('keeps routine subagent status in its roster while surfacing failures', () => {
  expect(renderActivity({ type: 'subagent', name: '/root/reviewer', status: 'running' })).toBe('')
  expect(renderActivity({ type: 'subagent', name: '/root/reviewer', status: 'completed' })).toBe('')
  expect(renderActivity({ type: 'subagent', name: 'Reviewer', status: 'failed' })).toContain('Reviewer')
  expect(renderActivity({ type: 'text', role: 'assistant', text: 'A child found a defect.', mode: 'snapshot' })).toContain('A child found a defect.')
  expect(interactionOutcome('allow-session')).toBe('Allowed for session')
})


it('collapses old expanded attachment suffixes without dropping any original text', () => {
  const text = 'Implement the task.\n\n[Attached file: feature-list.md]\nFull original file contents.'
  const original = legacyAttachedContext(text)
  expect(original).toEqual({ prompt: 'Implement the task.', context: '[Attached file: feature-list.md]\nFull original file contents.' })
  expect(legacyAttachedContext('Please explain the phrase [Attached file: sample.md].')).toBeNull()
  expect(legacyAttachedContext('[Attached file: sample.md]\nThis entire prompt is user content.')).toBeNull()
  const html = renderActivity({ type: 'text', role: 'user', text, mode: 'snapshot' })
  expect(html).toContain('Implement the task.')
  expect(html).toContain('<details class="sa-legacy-context"><summary>Attached context</summary>')
  expect(html).toContain('Full original file contents.')
  expect(html).not.toContain('<details open')
})
