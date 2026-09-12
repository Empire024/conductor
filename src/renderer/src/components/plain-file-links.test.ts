import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, describe, expect, it } from 'vitest'
import { collectFileLinkCandidates, findInlineCodeFileLinks, findPlainFileLinks, plainFileLinkCacheForTest, plainFileLinkRemarkPlugin } from './plain-file-links'
import { resolveFileLinkTarget } from './file-link-target'

const cwd = 'C:\\Claude\\conductor'
const projectId = 'conductor'

describe('plain agent file paths', () => {
  afterEach(() => { plainFileLinkCacheForTest.clear() })
  it('recognizes only path-shaped local candidates, retaining escaped Windows spaces and line references', () => {
    expect(findPlainFileLinks('See src/renderer/src/panes/StructuredAgentRenderers.tsx:193 and C:\\Claude\\conductor\\feature list.md#L7.', cwd, projectId, [])).toEqual([
      { raw: 'src/renderer/src/panes/StructuredAgentRenderers.tsx:193', path: 'src/renderer/src/panes/StructuredAgentRenderers.tsx', line: 193, projectId: undefined, key: 'conductor\u0000src/renderer/src/panes/StructuredAgentRenderers.tsx' },
      { raw: 'C:\\Claude\\conductor\\feature list.md#L7', path: 'feature list.md', line: 7, projectId: undefined, key: 'conductor\u0000feature list.md' }
    ])
    expect(findPlainFileLinks('Keep ordinary prose release.1 and an https://example.com/a.ts URL.', cwd, projectId, [])).toEqual([])
    expect(findPlainFileLinks('Changed C:\\Claude\\conductor\\a.ts and C:\\Claude\\conductor\\b.ts.', cwd, projectId, []).map(link => link.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('turns only verified plain text and inline-code paths into links', () => {
    const path = 'src/renderer/src/panes/StructuredAgentRenderers.tsx'
    const key = projectId + '\u0000' + path
    const plugin = plainFileLinkRemarkPlugin(new Set([key]), cwd, projectId, [])()
    const tree = { type: 'root', children: [
      { type: 'paragraph', children: [{ type: 'text', value: 'Open ' + path + '; leave missing.ts ordinary.' }, { type: 'inlineCode', value: path }] },
      { type: 'code', value: path },
      { type: 'link', url: 'https://example.com/' + path, children: [{ type: 'text', value: path }] }
    ] }
    plugin(tree)
    const paragraph = tree.children[0]!.children!
    expect(paragraph[1]).toMatchObject({ type: 'link', url: path })
    expect(paragraph[2]).toMatchObject({ type: 'text', value: '; leave missing.ts ordinary.' })
    expect(paragraph[3]).toMatchObject({ type: 'link', url: path, children: [{ type: 'inlineCode', value: path }] })
    expect(tree.children[1]).toMatchObject({ type: 'code', value: path })
    expect(tree.children[2]).toMatchObject({ type: 'link', url: 'https://example.com/' + path })
  })

  it('expires checked files and bounds the shared result cache', () => {
    plainFileLinkCacheForTest.clear()
    plainFileLinkCacheForTest.put('p\u0000fresh.ts', true, 1_000)
    expect(plainFileLinkCacheForTest.get('p\u0000fresh.ts', 15_999)).toBe(true)
    expect(plainFileLinkCacheForTest.get('p\u0000fresh.ts', 16_000)).toBe(false)
    for (let index = 0; index < 520; index++) plainFileLinkCacheForTest.put('p\u0000' + index + '.ts', true, 2_000)
    expect(plainFileLinkCacheForTest.size()).toBe(512)
    expect(plainFileLinkCacheForTest.get('p\u00000.ts', 2_001)).toBe(false)
  })

  it('rechecks an expired path only when a current message observes it again, with no timer polling', () => {
    const link = { raw: 'a.ts', path: 'a.ts', key: 'p\u0000a.ts' }
    plainFileLinkCacheForTest.put(link.key, true, Date.now())
    expect(plainFileLinkCacheForTest.pendingKeys()).toEqual([])
    plainFileLinkCacheForTest.observe([link])
    expect(plainFileLinkCacheForTest.pendingKeys()).toEqual([])
    plainFileLinkCacheForTest.clearPending()
    // A remount after TTL asks once for a new stat; it does not create a recurring scheduler.
    plainFileLinkCacheForTest.put(link.key, true, Date.now() - 15_001)
    plainFileLinkCacheForTest.observe([link])
    expect(plainFileLinkCacheForTest.pendingKeys()).toEqual([link.key])
  })

  it('links the captured spaced Windows sibling path after real Markdown parsing', () => {
    const sibling = 'C:\\Users\\stilj\\AppData\\Local\\Temp\\conductor-plain-file-links-KM5vao\\projects\\Plain links sibling\\docs\\Sibling notes.md'
    const root = 'C:\\Users\\stilj\\AppData\\Local\\Temp\\conductor-plain-file-links-KM5vao\\projects\\Plain links fixture'
    const projects = [{ id: 'sibling', path: 'C:\\Users\\stilj\\AppData\\Local\\Temp\\conductor-plain-file-links-KM5vao\\projects\\Plain links sibling' }]
    const link = findPlainFileLinks(sibling, root, 'current', projects)[0]!
    expect(link).toMatchObject({ path: 'docs/Sibling notes.md', projectId: 'sibling' })
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, plainFileLinkRemarkPlugin(new Set([link.key]), root, 'current', projects)], urlTransform: url => resolveFileLinkTarget(url, root, projects) ? '#' : '' }, sibling))
    expect(html).toContain('<a href="#" class="sa-plain-file-link">' + sibling + '</a>')
  })

  it('links the exact spaced inline-code filename from the smoke message after Markdown parsing', () => {
    const text = 'Inline local path: `CR5 model.blend`.'
    const key = 'current\u0000CR5 model.blend'
    expect(findInlineCodeFileLinks(text, cwd, 'current', [])).toEqual([{ raw: 'CR5 model.blend', path: 'CR5 model.blend', key }])
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, plainFileLinkRemarkPlugin(new Set([key]), cwd, 'current', [])], urlTransform: () => '#' }, text))
    expect(html).toContain('<a href="#" class="sa-plain-file-link"><code>CR5 model.blend</code></a>')
  })

  it('bounds and deduplicates hook candidates while prioritizing full inline-code paths', () => {
    const text = Array.from({ length: 110 }, (_, index) => '`CR5 model ' + index + '.blend`').join(' ') + ' model 0.blend'
    const candidates = collectFileLinkCandidates(text, cwd, 'current', [])
    expect(candidates).toHaveLength(96)
    expect(candidates[0]).toMatchObject({ raw: 'CR5 model 0.blend', path: 'CR5 model 0.blend' })
    expect(new Set(candidates.map(link => link.key)).size).toBe(96)
  })
})
