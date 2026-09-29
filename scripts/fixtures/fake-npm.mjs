// A stand-in for `npm install --prefix <dir> <package>@<version>` in the auto model upgrade tests
// (docs/model-upgrades.md): it lays out the package with a launcher for scripts/fixtures/
// fake-upgrade-cli.mjs where the real packages keep their native executable, and records the call
// in CONDUCTOR_FAKE_NPM_LOG. No network; nothing outside --prefix is written.
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
if (process.env.CONDUCTOR_FAKE_NPM_LOG) appendFileSync(process.env.CONDUCTOR_FAKE_NPM_LOG, `${JSON.stringify(argv)}\n`)
if (argv[0] !== 'install') { console.error(`fake npm: unsupported ${argv[0]}`); process.exit(2) }
const prefix = argv[argv.indexOf('--prefix') + 1]
const spec = argv.filter(arg => !arg.startsWith('-') && arg !== 'install' && arg !== prefix).pop() ?? ''
const at = spec.lastIndexOf('@')
const pkg = spec.slice(0, at), version = spec.slice(at + 1)
const provider = pkg === '@openai/codex' ? 'codex' : pkg === '@anthropic-ai/claude-code' ? 'claude' : null
if (!prefix || !provider || !version) { console.error(`fake npm: cannot install ${spec}`); process.exit(1) }
if (process.env.CONDUCTOR_FAKE_NPM_FAIL === '1') { console.error('fake npm: E404 simulated failure'); process.exit(1) }
const cli = resolve(dirname(fileURLToPath(import.meta.url)), 'fake-upgrade-cli.mjs')
const vendor = join(prefix, 'node_modules', ...pkg.split('/'), 'vendor')
mkdirSync(vendor, { recursive: true })
writeFileSync(join(prefix, 'node_modules', ...pkg.split('/'), 'package.json'), JSON.stringify({ name: pkg, version }))
if (process.platform === 'win32') {
  writeFileSync(join(vendor, `${provider}.cmd`), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cli}" --fake-provider ${provider} --fake-version ${version} %*\r\n`)
} else {
  const launcher = join(vendor, provider)
  writeFileSync(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cli}" --fake-provider ${provider} --fake-version ${version} "$@"\n`)
  chmodSync(launcher, 0o755)
}
console.log(`added 1 package (${pkg}@${version})`)
