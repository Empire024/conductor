/* Markdown for the phone, the subset agents actually write.
 *
 * Served verbatim like app.js (no build step, no imports), so the desktop's react-markdown cannot
 * be reused here. Agent output is untrusted: parse() only produces a plain tree, and render()
 * builds it with createElement and createTextNode. Nothing reaches innerHTML, raw HTML in the
 * source stays visible text, and a link only gets an href when it is http(s) or mailto.
 *
 * Blocks: paragraphs (single newlines kept as line breaks), # headings, ``` and ~~~ fences (an
 * unclosed fence runs to the end, which is what a streaming reply looks like), > quotes, - * + and
 * 1. lists with nesting and [ ] / [x] tasks, --- rules and pipe tables.
 * Inline: `code`, **strong**, *em*, _em_, ~~strike~~, [label](url), <url> and bare http(s) URLs.
 */
(function (root) {
  'use strict'

  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/
  const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/
  const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
  const QUOTE = /^ {0,3}> ?(.*)$/
  const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/
  const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
  const BLANK = /^\s*$/

  const indentOf = line => {
    let width = 0
    for (const char of line) {
      if (char === ' ') width += 1
      else if (char === '\t') width += 4 - (width % 4)
      else break
    }
    return width
  }

  /* Removes up to `count` columns of leading indentation. */
  const dedent = (line, count) => {
    let width = 0
    let index = 0
    while (index < line.length && width < count) {
      const char = line[index]
      if (char === ' ') width += 1
      else if (char === '\t') width += 4 - (width % 4)
      else break
      index += 1
    }
    return line.slice(index)
  }

  const splitRow = line => {
    let text = line.trim()
    if (text.startsWith('|')) text = text.slice(1)
    if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
    const cells = []
    let cell = ''
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (char === '\\' && text[index + 1] === '|') { cell += '|'; index += 1; continue }
      if (char === '|') { cells.push(cell.trim()); cell = ''; continue }
      cell += char
    }
    cells.push(cell.trim())
    return cells
  }

  const startsBlock = (line, next) =>
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-'))

  // ------------------------------------------------------------------ blocks

  const parseBlocks = lines => {
    const blocks = []
    let index = 0
    while (index < lines.length) {
      const line = lines[index]
      if (BLANK.test(line)) { index += 1; continue }

      const fence = FENCE.exec(line)
      if (fence) {
        const marker = fence[1]
        const body = []
        index += 1
        while (index < lines.length) {
          const close = lines[index].trim()
          if (close.startsWith(marker[0].repeat(marker.length)) && /^(`+|~+)$/.test(close)) { index += 1; break }
          body.push(lines[index])
          index += 1
        }
        blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') })
        continue
      }

      const heading = HEADING.exec(line)
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2] || '') })
        index += 1
        continue
      }

      if (RULE.test(line)) { blocks.push({ type: 'rule' }); index += 1; continue }

      if (QUOTE.test(line)) {
        const inner = []
        while (index < lines.length && !BLANK.test(lines[index])) {
          const quoted = QUOTE.exec(lines[index])
          inner.push(quoted ? quoted[1] : lines[index])
          index += 1
        }
        blocks.push({ type: 'quote', children: parseBlocks(inner) })
        continue
      }

      const item = ITEM.exec(line)
      if (item) {
        const ordered = /\d/.test(item[2])
        const list = { type: 'list', ordered: ordered, start: ordered ? parseInt(item[2], 10) : 1, items: [] }
        while (index < lines.length) {
          const current = ITEM.exec(lines[index])
          if (!current || /\d/.test(current[2]) !== ordered) break
          const contentIndent = current[1].length + current[2].length + Math.max(1, Math.min(current[3].length, 4))
          const body = [current[4]]
          index += 1
          while (index < lines.length) {
            const next = lines[index]
            if (BLANK.test(next)) {
              /* A blank line ends the item unless the next text is indented into it. */
              const after = lines[index + 1]
              if (after !== undefined && !BLANK.test(after) && indentOf(after) >= contentIndent) { body.push(''); index += 1; continue }
              break
            }
            if (indentOf(next) >= contentIndent) { body.push(dedent(next, contentIndent)); index += 1; continue }
            /* A lazy continuation line belongs to the item; a new marker or block does not. */
            if (!startsBlock(next, lines[index + 1])) { body.push(next.trim()); index += 1; continue }
            break
          }
          let checked = null
          const task = /^\[([ xX])\]\s+/.exec(body[0])
          if (task) { checked = task[1] !== ' '; body[0] = body[0].slice(task[0].length) }
          list.items.push({ checked: checked, children: parseBlocks(body) })
          while (index < lines.length && BLANK.test(lines[index]) && lines[index + 1] !== undefined) {
            const following = ITEM.exec(lines[index + 1])
            if (!following || /\d/.test(following[2]) !== ordered) break
            index += 1
          }
        }
        blocks.push(list)
        continue
      }

      const next = lines[index + 1]
      if (line.includes('|') && next !== undefined && next.includes('-') && TABLE_RULE.test(next)) {
        const head = splitRow(line)
        const align = splitRow(next).map(cell => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : ''))
        const rows = []
        index += 2
        while (index < lines.length && !BLANK.test(lines[index]) && lines[index].includes('|')) {
          rows.push(splitRow(lines[index]).map(parseInline))
          index += 1
        }
        blocks.push({ type: 'table', align: align, head: head.map(parseInline), rows: rows })
        continue
      }

      const paragraph = [line]
      index += 1
      while (index < lines.length && !BLANK.test(lines[index]) && !startsBlock(lines[index], lines[index + 1])) {
        paragraph.push(lines[index])
        index += 1
      }
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.map(entry => entry.replace(/^\s+/, '')).join('\n').replace(/\s+$/, '')) })
    }
    return blocks
  }

  // ------------------------------------------------------------------ inline

  const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/
  const BARE_URL = /^(?:https?:\/\/)[^\s<>"']+/i

  const safeUrl = raw => {
    const url = String(raw || '').trim()
    /* Control characters and whitespace inside a scheme are how javascript: hides; refuse them. */
    if (!url || /[\u0000-\u001f\u007f\s]/.test(url)) return null
    return /^(https?:\/\/|mailto:)/i.test(url) ? url : null
  }

  /* Trailing punctuation reads as the sentence's, not the URL's; a closing paren only when unpaired. */
  const trimUrl = url => {
    let end = url.length
    for (;;) {
      const char = url[end - 1]
      if (/[.,:;!?'"*_~]/.test(char)) { end -= 1; continue }
      if (char === ')') {
        const part = url.slice(0, end)
        if ((part.match(/\(/g) || []).length < (part.match(/\)/g) || []).length) { end -= 1; continue }
      }
      break
    }
    return url.slice(0, end)
  }

  const findClose = (text, from, marker) => {
    let index = from
    while (index < text.length) {
      const found = text.indexOf(marker, index)
      if (found < 0) return -1
      if (text[found - 1] === '\\') { index = found + 1; continue }
      /* A closer hugs its text: "a * b" is not emphasis. */
      if (found > from && !/\s/.test(text[found - 1])) {
        if (marker.length === 1 && text[found + 1] === marker) { index = found + 2; continue }
        return found
      }
      index = found + marker.length
    }
    return -1
  }

  const findBracket = (text, from) => {
    let depth = 0
    for (let index = from; index < text.length; index++) {
      const char = text[index]
      if (char === '\\') { index += 1; continue }
      if (char === '`') { const end = text.indexOf('`', index + 1); if (end > 0) { index = end; continue } }
      if (char === '[') depth += 1
      else if (char === ']') { if (depth === 0) return index; depth -= 1 }
    }
    return -1
  }

  const parseInline = text => {
    const nodes = []
    let buffer = ''
    const flush = () => { if (buffer) { nodes.push({ type: 'text', text: buffer }); buffer = '' } }
    const push = node => { flush(); nodes.push(node) }
    let index = 0
    while (index < text.length) {
      const char = text[index]
      const rest = text.slice(index)

      if (char === '\\' && index + 1 < text.length && PUNCTUATION.test(text[index + 1])) { buffer += text[index + 1]; index += 2; continue }
      if (char === '\n') { push({ type: 'break' }); index += 1; continue }

      if (char === '`') {
        const ticks = /^`+/.exec(rest)[0]
        const end = text.indexOf(ticks, index + ticks.length)
        if (end > 0) {
          let code = text.slice(index + ticks.length, end).replace(/\n/g, ' ')
          if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1)
          push({ type: 'code', text: code })
          index = end + ticks.length
          continue
        }
        buffer += ticks
        index += ticks.length
        continue
      }

      const strong = rest.startsWith('**') ? '**' : rest.startsWith('__') ? '__' : ''
      if (strong && text[index + 2] && !/\s/.test(text[index + 2]) && (strong === '**' || !/\w/.test(text[index - 1] || ''))) {
        const end = findClose(text, index + 2, strong)
        if (end > 0) { push({ type: 'strong', children: parseInline(text.slice(index + 2, end)) }); index = end + 2; continue }
      }
      if (rest.startsWith('~~') && text[index + 2] && !/\s/.test(text[index + 2])) {
        const end = findClose(text, index + 2, '~~')
        if (end > 0) { push({ type: 'strike', children: parseInline(text.slice(index + 2, end)) }); index = end + 2; continue }
      }
      if ((char === '*' || char === '_') && text[index + 1] && !/\s/.test(text[index + 1]) && text[index + 1] !== char && (char === '*' || !/\w/.test(text[index - 1] || ''))) {
        const end = findClose(text, index + 1, char)
        if (end > 0 && (char === '*' || !/\w/.test(text[end + 1] || ''))) {
          push({ type: 'em', children: parseInline(text.slice(index + 1, end)) })
          index = end + 1
          continue
        }
      }

      if (char === '[') {
        const close = findBracket(text, index + 1)
        if (close > 0 && text[close + 1] === '(') {
          const target = /^\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/.exec(text.slice(close + 1))
          if (target) {
            const label = parseInline(text.slice(index + 1, close))
            const href = safeUrl(target[1])
            if (href) push({ type: 'link', href: href, children: label })
            else { flush(); for (const node of label) nodes.push(node) }
            index = close + 1 + target[0].length
            continue
          }
        }
      }

      if (char === '<') {
        const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest)
        if (auto) { push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1].replace(/^mailto:/i, '') }] }); index += auto[0].length; continue }
      }

      if ((char === 'h' || char === 'H') && !/\w/.test(text[index - 1] || '')) {
        const bare = BARE_URL.exec(rest)
        if (bare) {
          const url = trimUrl(bare[0])
          if (/^https?:\/\/[^/]/i.test(url)) {
            push({ type: 'link', href: url, children: [{ type: 'text', text: url }] })
            index += url.length
            continue
          }
        }
      }

      buffer += char
      index += 1
    }
    flush()
    return nodes
  }

  const parse = source => parseBlocks(String(source === null || source === undefined ? '' : source).replace(/\r\n?/g, '\n').split('\n'))

  // ------------------------------------------------------------------ DOM

  const render = (host, source, doc) => {
    const document = doc || host.ownerDocument || root.document
    const make = (tag, className) => {
      const node = document.createElement(tag)
      if (className) node.className = className
      return node
    }
    const text = value => document.createTextNode(value)

    const inline = (parent, nodes) => {
      for (const node of nodes) {
        if (node.type === 'text') parent.appendChild(text(node.text))
        else if (node.type === 'break') parent.appendChild(make('br'))
        else if (node.type === 'code') { const code = make('code', 'md-code'); code.textContent = node.text; parent.appendChild(code) }
        else if (node.type === 'link') {
          const link = make('a', 'md-link')
          link.setAttribute('href', node.href)
          link.setAttribute('target', '_blank')
          link.setAttribute('rel', 'noopener noreferrer')
          inline(link, node.children)
          parent.appendChild(link)
        } else {
          const tag = node.type === 'strong' ? 'strong' : node.type === 'em' ? 'em' : 's'
          const wrap = make(tag)
          inline(wrap, node.children)
          parent.appendChild(wrap)
        }
      }
    }

    const blocks = (parent, list) => {
      for (const block of list) {
        if (block.type === 'paragraph') { const p = make('p', 'text-block md-p'); inline(p, block.children); parent.appendChild(p) }
        else if (block.type === 'heading') { const h = make('p', 'md-heading md-h' + block.level); inline(h, block.children); parent.appendChild(h) }
        else if (block.type === 'code') {
          const pre = make('pre', 'code-block')
          const code = make('code')
          code.textContent = block.text
          pre.appendChild(code)
          parent.appendChild(pre)
        } else if (block.type === 'rule') parent.appendChild(make('hr', 'md-rule'))
        else if (block.type === 'quote') { const quote = make('blockquote', 'md-quote'); blocks(quote, block.children); parent.appendChild(quote) }
        else if (block.type === 'list') {
          const list = make(block.ordered ? 'ol' : 'ul', 'md-list')
          if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start))
          for (const item of block.items) {
            const li = make('li', item.checked === null ? 'md-item' : 'md-item md-task')
            if (item.checked !== null) {
              const box = make('span', 'md-check' + (item.checked ? ' done' : ''))
              box.textContent = item.checked ? '☑' : '☐'
              box.setAttribute('aria-label', item.checked ? 'done' : 'not done')
              li.appendChild(box)
            }
            blocks(li, item.children)
            list.appendChild(li)
          }
          parent.appendChild(list)
        } else if (block.type === 'table') {
          /* Wide tables scroll inside their own box instead of widening the bubble. */
          const scroller = make('div', 'md-table-wrap')
          const table = make('table', 'md-table')
          const row = (cells, tag) => {
            const tr = make('tr')
            cells.forEach((cell, column) => {
              const td = make(tag)
              if (block.align[column]) td.setAttribute('style', 'text-align:' + block.align[column])
              inline(td, cell)
              tr.appendChild(td)
            })
            return tr
          }
          const head = make('thead')
          head.appendChild(row(block.head, 'th'))
          table.appendChild(head)
          const body = make('tbody')
          for (const cells of block.rows) body.appendChild(row(cells, 'td'))
          table.appendChild(body)
          scroller.appendChild(table)
          parent.appendChild(scroller)
        }
      }
    }

    blocks(host, parse(source))
    return host
  }

  root.ConductorMarkdown = { parse: parse, parseInline: parseInline, render: render, safeUrl: safeUrl }
})(typeof window !== 'undefined' ? window : globalThis)
