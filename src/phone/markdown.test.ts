import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/* markdown.js is served verbatim to the phone, so it is run here as it is, in a bare context. */
const source = readFileSync(new URL('./markdown.js', import.meta.url), 'utf8')
const window: Record<string, any> = {}
runInNewContext(source, { window })
const { parse, parseInline, render, safeUrl } = window.ConductorMarkdown

/* Just enough DOM to see what render() builds, and to prove it never touches innerHTML. */
class Node {
  children: Node[] = []
  attributes: Record<string, string> = {}
  className = ''
  text = ''
  constructor(public tag: string) {}
  appendChild(child: Node) { this.children.push(child); return child }
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('') }
  set innerHTML(_value: string) { throw new Error('innerHTML must never be used') }
  all(): Node[] { return this.children.flatMap(child => [child, ...child.all()]) }
  html(): string {
    if (this.tag === '#text') return this.text
    if (this.tag === 'br' || this.tag === 'hr') return `<${this.tag}>`
    const attrs = (this.className ? ` class="${this.className}"` : "") + Object.entries(this.attributes).map(([name, value]) => ` ${name}="${value}"`).join('')
    return `<${this.tag}${attrs}>${this.text}${this.children.map(child => child.html()).join('')}</${this.tag}>`
  }
}
const doc = {
  createElement: (tag: string) => new Node(tag),
  createTextNode: (text: string) => { const node = new Node('#text'); node.text = text; return node }
}
const draw = (text: string) => render(new Node('div'), text, doc) as Node

describe('markdown.js blocks', () => {
  it('turns headings, paragraphs and rules into their blocks, keeping single newlines as breaks', () => {
    const html = draw('# Title\n\nfirst line\nsecond line\n\n---\n\n### Small').html()
    expect(html).toBe('<div><p class="md-heading md-h1">Title</p><p class="text-block md-p">first line<br>second line</p><hr><p class="md-heading md-h3">Small</p></div>')
  })

  it('keeps fenced code verbatim, including markdown and HTML inside it, and runs an unclosed fence to the end', () => {
    const blocks = parse('```ts\nconst a = **b** <i>\n```\nafter\n~~~\nstill streaming')
    expect(blocks).toEqual([
      { type: 'code', lang: 'ts', text: 'const a = **b** <i>' },
      { type: 'paragraph', children: [{ type: 'text', text: 'after' }] },
      { type: 'code', lang: '', text: 'still streaming' }
    ])
  })

  it('builds bullet, ordered, nested and task lists', () => {
    const root = draw('- one\n- two\n  - nested\n- [x] done\n- [ ] open\n\n3. three\n4. four')
    const lists = root.children
    expect(lists.map(node => node.tag)).toEqual(['ul', 'ol'])
    expect(lists[0]!.children.map(item => item.textContent)).toEqual(['one', 'twonested', '☑done', '☐open'])
    expect(lists[0]!.children[1]!.all().some(node => node.tag === 'ul')).toBe(true)
    expect(lists[1]!.attributes.start).toBe('3')
    expect(lists[1]!.children.length).toBe(2)
  })

  it('keeps a loose list together and a lazy continuation line in its item', () => {
    const blocks = parse('1. first\n\n2. second\ncontinued')
    expect(blocks.length).toBe(1)
    expect(blocks[0].items.length).toBe(2)
    expect(blocks[0].items[1].children[0].children.map((node: any) => node.text ?? '\n')).toEqual(['second', '\n', 'continued'])
  })

  it('renders quotes and pipe tables with alignment, inside a scroll box', () => {
    const root = draw('> quoted **bit**\n\n| Name | Count |\n| :--- | ---: |\n| a \\| b | 2 |')
    expect(root.children[0]!.tag).toBe('blockquote')
    expect(root.children[0]!.textContent).toBe('quoted bit')
    const wrap = root.children[1]!
    expect(wrap.className).toBe('md-table-wrap')
    const cells = wrap.all().filter(node => node.tag === 'th' || node.tag === 'td')
    expect(cells.map(cell => cell.textContent)).toEqual(['Name', 'Count', 'a | b', '2'])
    expect(cells[1]!.attributes.style).toBe('text-align:right')
  })

  it('does not mistake a sentence with a pipe for a table', () => {
    expect(parse('use a | b here\nand more').map((block: any) => block.type)).toEqual(['paragraph'])
  })
})

describe('markdown.js inline', () => {
  it('parses code, strong, em, strike and escapes', () => {
    const html = draw('`a*b*` **bold _it_** *em* ~~gone~~ \\*literal\\* snake_case_name 2 * 3 * 4').html()
    expect(html).toBe('<div><p class="text-block md-p"><code class="md-code">a*b*</code> <strong>bold <em>it</em></strong> <em>em</em> <s>gone</s> *literal* snake_case_name 2 * 3 * 4</p></div>')
  })

  it('links only http, https and mailto; anything else keeps its label as text', () => {
    const root = draw('[ok](https://a.test/x_(y)) [mail](mailto:me@a.test) [js](javascript:alert(1)) [data](data:text/html,x) [rel](src/file.ts)')
    const links = root.all().filter(node => node.tag === 'a')
    expect(links.map(link => link.attributes.href)).toEqual(['https://a.test/x_(y)', 'mailto:me@a.test'])
    expect(links[0]!.attributes.rel).toBe('noopener noreferrer')
    expect(links[0]!.attributes.target).toBe('_blank')
    expect(root.textContent).toBe('ok mail js data rel')
  })

  it('autolinks bare and angle-bracket URLs without the sentence punctuation', () => {
    const nodes = parseInline('See https://a.test/path, or (https://b.test/q?x=1). <https://c.test>')
    const links = nodes.filter((node: any) => node.type === 'link').map((node: any) => node.href)
    expect(links).toEqual(['https://a.test/path', 'https://b.test/q?x=1', 'https://c.test'])
  })

  it('refuses scheme tricks in safeUrl', () => {
    expect(safeUrl('https://ok.test')).toBe('https://ok.test')
    expect(safeUrl('java\nscript:alert(1)')).toBeNull()
    expect(safeUrl(' javascript:alert(1)')).toBeNull()
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBeNull()
    expect(safeUrl('vbscript:x')).toBeNull()
    expect(safeUrl('//evil.test')).toBeNull()
  })

  it('leaves raw HTML as visible text and never assigns innerHTML', () => {
    const root = draw('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> **after**')
    expect(root.all().some(node => node.tag === 'script' || node.tag === 'img')).toBe(false)
    expect(root.textContent).toBe('<script>alert(1)</script><img src=x onerror=alert(1)> after')
  })

  it('handles empty, null and CRLF input', () => {
    expect(draw('').children).toEqual([])
    expect(draw(null as unknown as string).children).toEqual([])
    expect(draw('a\r\nb').html()).toBe('<div><p class="text-block md-p">a<br>b</p></div>')
  })
})
