import { describe, expect, it } from 'vitest'
import { fullTestReason, relatedTestFiles } from './delivery-test-policy'
describe('delivery test policy', () => {
  it('forces full verification for core, configuration and publication', () => {
    for (const path of ['src/shared/ipc.ts', 'src/main/index.ts', 'src/main/delivery.ts', 'src/main/agent-control.ts', 'src/main/structured-sessions.ts', 'src/preload/index.ts', 'package.json', 'vitest.config.ts']) expect(fullTestReason([path], false)).toBeTruthy()
    expect(fullTestReason(['src/renderer/src/components/Sidebar.tsx'], false)).toBeNull()
    expect(fullTestReason(['docs/example.md'], true)).toBeTruthy()
  })
  it('unions touched tests with the import graph and removes duplicates', () => {
    expect(relatedTestFiles('noise\nCONDUCTOR_RELATED_TESTS=["src/a.test.ts"]', ['src/a.test.ts', 'src/b.test.ts'])).toEqual(['src/a.test.ts', 'src/b.test.ts'])
  })
  it('fails closed for graph failures, invalid paths and uncovered code', () => {
    for (const output of ['', 'CONDUCTOR_RELATED_TESTS=nope', 'CONDUCTOR_RELATED_TESTS=["../outside.test.ts"]', 'CONDUCTOR_RELATED_TESTS=[]']) expect(() => relatedTestFiles(output, ['src/a.ts'])).toThrow()
    expect(relatedTestFiles('CONDUCTOR_RELATED_TESTS=[]', ['docs/example.md'])).toEqual([])
  })
})
