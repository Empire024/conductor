import { afterEach, expect, it, vi } from 'vitest'
import { chatCompletion } from './client'

afterEach(() => vi.unstubAllGlobals())

const streamed = (text: string): Response => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 })

it('sends a JSON schema as a llama.cpp response_format grammar, and nothing when none is asked for', async () => {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return streamed('{"kind":"policy"}') }))
  const schema = { type: 'object', properties: { kind: { type: 'string', enum: ['policy', 'placeholder', 'other'] } }, required: ['kind'], additionalProperties: false }
  const base = { endpoint: 'http://127.0.0.1:9', apiKey: 'k', model: 'local/m', messages: [{ role: 'user' as const, content: 'classify' }] }
  expect((await chatCompletion({ ...base, jsonSchema: schema })).content).toBe('{"kind":"policy"}')
  expect(bodies[0]!.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } })
  await chatCompletion(base)
  expect(bodies[1]).not.toHaveProperty('response_format')
})
