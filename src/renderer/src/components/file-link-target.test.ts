import { describe, expect, it } from 'vitest'
import { normalizeLinkPath, resolveFileLinkTarget, type ResolvedFileLink } from './file-link-target'

const cwd = 'C:\\Claude\\miron'
const projects = [
  { id: 'miron', path: 'C:\\Claude\\miron' },
  { id: 'conductor', path: 'C:\\Claude\\conductor' },
  { id: 'nested', path: 'C:\\Claude\\conductor\\vendor\\kit' }
]

describe('agent file link resolution', () => {
  const cases: Array<[string, string, ResolvedFileLink | null]> = [
    ['drive path a URL parser produced', '/C:/Claude/miron/CR5.png', { path: 'CR5.png', line: undefined, projectId: undefined }],
    ['native Windows path', 'C:\\Claude\\miron\\CR5.png', { path: 'CR5.png', line: undefined, projectId: undefined }],
    ['forward-slash drive path', 'C:/Claude/miron/CR5.png', { path: 'CR5.png', line: undefined, projectId: undefined }],
    ['file URL', 'file:///C:/Claude/miron/CR5.png', { path: 'CR5.png', line: undefined, projectId: undefined }],
    ['percent-encoded spaces', '/C:/Claude/miron/renders/Before%20after%20comparison.png', { path: 'renders/Before after comparison.png', line: undefined, projectId: undefined }],
    ['literal spaces in a file URL', 'file:///C:/Claude/miron/CR5 model.blend', { path: 'CR5 model.blend', line: undefined, projectId: undefined }],
    ['same-project relative path with a line', 'src/panel.mjs:42', { path: 'src/panel.mjs', line: 42, projectId: undefined }],
    ['dot-slash relative path', './notes/plan.md', { path: 'notes/plan.md', line: undefined, projectId: undefined }],
    ['sibling project absolute path', '/C:/Claude/conductor/src/main/index.ts', { path: 'src/main/index.ts', line: undefined, projectId: 'conductor' }],
    ['sibling project path with %20 and a line anchor', 'C:\\Claude\\conductor\\docs\\NEXT%20VERSION.md#L12', { path: 'docs/NEXT VERSION.md', line: 12, projectId: 'conductor' }],
    ['project nested inside another wins over its parent', 'C:/Claude/conductor/vendor/kit/build.gradle', { path: 'build.gradle', line: undefined, projectId: 'nested' }],
    ['case-insensitive drive and folder match', '/c:/claude/CONDUCTOR/package.json', { path: 'package.json', line: undefined, projectId: 'conductor' }],
    ['outside every open project', 'C:\\Users\\stilj\\.ssh\\id_rsa', null],
    ['file URL outside every open project', 'file:///C:/Windows/System32/drivers/etc/hosts', null],
    ['traversal out of the workspace', '../secret', null],
    ['encoded traversal', '%2e%2e/secret', null],
    ['traversal inside an absolute project path', 'C:/Claude/miron/../conductor/.env', null],
    ['UNC share', '//host/share/file.txt', null],
    ['UNC through a file URL', 'file://host/share/file.txt', null],
    ['drive letter only', 'C:', null],
    ['drive letter only with the URL leading slash', '/C:', null],
    ['drive root', 'C:/', null],
    ['posix absolute path', '/etc/passwd', null],
    ['other URL scheme', 'javascript:alert(1)', null],
    ['alternate data stream', 'notes.txt:hidden', null],
    ['malformed percent escape', '%ZZ', null],
    ['control character', 'src/\u0000file.ts', null],
    ['sibling prefix that is not a real containment', 'C:/Claude/miron-copy/file.ts', null]
  ]
  for (const [name, raw, expected] of cases) it(name, () => expect(resolveFileLinkTarget(raw, cwd, projects)).toEqual(expected))

  it('resolves only inside the conversation workspace when no sibling projects are known', () => {
    expect(resolveFileLinkTarget('/C:/Claude/miron/CR5.png', cwd)).toEqual({ path: 'CR5.png', line: undefined, projectId: undefined })
    expect(resolveFileLinkTarget('/C:/Claude/conductor/src/main/index.ts', cwd)).toBeNull()
  })

  it('keeps the conversation workspace when a listed project repeats it, so the host scope is used', () => {
    expect(resolveFileLinkTarget('C:/Claude/miron/CR5.png', cwd, projects)?.projectId).toBeUndefined()
    expect(resolveFileLinkTarget('C:/Claude/miron/CR5.png', 'C:/Claude/other', projects)?.projectId).toBe('miron')
  })

  it('retains remote machine ownership without changing local target shapes', () => {
    expect(resolveFileLinkTarget('src/panel.mjs:42', cwd, projects, 'host-a')).toEqual({
      path: 'src/panel.mjs', line: 42, projectId: undefined, machineId: 'host-a'
    })
    expect(resolveFileLinkTarget('src/panel.mjs:42', cwd, projects)).toEqual({
      path: 'src/panel.mjs', line: 42, projectId: undefined
    })
  })

  it('normalizes every drive-path shape to one path and reads a trailing line reference', () => {
    for (const raw of ['C:\\Claude\\miron\\a b.txt', 'C:/Claude/miron/a b.txt', '/C:/Claude/miron/a b.txt', 'file:///C:/Claude/miron/a%20b.txt']) {
      expect(normalizeLinkPath(raw)).toEqual({ path: 'C:/Claude/miron/a b.txt', line: undefined })
    }
    expect(normalizeLinkPath('src/panel.mjs:12:4')).toEqual({ path: 'src/panel.mjs', line: 12 })
    expect(normalizeLinkPath('src/panel.mjs:0')).toEqual({ path: 'src/panel.mjs', line: undefined })
    expect(normalizeLinkPath('%ZZ')).toBeNull()
  })
})
