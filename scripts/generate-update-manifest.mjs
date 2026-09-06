import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }

const releaseDirectory = resolve('release')
const installerName = `Conductor-Setup-${packageJson.version}.exe`
const installerPath = resolve(releaseDirectory, installerName)
const installerStat = await stat(installerPath)
const hash = createHash('sha512')

await new Promise((resolveHash, rejectHash) => {
  const stream = createReadStream(installerPath)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('end', resolveHash)
  stream.on('error', rejectHash)
})

const sha512 = hash.digest('base64')
const manifest = [
  `version: ${packageJson.version}`,
  'files:',
  `  - url: ${installerName}`,
  `    sha512: ${sha512}`,
  `    size: ${installerStat.size}`,
  `path: ${installerName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  ''
].join('\n')

await writeFile(resolve(releaseDirectory, 'latest.yml'), manifest, 'utf8')
console.log(`Generated release/latest.yml for Conductor ${packageJson.version}`)
