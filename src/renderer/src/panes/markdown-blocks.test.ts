import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { markdownBlocks } from './markdown-blocks'

const html = (text: string): string => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], skipHtml: true }, text)).replace(/>\s+</g, '><').trim()
const joined = (text: string): string => markdownBlocks(text).map(html).join('')

const reply = [
  '## Step 12: tracing the panel state',
  'Paragraph 12: the renderer keeps **bold**, _italic_ and `inline code` spans, a [link](src/file-12.ts#L13) and a path like `src/renderer/src/panes/file-12.tsx:13`.',
  '- first finding about `updatePanel12`\n- second finding, with a nested detail\n  - nested: the effect depends on `items`\n- third finding',
  '```ts\nexport function updatePanel12(el: HTMLElement): void {\n\n  const wasOpen = el.classList.contains(\'is-open\')\n\n}\n```',
  '| Step | File | Status |\n| --- | --- | --- |\n| 1 | src/file-1.ts | ok |',
  'Paragraph 12b: a closing sentence.'
].join('\n\n')
const tricky = [
  '1. first\n\n2. second, loose\n\n   continued inside the item\n\n3. third',
  '* a\n\n* b\n\n- a different list',
  '> quoted\n>\n> still quoted\n\n> a lazy second quote',
  '~~~\ncode with a blank line\n\n```\nnot a closing fence\n~~~',
  '````md\n```\ninner fence\n```\n\ntext still inside\n````',
  '    indented code\n\n    more indented code',
  'Title\n=====\n\n---\n\n***\n\nText after rules',
  '- item\n\n      indented code in the item\n\nafter the list',
  'Unfinished fence at the end:\n\n```js\nconst streaming = true\n\nstill streaming'
]

describe('markdown blocks: a message renders the same one block at a time', () => {
  it('splits a long reply into its top-level blocks', () => {
    expect(markdownBlocks(reply).length).toBeGreaterThanOrEqual(5)
    expect(markdownBlocks('single paragraph')).toEqual(['single paragraph'])
    expect(markdownBlocks(reply).join('\n')).toBe(reply)
  })
  it('renders identically to the whole text, for every sample and every streamed prefix of it', () => {
    for (const sample of [reply, ...tricky, tricky.join('\n\n'), reply + '\n\n' + tricky.join('\n\n')]) {
      const lines = sample.split('\n')
      for (let count = 1; count <= lines.length; count++) {
        const prefix = lines.slice(0, count).join('\n')
        expect(joined(prefix), prefix).toBe(html(prefix))
      }
    }
  })
  it('keeps the earlier blocks unchanged while a reply grows, so only the last one is parsed again', () => {
    const grown = reply + '\n\nA new paragraph is streaming in'
    const before = markdownBlocks(reply), after = markdownBlocks(grown)
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1))
  })
  it('keeps text with reference or footnote definitions whole', () => {
    const text = 'See [the docs][docs] and a note[^1].\n\nMore text.\n\n[docs]: https://example.com\n[^1]: The note.'
    expect(markdownBlocks(text)).toEqual([text])
  })
})
