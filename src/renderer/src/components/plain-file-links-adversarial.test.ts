import { describe, expect, it } from 'vitest'
import { findPlainFileLinks, plainFileLinkRemarkPlugin } from './plain-file-links'

describe('plain file links review regressions', () => {
  it('keeps repeated paths in source order', () => {
    const tree: any = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'a.ts b.ts a.ts' }] }] }
    plainFileLinkRemarkPlugin(new Set(['p\u0000a.ts', 'p\u0000b.ts']), 'C:/project', 'p', [])()(tree)
    expect(tree.children[0].children.filter((node: any) => node.type === 'link').map((node: any) => node.url)).toEqual(['a.ts', 'b.ts', 'a.ts'])
  })

  it('does not consume prose after an absolute Windows file path', () => {
    const links = findPlainFileLinks('Updated C:\\project\\src\\a.ts and added tests.', 'C:/project', 'p', [])
    expect(links.some(link => link.path === 'src/a.ts')).toBe(true)
    expect(links.some(link => link.path.includes(' and added'))).toBe(false)
  })

  it('preserves multi-dot filenames in ordinary test paths', () => {
    expect(findPlainFileLinks('src/file-link.test.ts', 'C:/project', 'p', [])[0]?.path).toBe('src/file-link.test.ts')
    expect(findPlainFileLinks('C:\\project\\src\\file-link.test.ts and C:\\project\\src\\other.ts', 'C:/project', 'p', []).map(link => link.path)).toEqual(['src/file-link.test.ts', 'src/other.ts'])
  })
})
