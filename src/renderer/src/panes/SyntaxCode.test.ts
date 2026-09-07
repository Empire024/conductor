import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { codeLanguage, codeSegments, languageForPath, MAX_HIGHLIGHT_CHARS, SyntaxCode, tokenClass } from './SyntaxCode'

describe('local syntax highlighting (synthetic, zero inference)', () => {
  it('maps fence aliases and Windows filenames to installed editor languages', () => {
    for (const alias of ['js', 'mjs', 'jsx', 'language-js']) expect(codeLanguage(alias)).toBe('javascript')
    expect(codeLanguage('pwsh')).toBe('powershell')
    expect(codeLanguage('bash')).toBe('shell')
    expect(languageForPath('C:\\work\\résumé component.tsx')).toBe('typescript')
    expect(codeLanguage('<script>')).toBe('plaintext')
  })
  it('maps semantic tokens to readable theme colors without accepting CSS from content', () => {
    expect(tokenClass('keyword.js')).toBe('sa-syntax-keyword')
    expect(tokenClass('string.escape.js')).toBe('sa-syntax-string')
    expect(tokenClass('comment.doc')).toBe('sa-syntax-comment')
    expect(tokenClass('number.float')).toBe('sa-syntax-number')
    expect(tokenClass('identifier.js')).toBeUndefined()
    expect(tokenClass('color:red;background:url(https://bad)')).toBeUndefined()
  })
  it('preserves all text, Unicode, CRLF, tabs and the missing final newline', () => {
    const value = 'const résumé = "雪";\r\n\treturn résumé;\n// final'
    const segments = codeSegments(value, [
      [{ offset: 0, type: 'keyword.js' }, { offset: 5, type: '' }, { offset: 15, type: 'string.js' }, { offset: 18, type: 'delimiter.js' }],
      [{ offset: 0, type: '' }, { offset: 1, type: 'keyword.js' }, { offset: 7, type: '' }],
      [{ offset: 0, type: 'comment.js' }]
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe(value)
    expect(segments.filter((segment) => segment.className === 'sa-syntax-keyword').map((segment) => segment.text)).toEqual(['const', 'return'])
    expect(codeSegments(value, []).map((segment) => segment.text).join('')).toBe(value)
  })
  it('bounds token span count and keeps the rest selectable as plain text', () => {
    const value = 'ab'.repeat(20_000)
    const tokens = Array.from({ length: value.length }, (_, offset) => ({ offset, type: offset % 2 ? 'string.js' : 'keyword.js' }))
    const segments = codeSegments(value, [tokens])
    expect(segments.length).toBeLessThanOrEqual(2002)
    expect(segments.map((segment) => segment.text).join('')).toBe(value)
    expect(MAX_HIGHLIGHT_CHARS).toBeLessThanOrEqual(16_000)
  })
  it('renders initial text immediately and escapes HTML before tokenization', () => {
    const value = '<img src=x onerror="alert(1)">\n<script>alert(2)</script>'
    const html = renderToStaticMarkup(createElement(SyntaxCode, { value, language: 'html' }))
    expect(html).toContain('data-language="html"')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
  })
})
