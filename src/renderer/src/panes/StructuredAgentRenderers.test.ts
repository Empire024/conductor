import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEventData, InputQuestion, PendingInteraction, TimelineItem } from '../../../shared/structured-agent'
import { activityCoalesceTarget, coalescedEditLabel, coalescedEditSummary, combinedQuestionAnswer, commandSummary, groupConversationActivities, interactionOutcome, isAnsweredThroughInteraction, isConversationActivity, isRuntimeHeartbeat, legacyAttachedContext, parentLabelAnchors, readableAnswerValue, rendererKind, safeExternalLink, safeFileTarget, StructuredActivity, StructuredMarkdown, toolInlinePreview, toolPresentation } from './StructuredAgentRenderers'

const cwd = 'C:\\work\\My project'
function renderActivity(data: AgentEventData, expanded = true, overrides: Partial<ComponentProps<typeof StructuredActivity>> = {}): string {
  const item: TimelineItem = { id: 'item', runtimeId: 'runtime', sequence: 1, timestamp: '2026-09-07T00:00:00Z', data }
  return renderToStaticMarkup(createElement(StructuredActivity, { item, sessionId: 'session', cwd, expanded, interactive: true, onExpand: vi.fn(), onOpenFile: vi.fn(), onDiff: vi.fn(), onRespond: vi.fn(async () => {}), ...overrides }))
}
describe('structured renderer contracts (synthetic, zero inference)', () => {
  it('labels collapsed command output as OUT rather than assistant prose', () => {
    const html = renderActivity({ type: 'tool', name: 'Bash', status: 'completed', input: { command: 'echo result' }, output: 'result' }, false)
    expect(html).toContain('OUT</b> result')
  })

  it('renders a real event timestamp as a hoverable time element', () => {
    const html = renderActivity({ type: 'text', role: 'assistant', text: 'Done.', mode: 'snapshot' })
    expect(html).toContain('<time')
    expect(html).toContain('dateTime="2026-09-07T00:00:00Z"')
  })

  it('makes coordinated-agent names real tab-focus controls', () => {
    const html = renderActivity({ type: 'text', role: 'user', text: 'Please investigate.', mode: 'snapshot', origin: { agentSessionId: 'controller', label: 'Fixer' } })
    expect(html).toContain('aria-label="Show Fixer tab"')
    expect(html).toContain('sa-role-coordinated')
  })

  it('keeps a pending question reachable in its compact bottom dock', () => {
    const interaction: PendingInteraction = { id: 'q', kind: 'question', title: 'Pick a color', status: 'pending', input: {}, choices: [], questions: [{ id: 'color', question: 'Pick a color', options: [{ label: 'Blue' }] }] }
    const html = renderActivity({ type: 'interaction', interaction }, true, { dockedQuestion: true })
    expect(html).toContain('sa-interaction-docked')
    expect(html).toContain('Reopen question')
    expect(html).toContain('answers are preserved')
  })
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


it('renders separate Claude permission actions with the exact scope and disabled boundary explanation', () => {
  const html = renderActivity({ type: 'interaction', interaction: {
    id: 'permission', kind: 'approval', title: 'Allow Bash?', input: { command: 'npm test' }, status: 'pending', choices: [
      { id: 'allow', label: 'Allow once' },
      { id: 'allow-session', label: 'Allow for this session', description: 'Scope: Bash(npm test). Only this running Claude session.' },
      { id: 'auto-mode', label: 'Switch to auto-mode', description: 'Auto-mode is already active. Claude still requires approval for this request.', disabled: true },
      { id: 'deny', label: 'Deny' }
    ]
  } })
  expect(html).toContain('>Allow for this session</button>')
  expect(html).toContain('>Switch to auto-mode</button>')
  expect(html).toContain('Scope: Bash(npm test). Only this running Claude session.')
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Switch to auto-mode<\/button>/)
  expect(html).toContain('Claude still requires approval for this request.')
  expect(interactionOutcome('auto-mode')).toBe('Auto-mode enabled')
})

it('shows a short output preview on a collapsed tool row without duplicating the full IN/OUT panel', () => {
  const html = renderActivity({ type: 'tool', name: 'Command', status: 'completed', input: { command: 'npm test' }, output: 'PASS  all 42 tests\nmore output that stays hidden' }, false)
  expect(html).toContain('PASS  all 42 tests')
  expect(html).not.toContain('more output that stays hidden')
  expect(html).not.toContain('<span>IN</span>')
  expect(html).not.toContain('<span>OUT</span>')
  const expanded = renderActivity({ type: 'tool', name: 'Command', status: 'completed', input: { command: 'npm test' }, output: 'PASS all tests' }, true)
  expect(expanded).not.toContain('sa-tool-preview')
})

it('truncates a long preview line and falls back to stderr when there is no stdout yet', () => {
  expect(toolInlinePreview({ type: 'tool', name: 'Command', status: 'running' })).toBe('')
  expect(toolInlinePreview({ type: 'tool', name: 'Command', status: 'failed', stderr: 'boom\nmore detail' })).toBe('boom')
  const long = toolInlinePreview({ type: 'tool', name: 'Command', status: 'completed', output: 'x'.repeat(500) })
  expect(long.length).toBeLessThan(165)
  expect(long.endsWith('…')).toBe(true)
})

it('coalesces successive edits to the same file into one row with a visible count, unless interrupted by commentary', () => {
  const edit = (id: string, path: string): TimelineItem => ({ id, runtimeId: 'runtime', sequence: Number(id), timestamp: '', data: { type: 'tool', name: 'Edit', status: 'completed', input: { file_path: path } } })
  const items: TimelineItem[] = [
    edit('1', 'src/a.ts'), edit('2', 'src/a.ts'), edit('3', 'src/a.ts'), edit('4', 'src/a.ts'),
    { id: '5', runtimeId: 'runtime', sequence: 5, timestamp: '', data: { type: 'text', role: 'assistant', text: 'Now updating b.ts', mode: 'snapshot' } },
    edit('6', 'src/b.ts')
  ]
  const groups = groupConversationActivities(items)
  expect(groups.map(group => group.map(item => item.id))).toEqual([['1', '2', '3', '4'], ['5'], ['6']])
  const summary = coalescedEditSummary(groups[0]!)
  expect(summary).toMatchObject({ path: 'src/a.ts', count: 4 })
  expect(coalescedEditLabel(summary!)).toBe('Edited src/a.ts · 4 edits')
  expect(coalescedEditSummary(groups[2]!)).toBeNull()
  expect(coalescedEditSummary([edit('1', 'src/a.ts')])).toBeNull()
})

it('aggregates additions and deletions across a coalesced run of file-change events, but not across different files', () => {
  const change = (id: string, path: string, additions?: number, deletions?: number): TimelineItem => ({ id, runtimeId: 'runtime', sequence: Number(id), timestamp: '', data: { type: 'changes', changes: [{ path, kind: 'update', status: 'applied', additions, deletions }] } })
  const groups = groupConversationActivities([change('1', 'src/a.ts', 1, 0), change('2', 'src/a.ts', 2, 1), change('3', 'src/a.ts', 0, 3)])
  expect(groups).toHaveLength(1)
  const summary = coalescedEditSummary(groups[0]!)
  expect(summary).toMatchObject({ path: 'src/a.ts', count: 3, additions: 3, deletions: 4 })
  expect(coalescedEditLabel(summary!)).toBe('Edited src/a.ts · 3 edits · +3 −4')
  const separate = groupConversationActivities([change('1', 'a.ts'), change('2', 'b.ts')])
  expect(separate.map(group => group.length)).toEqual([1, 1])
  expect(activityCoalesceTarget({ id: 'x', runtimeId: 'runtime', sequence: 1, timestamp: '', data: { type: 'changes', changes: [{ path: 'a.ts', kind: 'update', status: 'applied' }, { path: 'b.ts', kind: 'update', status: 'applied' }] } })).toBeNull()
  expect(activityCoalesceTarget({ id: 'x', runtimeId: 'runtime', sequence: 1, timestamp: '', data: { type: 'tool', name: 'Edit', status: 'completed', input: { file_path: 'a.ts' }, exitCode: 1 } })).toBeNull()
})

it('threads an optional project id through a file link without changing its default markup or click behaviour, and keeps the right-click menu absent until opened', () => {
  const text = '[panel.mjs](panel.mjs)'
  const withProject = renderToStaticMarkup(createElement(StructuredMarkdown, { cwd, projectId: 'project-1', onOpenFile: vi.fn(), text }))
  expect(withProject).toContain('href="#"')
  expect(withProject).not.toContain('cursor-context-menu')
  expect(withProject).not.toContain('sa-file-link-menu')
  // A project id is required for the menu (four of its six actions need one to scope the IPC/event
  // calls), but the link itself must keep working identically either way — same markup either way.
  const withoutProject = renderToStaticMarkup(createElement(StructuredMarkdown, { cwd, onOpenFile: vi.fn(), text }))
  expect(withoutProject).toBe(withProject)
})

it('shows which subagent a nested row belongs to with a stable color anchor, and leaves tool parents uncolored', () => {
  const item: TimelineItem = { id: 'child', runtimeId: 'runtime', parentId: 'parent-native', sequence: 1, timestamp: '', data: { type: 'text', role: 'assistant', text: 'Nested update', mode: 'snapshot' } }
  const render = (parentLabel: { name: string; colorIndex?: number }): string => renderToStaticMarkup(createElement(StructuredActivity, { item, sessionId: 'session', cwd, expanded: true, interactive: true, parentLabel, onExpand: vi.fn(), onOpenFile: vi.fn(), onDiff: vi.fn(), onRespond: vi.fn(async () => {}) }))
  const withAgent = render({ name: 'Reviewer #2', colorIndex: 3 })
  expect(withAgent).toContain('sa-parent-label sa-agent-hue-3')
  expect(withAgent).toContain('Within Reviewer #2')
  const withTool = render({ name: 'Bash' })
  expect(withTool).toContain('class="sa-parent-label"')
  expect(withTool).not.toContain('sa-agent-hue')
})

describe('runtime heartbeats', () => {
  const item = (nativeItemId: string, parentId?: string, data: TimelineItem['data'] = { type: 'tool', name: 'Skill', status: 'preparing', input: {} }): TimelineItem =>
    ({ id: nativeItemId, runtimeId: 'run', nativeItemId, parentId, data } as TimelineItem)

  it('hides the synthetic heartbeat clones a long tool emits under itself', () => {
    expect(isRuntimeHeartbeat(item('toolu_1-heartbeat-0', 'toolu_1'))).toBe(true)
    expect(isConversationActivity(item('toolu_1-heartbeat-24', 'toolu_1'))).toBe(false)
  })

  it('keeps real nested tools, including ones whose id merely looks similar', () => {
    expect(isRuntimeHeartbeat(item('toolu_2', 'toolu_1'))).toBe(false)
    expect(isRuntimeHeartbeat(item('toolu_1-heartbeat-x', 'toolu_1'))).toBe(false)
    expect(isRuntimeHeartbeat(item('toolu_9-heartbeat-1', 'toolu_1'))).toBe(false)
    expect(isConversationActivity(item('toolu_2', 'toolu_1', { type: 'tool', name: 'Bash', status: 'completed', input: { command: 'ls' } }))).toBe(true)
  })

  it('names a skill by the skill it ran instead of the bare tool name', () => {
    expect(toolPresentation({ type: 'tool', name: 'Skill', status: 'running', input: { skill: 'code-review', args: 'high' } }).title).toBe('code-review high')
    expect(toolPresentation({ type: 'tool', name: 'Unknown', status: 'running', input: {} }).title).toBe('Unknown')
  })

  it('heads a run of nested activity once instead of labelling every row', () => {
    const anchors = parentLabelAnchors([item('a', 'p1'), item('b', 'p1'), item('c'), item('d', 'p1'), item('e', 'p2')])
    expect([...anchors]).toEqual(['a', 'd', 'e'])
  })
})

describe('stepped questions', () => {
  const question = (id: string, label: string): NonNullable<PendingInteraction['questions']>[number] =>
    ({ id, question: 'Pick ' + id, header: id, multiSelect: false, options: [{ label }] })
  const ask = (...questions: NonNullable<PendingInteraction['questions']>): string =>
    renderActivity({ type: 'interaction', interaction: { id: 'ask', kind: 'question', title: 'Choices', status: 'pending', input: {}, choices: [], questions } })

  it('asks one question at a time instead of stacking them', () => {
    const html = ask(question('one', 'First'), question('two', 'Second'), question('three', 'Third'))
    expect(html).toContain('Question 1 of 3')
    expect(html).toContain('Pick one')
    expect(html).not.toContain('Pick two')
    expect(html).toContain('Next question</button>')
    expect(html).not.toContain('Submit answers</button>')
    expect(html).toContain('sa-question-steps')
  })

  it('leaves a single question as a plain form that submits directly', () => {
    const html = ask(question('only', 'Yes'))
    expect(html).not.toContain('Question 1 of 1')
    expect(html).not.toContain('sa-question-steps')
    expect(html).toContain('Submit answers</button>')
  })
})

describe('AskUserQuestion tool call and interaction correlation', () => {
  const toolItem = (nativeItemId: string, output?: string): TimelineItem =>
    ({ id: 'tool-' + nativeItemId, runtimeId: 'runtime', nativeItemId, sequence: 1, timestamp: '', data: { type: 'tool', name: 'AskUserQuestion', status: 'completed', output } })
  const questionInteractionItem = (nativeItemId: string, status: PendingInteraction['status'] = 'resolved'): TimelineItem =>
    ({ id: 'interaction-' + nativeItemId, runtimeId: 'runtime', nativeItemId, sequence: 2, timestamp: '', data: { type: 'interaction', interaction: {
      id: 'req-' + nativeItemId, kind: 'question', title: 'Claude needs your input', status, input: {}, choices: [],
      questions: [{ id: 'q', question: 'Pick one', options: [{ label: 'Blue' }], multiSelect: false }]
    } } })

  it('hides the AskUserQuestion tool call once its answer lives in the paired interaction', () => {
    const items = [toolItem('toolu_1', 'The user answered: "Pick one"="Blue"'), questionInteractionItem('toolu_1')]
    expect(isAnsweredThroughInteraction(items[0]!, items)).toBe(true)
    expect(items.filter((item, index) => isConversationActivity(item, index, items)).map((entry) => entry.id)).toEqual(['interaction-toolu_1'])
  })

  it('keeps a real approval tool call visible next to its approve/deny interaction', () => {
    const approvalTool = toolItem('toolu_2')
    approvalTool.data = { type: 'tool', name: 'Bash', status: 'completed', input: { command: 'ls' } }
    const approvalInteraction: TimelineItem = { id: 'interaction-toolu_2', runtimeId: 'runtime', nativeItemId: 'toolu_2', sequence: 2, timestamp: '', data: { type: 'interaction', interaction: { id: 'req-toolu_2', kind: 'approval', title: 'Allow Bash?', status: 'resolved', outcome: 'allow', input: {}, choices: [] } } }
    const items = [approvalTool, approvalInteraction]
    expect(isAnsweredThroughInteraction(approvalTool, items)).toBe(false)
    expect(items.filter((item, index) => isConversationActivity(item, index, items)).map((entry) => entry.id)).toEqual(['tool-toolu_2', 'interaction-toolu_2'])
  })

  it('never hides a tool call with no correlated question interaction', () => {
    const items = [toolItem('toolu_3')]
    expect(isConversationActivity(items[0]!, 0, items)).toBe(true)
  })

  it('shows a resolved question as one answered block, naming the actual question instead of the generic prompt', () => {
    const html = renderActivity({ type: 'interaction', interaction: {
      id: 'req-toolu_4', kind: 'question', title: 'Claude needs your input', status: 'resolved', input: {}, choices: [],
      questions: [{ id: 'q', question: 'Pick one', options: [{ label: 'Blue' }], multiSelect: false }]
    } })
    expect(html).toContain('<span>Pick one</span>')
    expect(html).not.toContain('<span>Claude needs your input</span>')
    expect(html).toContain('<small>Answered</small>')
    expect(html).not.toContain('needs-attention')
    expect(html).not.toContain('No output')
  })

  it('shows each question with its recorded answer, and an honest fallback when none was captured', () => {
    const withoutAnswer = renderActivity({ type: 'interaction', interaction: { id: 'q', kind: 'question', title: 'Claude needs your input', status: 'resolved', input: {}, choices: [], questions: [{ id: 'color', question: 'Which theme?', options: [{ label: 'Night' }, { label: 'Day' }], multiSelect: false }] } })
    expect(withoutAnswer).toContain('<dt>Which theme?</dt>')
    expect(withoutAnswer).toContain('No recorded answer')
  })

  it('expires a resolved-looking question interaction correctly when it was actually cancelled', () => {
    const expired = renderActivity({ type: 'interaction', interaction: { id: 'q', kind: 'question', title: 'Claude needs your input', status: 'expired', outcome: 'Interrupted by user', input: {}, choices: [], questions: [{ id: 'color', question: 'Which theme?', options: [{ label: 'Night' }], multiSelect: false }] } })
    expect(expired).toContain('<small>Expired</small>')
    expect(expired).toContain('Interrupted by user')
  })
})

describe('readableAnswerValue', () => {
  it('returns short values unchanged', () => {
    expect(readableAnswerValue('Blue')).toBe('Blue')
  })
  it('decodes percent-encoding', () => {
    expect(readableAnswerValue('Ice%20Berry')).toBe('Ice Berry')
  })
  it('shows an unparseable percent sequence verbatim instead of throwing', () => {
    expect(readableAnswerValue('50% done')).toBe('50% done')
  })
  it('truncates a long file path to its readable filename tail instead of cutting mid-word', () => {
    const value = 'file:///C:/Claude/miron/Chinese%20jar/deliveries/batch-20260909-151338-199935/08-ice-berry-haf-wide.jpg'
    expect(readableAnswerValue(value)).toBe('…/08-ice-berry-haf-wide.jpg')
  })
  it('truncates long free text on a word boundary', () => {
    const value = 'word '.repeat(20)
    const result = readableAnswerValue(value)
    expect(result.endsWith('…')).toBe(true)
    expect(result.slice(0, -1).trimEnd().endsWith('word')).toBe(true)
  })
})

describe('combinedQuestionAnswer', () => {
  const withOptions = (multiSelect: boolean): InputQuestion => ({ id: 'q', question: 'Q', options: [{ label: 'A' }, { label: 'B' }], multiSelect })
  const freeText: InputQuestion = { id: 'q', question: 'Why?', options: [], multiSelect: false }

  it('uses the selected option when custom is not selected', () => {
    expect(combinedQuestionAnswer(withOptions(false), ['A'], false, 'ignored')).toEqual(['A'])
  })
  it('uses only the custom text once selected, for a single-select question', () => {
    expect(combinedQuestionAnswer(withOptions(false), [], true, 'My answer')).toEqual(['My answer'])
  })
  it('falls back to the selected options when custom is selected but left empty', () => {
    expect(combinedQuestionAnswer(withOptions(false), ['A'], true, '   ')).toEqual(['A'])
  })
  it('adds the custom text alongside checked options for a multi-select question', () => {
    expect(combinedQuestionAnswer(withOptions(true), ['A', 'B'], true, 'Also this')).toEqual(['A', 'B', 'Also this'])
  })
  it('ignores an unselected custom text for a multi-select question', () => {
    expect(combinedQuestionAnswer(withOptions(true), ['A'], false, 'typed but not selected')).toEqual(['A'])
  })
  it('treats a plain free-text question as answered only once typed', () => {
    expect(combinedQuestionAnswer(freeText, [], false, '')).toEqual([])
    expect(combinedQuestionAnswer(freeText, [], false, 'Because')).toEqual(['Because'])
  })
})

describe('custom answer as a selectable option', () => {
  it('offers "Other" as one more selectable choice instead of a parallel textbox', () => {
    const interaction: PendingInteraction = { id: 'q', kind: 'question', title: 'Pick', status: 'pending', input: {}, choices: [], questions: [{ id: 'color', question: 'Pick a color', options: [{ label: 'Blue' }, { label: 'Green' }], multiSelect: false }] }
    const html = renderActivity({ type: 'interaction', interaction })
    expect(html).toContain('<strong>Other</strong>')
    expect((html.match(/type="radio"/g) ?? []).length).toBe(3)
    expect(html).not.toContain('class="sa-custom-answer"')
  })
  it('still offers a plain free-text field for a question with no options at all', () => {
    const interaction: PendingInteraction = { id: 'q', kind: 'question', title: 'Explain', status: 'pending', input: {}, choices: [], questions: [{ id: 'why', question: 'Why?', options: [], multiSelect: false }] }
    const html = renderActivity({ type: 'interaction', interaction })
    expect(html).not.toContain('<strong>Other</strong>')
    expect(html).toContain('class="sa-custom-answer"')
  })
  it('offers "Other" as one more checkbox for a multi-select question', () => {
    const interaction: PendingInteraction = { id: 'q', kind: 'question', title: 'Pick', status: 'pending', input: {}, choices: [], questions: [{ id: 'systems', question: 'Which systems?', options: [{ label: 'Windows' }, { label: 'Linux' }], multiSelect: true }] }
    const html = renderActivity({ type: 'interaction', interaction })
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(3)
    expect(html).toContain('<strong>Other</strong>')
  })
})

it('resolves the Windows drive-path link shapes an agent actually writes', () => {
  expect(safeFileTarget('/C:/work/My project/src/panel.mjs', cwd)).toEqual({ path: 'src/panel.mjs', line: undefined })
  expect(safeFileTarget('/C:/work/My%20project/CR5%20render.png', cwd)).toEqual({ path: 'CR5 render.png', line: undefined })
  expect(safeFileTarget('file:///C:/work/My project/src/panel.mjs', cwd)).toEqual({ path: 'src/panel.mjs', line: undefined })
})

it('keeps a drive-path link clickable instead of blanking its href, and still drops one outside every project', () => {
  const render = (target: string): string => renderToStaticMarkup(createElement(StructuredMarkdown, { cwd, projectId: 'project-1', onOpenFile: vi.fn(), text: '[render](' + target + ')' }))
  // A destination with literal spaces is only a link at all inside angle brackets; both that
  // shape and the percent-encoded one name the same file and both must survive urlTransform.
  for (const target of ['/C:/work/My%20project/CR5%20render.png', '<file:///C:/work/My project/CR5 render.png>', '<C:\\work\\My project\\CR5 render.png>']) {
    expect(render(target)).toContain('<a href="#">render</a>')
  }
  expect(render('/C:/elsewhere/secret.png')).toBe('<div class="sa-markdown"><p><span>render</span></p></div>')
})
