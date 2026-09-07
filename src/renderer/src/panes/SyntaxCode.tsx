import { memo, useEffect, useState } from 'react'
import { loader } from '@monaco-editor/react'
import './SyntaxCode.css'

/** Tokenization uses the editor already shipped with Conductor, never a service. */
export const MAX_HIGHLIGHT_CHARS = 16_000
const MAX_TOKEN_SPANS = 2_000
export interface CodeToken { offset: number; type: string }
export interface CodeSegment { text: string; className?: string }
const aliases: Record<string, string> = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', pwsh: 'powershell', ps: 'powershell', yml: 'yaml', md: 'markdown', rb: 'ruby', rs: 'rust', cs: 'csharp', 'c#': 'csharp', 'c++': 'cpp' }

export function codeLanguage(language?: string): string {
  const normalized = (language ?? 'plaintext').toLowerCase().replace(/^language-/, '').split(/\s/)[0]!
  return /^[a-z][a-z\d+#-]*$/.test(normalized) ? aliases[normalized] ?? normalized : 'plaintext'
}
export function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return ({ txt: 'plaintext', h: 'cpp', hpp: 'cpp', c: 'c', vue: 'html', svelte: 'html', toml: 'ini' } as Record<string, string>)[extension] ?? codeLanguage(extension)
}
export function tokenClass(type: string): string | undefined {
  const parts = type.toLowerCase().split('.')
  if (parts.includes('comment')) return 'sa-syntax-comment'
  if (parts.includes('string') || parts.includes('regexp')) return 'sa-syntax-string'
  if (parts.includes('number') || parts.includes('float')) return 'sa-syntax-number'
  if (parts.includes('keyword')) return 'sa-syntax-keyword'
  if (parts.includes('type') || parts.includes('class') || parts.includes('tag')) return 'sa-syntax-type'
  if (parts.includes('function') || parts.includes('predefined')) return 'sa-syntax-function'
  if (parts.includes('attribute') || parts.includes('variable')) return 'sa-syntax-variable'
  if (parts.includes('delimiter') || parts.includes('operator')) return 'sa-syntax-punctuation'
  return undefined
}

/** Monaco offsets are local to a line. Preserve original CRLF/Unicode byte text. */
export function codeSegments(value: string, tokenLines: CodeToken[][]): CodeSegment[] {
  const segments: CodeSegment[] = []
  let cursor = 0
  let lineIndex = 0
  const append = (text: string, className?: string): void => {
    if (!text) return
    const previous = segments.at(-1)
    if (previous && previous.className === className) previous.text += text
    else segments.push({ text, className })
  }
  while (cursor < value.length && segments.length < MAX_TOKEN_SPANS) {
    const match = /\r\n|\r|\n/g
    match.lastIndex = cursor
    const newline = match.exec(value)
    const end = newline?.index ?? value.length
    const line = value.slice(cursor, end)
    const tokens = tokenLines[lineIndex++] ?? []
    let consumed = 0
    for (let index = 0; index < tokens.length && segments.length < MAX_TOKEN_SPANS; index++) {
      const token = tokens[index]!
      const start = Math.min(line.length, Math.max(consumed, token.offset))
      const stop = Math.min(line.length, Math.max(start, tokens[index + 1]?.offset ?? line.length))
      append(line.slice(consumed, start))
      append(line.slice(start, stop), tokenClass(token.type))
      consumed = stop
    }
    append(line.slice(consumed))
    append(newline?.[0] ?? '')
    cursor = end + (newline?.[0].length ?? 0)
  }
  append(value.slice(cursor))
  return segments
}

const readyLanguages = new Map<string, Promise<string>>()
async function tokenize(value: string, language: string): Promise<CodeSegment[]> {
  const monaco = await loader.init()
  const supported = monaco.languages.getLanguages().some((entry) => entry.id === language) ? language : 'plaintext'
  let ready = readyLanguages.get(supported)
  if (!ready) {
    ready = (async () => {
      // The public colorize API activates lazy language grammars. Its generated HTML
      // is deliberately ignored: only React-escaped text from tokenize is rendered.
      await monaco.editor.colorize('', supported, {})
      return supported
    })()
    readyLanguages.set(supported, ready)
  }
  const resolved = await ready
  const preview = value.slice(0, MAX_HIGHLIGHT_CHARS)
  const segments = codeSegments(preview, monaco.editor.tokenize(preview, resolved))
  if (value.length > preview.length) segments.push({ text: value.slice(preview.length) })
  return segments
}

export const SyntaxCode = memo(function SyntaxCode({ value, language, className = '' }: { value: string; language?: string; className?: string }): React.JSX.Element {
  const normalized = codeLanguage(language)
  const [highlighted, setHighlighted] = useState<{ value: string; language: string; segments: CodeSegment[] } | null>(null)
  useEffect(() => {
    if (normalized === 'plaintext') return
    let active = true
    // Coalesce token bursts without delaying the visible plain-text stream.
    const timer = setTimeout(() => {
      void tokenize(value, normalized).then((segments) => { if (active) setHighlighted({ value, language: normalized, segments }) }).catch(() => { /* Plain text remains usable if a grammar is unavailable. */ })
    }, 60)
    return () => { active = false; clearTimeout(timer) }
  }, [value, normalized])
  const segments = highlighted?.value === value && highlighted.language === normalized ? highlighted.segments : null
  return <code className={'sa-syntax-code ' + className} data-language={normalized}>{segments ? segments.map((segment, index) => segment.className ? <span key={index} className={segment.className}>{segment.text}</span> : segment.text) : value}</code>
})
