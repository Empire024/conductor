import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEventData, TimelineItem } from '../../../shared/structured-agent'
import { rendererKind, safeExternalLink, safeFileTarget, StructuredActivity, StructuredMarkdown, toolPresentation } from './StructuredAgentRenderers'

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
    expect(html).toContain('execution is not yet confirmed')
    expect(html).not.toContain('Exit 0')
    expect(html).toContain('IN')
    expect(html).toContain('OUT')
    expect(toolPresentation({ type: 'tool', name: 'Bash', status: 'preparing', input: {}, inputDelta: '{"command":"git' }).input).toBe('{"command":"git')
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
})
