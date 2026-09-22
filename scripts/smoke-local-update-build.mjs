// Drives the host-side updater the way a conversation does: LocalUpdateBuilder.start() plus
// polling status until it stops running. A pass publishes a real local update into the feed the
// installed app watches, which is the same outcome as `npm run update:local`.
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalUpdateBuilder } from '../src/main/local-update-build.ts'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builder = new LocalUpdateBuilder()
const unsupported = builder.unsupported(workspace)
if (unsupported) throw new Error(`Expected this checkout to be buildable: ${unsupported}`)
if (builder.unsupported(dirname(workspace)) === null) throw new Error('Expected a non-Conductor directory to be refused')

console.log('Starting the local update build through the control-facing builder…')
let status = builder.start(workspace)
if (status.state !== 'running') throw new Error(`Expected the build to be running, got ${status.state}`)
if (builder.start(workspace).state !== 'running') throw new Error('A second start must report the running build, not launch another')

while (status.state === 'running') {
  await new Promise(done => setTimeout(done, 15_000))
  status = builder.status()
  console.log(`[${new Date().toISOString()}] ${status.state} ${status.version ?? ''} ${status.log.at(-1) ?? ''}`)
}
console.log(status.log.join('\n'))
if (status.state !== 'succeeded') throw new Error(`Build ${status.state}: ${status.message}`)
if (!/^\d+\.\d+\.\d+-local\.\d+$/.test(status.version ?? '')) throw new Error(`Expected a published local version, got ${status.version}`)
if (!status.feedDirectory) throw new Error('Expected the feed directory to be reported')
console.log(`Published ${status.version} into ${status.feedDirectory}`)
