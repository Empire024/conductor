// Vitest's public graph API selects specifications without collecting/executing tests.
// CLI `list --related` is not supported by the installed Vitest 3.
import { createVitest } from 'vitest/node'
import { relative, resolve } from 'node:path'

const paths = process.argv.slice(2)
if (!paths.length) throw new Error('Changed paths are required')
const ctx = await createVitest('test', { watch: false, related: paths.map(path => resolve(path)) })
try {
  const specs = await ctx.getRelevantTestSpecifications()
  const files = [...new Set(specs.map(spec => relative(process.cwd(), spec.moduleId).replaceAll('\\', '/')))].sort()
  console.log('CONDUCTOR_RELATED_TESTS=' + JSON.stringify(files))
} finally { await ctx.close() }
