import { expect, it } from 'vitest'
import { isStructuredRendererUrl } from './structured-ipc-policy'

it('allows only the exact app document, retaining detached-window query parameters', () => {
  const trusted = 'file:///C:/Conductor/out/renderer/index.html'
  expect(isStructuredRendererUrl(trusted + '?detached=known#tab', trusted)).toBe(true)
  for (const candidate of ['https://example.com/', 'file:///C:/workspace/evil.html', 'javascript:alert(1)', 'invalid']) expect(isStructuredRendererUrl(candidate, trusted)).toBe(false)
})
it('does not turn a local dev preview or same-host different port into authority', () => {
  const trusted = 'http://localhost:5173/'
  expect(isStructuredRendererUrl(trusted + '?detached=known', trusted)).toBe(true)
  for (const candidate of ['http://localhost:5174/', 'http://localhost:5173/preview', 'https://localhost:5173/', 'http://user:pass@localhost:5173/']) expect(isStructuredRendererUrl(candidate, trusted)).toBe(false)
})
