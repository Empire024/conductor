#!/usr/bin/env node
import { createHash } from 'node:crypto'

const maxBytes = 256 * 1024
const sources = [
  ['openai-models', 'https://developers.openai.com/api/docs/models/all.md', 'text/markdown, text/plain;q=0.9'],
  ['anthropic-models', 'https://platform.claude.com/docs/en/models/overview.md', 'text/markdown, text/plain;q=0.9'],
  ['llama-cpp-release', 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', 'application/vnd.github+json'],
  ['qwen-3.5-9b-metadata', 'https://huggingface.co/api/models/Qwen/Qwen3.5-9B?expand[]=sha&expand[]=lastModified&expand[]=tags', 'application/json']
]

const sha256 = value => createHash('sha256').update(value).digest('hex')
const normalize = value => value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<!--([\s\S]*?)-->/g, ' ').replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const boundedText = async response => {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new Error('response exceeded 256 KB')
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) { await reader.cancel(); throw new Error('response exceeded 256 KB') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(bytes)
}

const fetchedAt = new Date().toISOString(), evidence = []
for (const [id, url, accept] of sources) {
  try {
    const response = await fetch(url, { headers: { accept }, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10_000) })
    if (response.status >= 300 && response.status < 400) throw new Error(`redirect ${response.status}`)
    if (new URL(response.url || url).origin !== new URL(url).origin) throw new Error('origin changed')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const normalized = normalize(await boundedText(response))
    if (normalized.length < 40) throw new Error('insufficient readable content')
    evidence.push({ id, ok: true, digest: sha256(normalized), bytes: normalized.length, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') })
  } catch (error) { evidence.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) }) }
}
const result = { schemaVersion: 1, fetchedAt, validUntil: new Date(Date.parse(fetchedAt) + 86_400_000).toISOString(), zeroModelTokens: true, evidence }
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
if (!evidence.some(item => item.ok)) process.exitCode = 1
