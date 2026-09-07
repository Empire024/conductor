import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { builderArguments, descriptorName, installerNames, localFeedDirectory, parseVersion, publishLocalPackage, readPreviousDescriptor, selectLocalVersion } from './local-update-package.mjs'

test('local builds follow the highest installed/published baseline without outrunning the next stable patch', () => {
  assert.equal(selectLocalVersion({ versions: ['0.1.3', '0.1.4.0', 'v0.1.4'], now: 1000 }), '0.1.5-local.1000')
  assert.equal(selectLocalVersion({ versions: ['0.1.3', '0.1.5-local.1000'], previousVersion: '0.1.5-local.1000', now: 900 }), '0.1.5-local.1001')
  assert.equal(selectLocalVersion({ versions: ['0.1.3', '0.1.5'], previousVersion: '0.1.5-local.1000', now: 2000 }), '0.1.6-local.2000')
  assert.equal(selectLocalVersion({ versions: ['0.9.9', '1.0.0'], now: 1000 }), '1.0.1-local.1000')
  assert.equal(parseVersion('0.1.5-local.1000').prerelease, 'local.1000')
  assert.equal(parseVersion('0.1.5').prerelease, null)
  assert.throws(() => selectLocalVersion({ versions: ['../../../1'], now: 1 }), /Invalid version/)
})

test('build arguments override packaged metadata only and never publish to GitHub', () => {
  const args = builderArguments('0.1.5-local.1000', resolve('synthetic output Ω'))
  assert.deepEqual(args.slice(0, 5), ['--win', 'nsis', '--x64', '--publish', 'never'])
  assert.ok(args.includes('-c.extraMetadata.version=0.1.5-local.1000'))
  assert.ok(args.includes(`-c.directories.output=${resolve('synthetic output Ω')}`))
  assert.equal(localFeedDirectory({ APPDATA: resolve('synthetic roaming') }), resolve('synthetic roaming', 'Conductor', 'local-updates'))
  assert.throws(() => installerNames('0.1.5'), /local prerelease/)
})

async function fixture(version = '0.1.5-local.1000') {
  const root = await mkdtemp(resolve(tmpdir(), 'conductor-local-package-synthetic-'))
  const outputDirectory = resolve(root, 'build with spaces Ω')
  const feedDirectory = resolve(root, 'feed')
  await mkdir(outputDirectory)
  const names = installerNames(version)
  // Explicitly synthetic package bytes; never run by these tests and not a real installer.
  const installer = Buffer.from('MZ SYNTHETIC PACKAGE - NOT EXECUTABLE\r\nΩ')
  const blockmap = Buffer.from('SYNTHETIC BLOCKMAP - NO RUNTIME')
  await writeFile(resolve(outputDirectory, names.installer), installer)
  await writeFile(resolve(outputDirectory, names.blockmap), blockmap)
  return { root, outputDirectory, feedDirectory, version, names, installer, blockmap }
}

test('publication copies immutable bytes and publishes a complete hashed descriptor last', async () => {
  const input = await fixture()
  assert.equal(await readPreviousDescriptor(input.feedDirectory), null)
  const descriptor = await publishLocalPackage({ ...input, commit: 'a'.repeat(40), dirty: true, createdAt: '2026-09-07T00:00:00.000Z' })
  assert.equal(descriptor.schemaVersion, 1)
  assert.equal(descriptor.sha512, createHash('sha512').update(input.installer).digest('base64'))
  assert.equal(descriptor.blockmapSha512, createHash('sha512').update(input.blockmap).digest('base64'))
  assert.equal(descriptor.size, input.installer.length)
  assert.equal(descriptor.blockmapSize, input.blockmap.length)
  assert.deepEqual(await readPreviousDescriptor(input.feedDirectory), descriptor)
  assert.deepEqual(await readFile(resolve(input.feedDirectory, descriptor.installer)), input.installer)
  await writeFile(resolve(input.outputDirectory, input.names.installer), 'different synthetic bytes')
  await assert.rejects(publishLocalPackage(input), /already published/)
  assert.deepEqual(await readPreviousDescriptor(input.feedDirectory), descriptor)
  assert.deepEqual(await readFile(resolve(input.feedDirectory, descriptor.installer)), input.installer)
})

test('an incomplete build cannot replace a working feed descriptor', async () => {
  const input = await fixture()
  const descriptor = await publishLocalPackage(input)
  await assert.rejects(publishLocalPackage({ ...input, version: '0.1.5-local.1001' }), /ENOENT/)
  assert.deepEqual(await readPreviousDescriptor(input.feedDirectory), descriptor)
  await assert.rejects(publishLocalPackage({ ...input, version: '../escape' }), /local prerelease/)
  await writeFile(resolve(input.feedDirectory, descriptorName), JSON.stringify({ schemaVersion: 8, version: '0.1.5' }))
  await assert.rejects(readPreviousDescriptor(input.feedDirectory), /Invalid local feed descriptor/)
})

test('a second complete local version atomically replaces the descriptor and retains old artifact bytes', async () => {
  const initial = await fixture()
  const first = await publishLocalPackage(initial)
  const next = await fixture('0.1.5-local.1001')
  const second = await publishLocalPackage({ ...next, feedDirectory: initial.feedDirectory })
  assert.equal((await readPreviousDescriptor(initial.feedDirectory)).version, second.version)
  assert.deepEqual(await readFile(resolve(initial.feedDirectory, first.installer)), initial.installer)
})

test('feed directory junctions are not accepted as publication destinations', async () => {
  const input = await fixture()
  const target = resolve(input.root, 'actual feed')
  await mkdir(target)
  await symlink(target, input.feedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(publishLocalPackage(input), /regular directory/)
})

test('an older build finishing later cannot replace a newer published local build', async () => {
  const next = await fixture('0.1.5-local.1001')
  const descriptor = await publishLocalPackage(next)
  const older = await fixture('0.1.5-local.1000')
  await assert.rejects(publishLocalPackage({ ...older, feedDirectory: next.feedDirectory }), /already published/)
  assert.deepEqual(await readPreviousDescriptor(next.feedDirectory), descriptor)
})

test('a concurrent publisher lock fails closed without changing the working descriptor', async () => {
  const input = await fixture()
  const descriptor = await publishLocalPackage(input)
  await writeFile(resolve(input.feedDirectory, '.conductor-local-publish.lock'), '{"synthetic":true}')
  const next = await fixture('0.1.5-local.1001')
  await assert.rejects(publishLocalPackage({ ...next, feedDirectory: input.feedDirectory }), /EEXIST/)
  assert.deepEqual(await readPreviousDescriptor(input.feedDirectory), descriptor)
})
