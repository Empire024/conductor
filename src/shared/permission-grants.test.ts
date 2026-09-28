import { describe, expect, it } from 'vitest'
import { callMatchesRule, changesDirectoryBeforeInput, commandHost, describeGrantRequest, escapeRuleContent, grantStatusOf, nativeGrantRules, permissionGrantOf, posixPath } from './permission-grants'

const cwd = 'C:\\Users\\owner\\site\\theme'

describe('the narrowest rule for one call', () => {
  it('writes a file rule anchored at the root, in the POSIX form the CLI matches Windows paths as', () => {
    expect(posixPath('C:\\Users\\owner\\a b\\x.sh')).toBe('/c/Users/owner/a b/x.sh')
    expect(describeGrantRequest({ tool: 'Write', input: { file_path: 'C:\\Users\\owner\\site\\app\\prod\\fix-pool.sh' }, cwd, category: 'Modify Shared Resources' }))
      .toMatchObject({ action: 'Write a file', resource: 'C:\\Users\\owner\\site\\app\\prod\\fix-pool.sh', class: 'local', rule: 'Edit(//c/Users/owner/site/app/prod/fix-pool.sh)', category: 'Modify Shared Resources' })
    // A relative path is the conversation's own folder.
    expect(describeGrantRequest({ tool: 'Edit', input: { file_path: 'scripts/deploy.sh' }, cwd }).rule).toBe('Edit(//c/Users/owner/site/theme/scripts/deploy.sh)')
    expect(describeGrantRequest({ tool: 'Write', input: { file_path: '/home/owner/x.sh' }, cwd: '/home/owner' }).rule).toBe('Edit(//home/owner/x.sh)')
    // A system folder is shared, and parentheses are escaped the way the CLI's parser unescapes them.
    expect(describeGrantRequest({ tool: 'Write', input: { file_path: 'C:\\Program Files (x86)\\app\\x.ini' }, cwd })).toMatchObject({ class: 'shared', rule: 'Edit(//c/Program Files \\(x86\\)/app/x.ini)' })
  })

  it('never offers a rule that lets an agent change its own permissions, or that matches more than the one file', () => {
    for (const path of ['.claude\\settings.local.json', 'C:\\Users\\owner\\.claude\\settings.json', '.mcp.json', '.git\\hooks\\pre-commit']) {
      const request = describeGrantRequest({ tool: 'Write', input: { file_path: path }, cwd })
      expect(request.rule).toBeUndefined()
      expect(request.refusal).toMatch(/never grants/)
    }
    expect(describeGrantRequest({ tool: 'Write', input: { file_path: 'src/*.ts' }, cwd }).rule).toBeUndefined()
    const skill = describeGrantRequest({ tool: 'Skill', input: { skill: 'update-config' }, cwd })
    expect(skill.rule).toBeUndefined()
    expect(skill.class).toBe('shared')
  })

  it('makes a command rule exact, classes it, names its host, and refuses a command the CLI would read as a wildcard', () => {
    const ssh = 'ssh -o BatchMode=yes -i C:\\keys\\deploy root@192.0.2.10 bash -s < app/prod/fix-pool.sh'
    expect(describeGrantRequest({ tool: 'Bash', input: { command: ssh }, cwd })).toMatchObject({ action: 'Run a command', class: 'external', host: '192.0.2.10', rule: `Bash(${escapeRuleContent(ssh)})` })
    expect(escapeRuleContent('echo (a) C:\\x')).toBe('echo \\(a\\) C:\\\\x')
    expect(describeGrantRequest({ tool: 'Bash', input: { command: 'rm -rf build' }, cwd }).class).toBe('destructive')
    expect(describeGrantRequest({ tool: 'PowerShell', input: { command: 'Remove-Item -Recurse out' }, cwd })).toMatchObject({ class: 'destructive', rule: 'PowerShell(Remove-Item -Recurse out)' })
    expect(describeGrantRequest({ tool: 'Bash', input: { command: 'npm test' }, cwd })).toMatchObject({ class: 'local', rule: 'Bash(npm test)' })
    const wildcard = describeGrantRequest({ tool: 'Bash', input: { command: 'ls *.sh' }, cwd })
    expect(wildcard.rule).toBeUndefined()
    expect(wildcard.refusal).toMatch(/wildcard/)
    expect(describeGrantRequest({ tool: 'Bash', input: { command: 'npm:' }, cwd }).rule).toBeUndefined()
    expect(commandHost('scp x.sh deploy@example.com:/tmp')).toBe('example.com')
    expect(commandHost('git status')).toBeUndefined()
  })

  it('covers web fetches by domain and MCP tools by exact name; a Conductor tool is local', () => {
    expect(describeGrantRequest({ tool: 'WebFetch', input: { url: 'https://api.example.com/v1' }, cwd })).toMatchObject({ class: 'external', host: 'api.example.com', rule: 'WebFetch(domain:api.example.com)' })
    expect(describeGrantRequest({ tool: 'mcp__conductor__send_message', input: { agentSessionId: 'a', text: 'hi' }, cwd })).toMatchObject({ class: 'local', rule: 'mcp__conductor__send_message' })
    expect(describeGrantRequest({ tool: 'mcp__github__create_issue', input: {}, cwd }).class).toBe('external')
    const agent = describeGrantRequest({ tool: 'Agent', input: {}, cwd })
    expect(agent.rule).toBeUndefined()
    expect(agent.class).toBe('shared')
  })

  it('matches only the very call a rule was minted for', () => {
    const rule = describeGrantRequest({ tool: 'Bash', input: { command: 'ssh root@192.0.2.10 uptime' }, cwd }).rule!
    expect(callMatchesRule(rule, 'Bash', { command: 'ssh root@192.0.2.10 uptime' }, cwd)).toBe(true)
    expect(callMatchesRule(rule, 'Bash', { command: 'ssh root@192.0.2.10 reboot' }, cwd)).toBe(false)
    expect(callMatchesRule(rule, 'PowerShell', { command: 'ssh root@192.0.2.10 uptime' }, cwd)).toBe(false)
    const file = describeGrantRequest({ tool: 'Write', input: { file_path: 'a.sh' }, cwd }).rule!
    expect(callMatchesRule(file, 'Edit', { file_path: 'C:\\Users\\owner\\site\\theme\\a.sh' }, cwd)).toBe(true)
  })

  it('reads an agent request card and a denial card\'s answer back from a notice', () => {
    const request = { id: 'grant:1', source: 'agent', tool: 'Bash', action: 'Run a command', resource: 'npm test', class: 'local', rule: 'Bash(npm test)', status: 'pending', requestedAt: 'now' }
    expect(permissionGrantOf({ type: 'notice', payload: { permissionGrant: request } })).toEqual(request)
    expect(permissionGrantOf({ type: 'notice', payload: { permissionGrant: { ...request, class: 'everything' } } })).toBeUndefined()
    expect(permissionGrantOf({ type: 'text', payload: { permissionGrant: request } })).toBeUndefined()
    expect(grantStatusOf({ type: 'notice', payload: { grantStatus: 'approved-once' } })).toBe('approved-once')
    expect(grantStatusOf({ type: 'notice', payload: { grantStatus: 'owned' } })).toBeUndefined()
  })
})

