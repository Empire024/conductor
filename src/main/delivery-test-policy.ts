import { isAbsolute } from 'node:path'

/** Changes where an import graph alone cannot establish the safety of a delivery. */
export function fullTestReason(paths: string[], publish: boolean): string | null {
  if (publish) return 'Publishing requires full verification.'
  if (!paths.length) return 'No changed-file set is available.'
  const core = paths.find(path =>
    ['package.json', 'package-lock.json', 'tsconfig.json'].includes(path)
    || /^(?:vitest|electron\.vite)\.config\.[cm]?[jt]s$/.test(path)
    || path.startsWith('src/shared/') || path.startsWith('src/preload/')
    || ['database', 'structured-store', 'structured-sessions', 'agent-control', 'agent-control-server', 'index', 'delivery', 'delivery-test-policy', 'local-update-build', 'update-manager'].some(name => path === `src/main/${name}.ts`)
    || ['scripts/delivery-related-tests.mjs', 'scripts/build-local-update.mjs'].includes(path))
  return core ? `Core change: ${core}.` : null
}

export function relatedTestFiles(stdout: string, changed: string[]): string[] {
  const line = stdout.split(/\r?\n/).find(value => value.startsWith('CONDUCTOR_RELATED_TESTS='))
  if (!line) throw new Error('The import graph did not return a test-file set.')
  const result: unknown = JSON.parse(line.slice('CONDUCTOR_RELATED_TESTS='.length))
  if (!Array.isArray(result) || result.some(file => typeof file !== 'string' || isAbsolute(file) || file.split('/').includes('..') || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))) throw new Error('The import graph returned an invalid test path.')
  const touched = changed.filter(file => file.startsWith('src/') && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
  const files = [...new Set([...result, ...touched])].sort()
  // An empty set is safe only for changes outside application code (docs, assets, scripts).
  if (!files.length && changed.some(file => file.startsWith('src/') && /\.[cm]?[jt]sx?$/.test(file))) throw new Error('No tests cover the changed application code.')
  return files
}
