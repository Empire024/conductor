import { describe, expect, it } from 'vitest'
import { commandClass, commandText, SessionRules, type ClassifiedAction } from './approval-review-rules'

const bash = (command: string, overrides: Partial<ClassifiedAction> = {}): ClassifiedAction => ({ tool: 'Bash', arguments: { command }, paths: [], boundary: 'workspace-write', cwd: 'C:/work', ...overrides })

describe('approval session rule classes', () => {
  it('groups a program with its subcommand, and a runner with its script', () => {
    expect(commandClass(bash('npm test'))).toBe('Bash:npm test')
    expect(commandClass(bash('npm test -- --run src/a.test.ts'))).toBe('Bash:npm test')
    expect(commandClass(bash('npx tsc --noEmit -p tsconfig.json'))).toBe('Bash:npx tsc')
    expect(commandClass(bash('git status --short'))).toBe('Bash:git status')
    expect(commandClass(bash('npm run build'))).toBe('Bash:npm run build')
    expect(commandClass(bash('npm run lint -- --fix'))).toBe('Bash:npm run lint')
    expect(commandClass(bash('npm run deploy'))).not.toBe(commandClass(bash('npm run build')))
  })
  it('keeps compound, flag-led and inline-code commands as their own exact class', () => {
    expect(commandClass(bash('npm test && npm run lint'))).toBe('Bash=npm test && npm run lint')
    expect(commandClass(bash('node -e "require(1)"'))).toBe('Bash=node -e "require(1)"')
    expect(commandClass(bash('cat a > b'))).toBe('Bash=cat a > b')
    expect(commandClass(bash('echo $(whoami)'))).toBe('Bash=echo $(whoami)')
  })
  it('never forms a class for external, destructive or owner-boundary actions', () => {
    expect(commandClass(bash('git push origin main'))).toBeUndefined()
    expect(commandClass(bash('curl https://example.com'))).toBeUndefined()
    expect(commandClass(bash('rm -rf dist'))).toBeUndefined()
    expect(commandClass(bash('npm test', { boundary: 'native-owner' }))).toBeUndefined()
    expect(commandClass({ tool: 'mcp__github__create_issue', arguments: {}, paths: [], boundary: 'workspace-write' })).toBeUndefined()
    expect(commandClass({ tool: 'Write', arguments: { truncatedForReview: true }, paths: ['c:/work/a.ts'], boundary: 'workspace-write' })).toBeUndefined()
  })
  it('groups workspace edits, read-only tools and one web host', () => {
    expect(commandClass({ tool: 'Edit', arguments: { file_path: 'src/a.ts' }, paths: ['c:/work/src/a.ts'], boundary: 'workspace-write', cwd: 'C:/work' })).toBe('edit:workspace')
    expect(commandClass({ tool: 'Write', arguments: { file_path: 'C:/work/.claude/settings.json' }, paths: ['c:/work/.claude/settings.json'], boundary: 'workspace-write', cwd: 'C:/work' })).toBeUndefined()
    expect(commandClass({ tool: 'Grep', arguments: { pattern: 'x' }, paths: [], boundary: 'workspace-write' })).toBe('tool:Grep')
    expect(commandClass({ tool: 'WebFetch', arguments: { url: 'https://docs.example.com/a' }, paths: [], boundary: 'workspace-write' })).toBe('fetch:docs.example.com')
  })
  it('classes the conductor control tool by the method it calls', () => {
    const control = (args: Record<string, unknown>): ClassifiedAction => ({ tool: 'mcp__conductor__control', arguments: args as never, paths: [], boundary: 'workspace-write' })
    expect(commandClass(control({ method: 'tools.list', args: { brief: true } }))).toBe('mcp:mcp__conductor__control:tools.list')
    expect(commandClass(control({ method: 'tabs.close', args: { tabId: 'tab_1' } }))).toBe('mcp:mcp__conductor__control:tabs.close')
    expect(commandClass(control({}))).toBeUndefined()
    expect(commandClass({ tool: 'mcp__conductor__send_message', arguments: { text: 'hi' }, paths: [], boundary: 'workspace-write' })).toBe('mcp:mcp__conductor__send_message')
  })
  it('reads Codex commands through the Windows PowerShell wrapper', () => {
    expect(commandText({ command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'npm test\'' })).toBe('npm test')
    expect(commandText({ command: ['git', 'status'] })).toBe('git status')
    expect(commandClass({ tool: 'item/commandExecution/requestApproval', arguments: { command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'npx vitest run\'' }, paths: [], boundary: 'workspace-write' })).toBe('item/commandExecution/requestApproval:npx vitest')
  })
  it('covers a later action of the same class for the same worker runtime only', () => {
    const rules = new SessionRules()
    const worker = { workerId: 'worker', runtimeId: 'runtime-1' }
    rules.add(worker, { key: commandClass(bash('npm test'))!, source: 'review', by: 'claude-opus', at: 'now', example: 'Bash' })
    expect(rules.covering(worker, bash('npm test -- --watch=false'))?.key).toBe('Bash:npm test')
    expect(rules.covering(worker, bash('npm run build'))).toBeUndefined()
    expect(rules.covering({ workerId: 'other-worker', runtimeId: 'runtime-1' }, bash('npm test'))).toBeUndefined()
    // A restarted conversation (a new runtime) starts without the rules, like the CLI's own session approvals.
    expect(rules.covering({ workerId: 'worker', runtimeId: 'runtime-2' }, bash('npm test'))).toBeUndefined()
    rules.clear('worker')
    expect(rules.covering(worker, bash('npm test'))).toBeUndefined()
  })
})