// Probed against claude 2.1.282 in manual mode on 2026-09-28 (docs/permissions-classifier.md): an exact
// rule for a whole pipeline never matches it, one exact rule per | part does; && and ; chains match
// the whole rule; an input redirect after a cd in the same command is never allowed by any rule.
describe('the native rules one grant installs (permission-approval-delivery-classifier, item 3)', () => {
  it('adds one exact rule per pipeline part, and nothing for a command that is not a pipeline', () => {
    expect(nativeGrantRules('Bash(node -e "x" 2>&1 | tail -5)')).toEqual(['Bash(node -e "x" 2>&1 | tail -5)', 'Bash(node -e "x" 2>&1)', 'Bash(tail -5)'])
    expect(nativeGrantRules('Bash(cd app && node run.js | tail -5)')).toEqual(['Bash(cd app && node run.js | tail -5)', 'Bash(cd app && node run.js)', 'Bash(tail -5)'])
    for (const rule of ['Bash(git status)', 'Bash(npm test && npm run build)', 'Bash(a || b)', 'Bash(echo "a | b")', "Bash(grep 'x|y' file)", 'Bash(echo $(ls \| wc -l\))', 'Edit(//c/x)', 'PowerShell(a | b)', 'mcp__conductor__report'])
      expect(nativeGrantRules(rule)).toEqual([rule])
  })

  it('keeps every part a literal piece of the approved command: no wildcard, no widening', () => {
    const rule = describeGrantRequest({ tool: 'Bash', input: { command: "ssh -o BatchMode=yes root@192.0.2.10 'bash -s -- --check' < app/prod/fix-pool.sh 2>&1 | tail -40" }, cwd: 'C:\\p' }).rule!
    const content = (native: string) => native.slice(5, -1).replaceAll('\\(', '(').replaceAll('\\)', ')')
    for (const native of nativeGrantRules(rule)) {
      expect(native.startsWith('Bash(')).toBe(true)
      expect(native).not.toContain('*')
      expect(content(rule)).toContain(content(native))
    }
  })

  it('refuses the haftheme shape, a cd followed by an input redirect, and says how to ask instead', () => {
    const haftheme = 'cd "/c/Claude/haftheme/app" && ssh -i ~/.ssh/key root@45.63.56.18 \'bash -s -- --check\' < prod/fix-lsphp-pool.sh 2>&1 | tail -40'
    const described = describeGrantRequest({ tool: 'Bash', input: { command: haftheme }, cwd: 'C:\\p' })
    expect(described.rule).toBeUndefined()
    expect(described.refusal).toMatch(/no allow rule can ever let it through.*without the cd/s)
    expect(describeGrantRequest({ tool: 'Bash', input: { command: "ssh -i ~/.ssh/key root@45.63.56.18 'bash -s -- --check' < app/prod/fix-lsphp-pool.sh 2>&1 | tail -40" }, cwd: 'C:\\p' }).rule).toBeTruthy()
    expect(changesDirectoryBeforeInput('cd app; node run.js < in.txt')).toBe(true)
    expect(changesDirectoryBeforeInput('pushd app && sort < in.txt | head')).toBe(true)
    for (const command of ['cd app && node run.js | tail -5', 'node run.js < app/in.txt', 'cd app && cat <<EOF', 'cd app && diff <(a) <(b)', 'cd app && echo "a < b"', 'cd app && node x.js 2>&1', 'node x.js < in.txt && cd app'])
      expect(changesDirectoryBeforeInput(command)).toBe(false)
  })
})
