import { describe, expect, it } from 'vitest'
import { JsonLineDecoder, JsonLineTransport } from './transport'
import type { Json } from '../../shared/structured-agent'

describe('provider JSON transport — zero inference', () => {
  it('accepts fragmented frames, CRLF, and final frame without newline', () => {
    const messages: Json[] = [], errors: Error[] = []
    const decoder = new JsonLineDecoder((message) => messages.push(message), (error) => errors.push(error))
    const bytes = Buffer.from('{"text":"😀日本語"}\r\n\n{"second":true}')
    for (let i = 0; i < bytes.length; i++) decoder.push(bytes.subarray(i, i + 1))
    decoder.end()
    expect(messages).toEqual([{ text: '😀日本語' }, { second: true }])
    expect(errors).toEqual([])
  })
  it('fails malformed and oversized frames without exposing their content or processing later messages', () => {
    for (const source of ['{"token":"private",BROKEN}\n', JSON.stringify({ output: 'X'.repeat(200) }) + '\n']) {
      const messages: Json[] = [], errors: Error[] = []
      const decoder = new JsonLineDecoder((message) => messages.push(message), (error) => errors.push(error), 100)
      decoder.push(source); decoder.push('{"later":true}\n'); decoder.end()
      expect(messages).toEqual([])
      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).not.toContain('private')
      expect(errors[0]?.message).not.toContain('XXXX')
    }
  })
  it('rejects shell batch launchers instead of reinterpreting arguments through cmd', () => {
    const transport = new JsonLineTransport({ executable: 'C:/path with spaces/provider.cmd', args: ['untrusted & text'], cwd: process.cwd(), onMessage: () => undefined })
    expect(() => transport.start()).toThrow('native executable')
    expect(() => transport.send({ type: 'user' })).toThrow('disconnected')
  })
  it('keeps actual child stderr outside protocol stdout', async () => {
    const messages: Json[] = [], errors: Error[] = [], stderr: string[] = []
    await new Promise<void>((resolve, reject) => {
      const transport = new JsonLineTransport({ executable: process.execPath, args: ['-e', 'process.stderr.write("SYNTHETIC stderr"); process.stdout.write(JSON.stringify({ok:true})+"\\n")'], cwd: process.cwd(), onMessage: (message) => messages.push(message), onStderr: (text) => stderr.push(text), onError: (error) => { errors.push(error); reject(error) }, onExit: (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)) })
      transport.start()
    })
    expect(messages).toEqual([{ ok: true }])
    expect(stderr.join('')).toBe('SYNTHETIC stderr')
    expect(errors).toEqual([])
  })
})
