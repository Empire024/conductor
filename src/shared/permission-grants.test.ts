import { describe, expect, it } from 'vitest'
import { callMatchesRule, commandHost, describeGrantRequest, escapeRuleContent, grantStatusOf, permissionGrantOf, posixPath } from './permission-grants'

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
