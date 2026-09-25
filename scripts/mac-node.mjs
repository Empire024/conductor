#!/usr/bin/env node
// Execution nodes from the command line: register, probe and run bounded jobs on another of the
// owner's computers over SSH inside the tailnet (docs/mac-node.md). Same records and logs as the
// app: <userData>/remote-jobs (Windows: %APPDATA%\Conductor\remote-jobs).
//
//   node scripts/mac-node.mjs register --id mac-mini --host jurajs-mac-mini --user <name> [--key <path>] [--name "Mac mini"] [--label electron-build]
//   node scripts/mac-node.mjs probe [<id>]                 # facts + capabilities; marks online/offline
//   node scripts/mac-node.mjs nodes
//   node scripts/mac-node.mjs run [--node <id> | --requires macos,arm64] [--cwd <dir>] [--timeout <sec>]
//                                 [--checkout [<localRepo>]] [--commit <ref>] [--title <t>] -- <command…>
//   node scripts/mac-node.mjs jobs | job <id> | log <id> [stdout|stderr] [--bytes N] | cancel <id>
//   node scripts/mac-node.mjs recover                      # record jobs a dead process left as lost
//
// `run` waits for the job, prints its streams as they are persisted, exits with the job's exit code
// (or 124 timed out, 130 cancelled, 255 lost/failed to start). Ctrl-C cancels the job on the node.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RemoteJobService } from '../src/main/remote-jobs/service.ts'
import { RemoteJobStore } from '../src/main/remote-jobs/store.ts'
import { sshTransport } from '../src/main/remote-jobs/transport.ts'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function defaultDataDir(platform = process.platform, env = process.env) {
  const base = platform === 'win32' ? env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'Conductor', 'remote-jobs')
}

function parse(argv) {
  const dash = argv.indexOf('--')
  const head = dash < 0 ? argv : argv.slice(0, dash)
  const rest = dash < 0 ? [] : argv.slice(dash + 1)
  const flags = {}
  const positional = []
  for (let i = 0; i < head.length; i++) {
    const arg = head[i]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const key = arg.slice(2)
    const next = head[i + 1]
    const value = next === undefined || next.startsWith('--') ? true : (i++, next)
    flags[key] = flags[key] === undefined ? value : [].concat(flags[key], value)
  }
  return { positional, flags, rest }
}

const list = value => value === undefined || value === true ? [] : [].concat(value).flatMap(entry => String(entry).split(',')).map(entry => entry.trim()).filter(Boolean)
const print = value => console.log(JSON.stringify(value, null, 2))
const EXIT = { succeeded: 0, 'timed-out': 124, cancelled: 130, lost: 255 }

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2)
  const { positional, flags, rest } = parse(args)
  const store = new RemoteJobStore(typeof flags.data === 'string' ? flags.data : defaultDataDir())
  const service = new RemoteJobService({ store, transport: sshTransport({ knownHostsFile: store.knownHostsFile }) })

  if (command === 'register') {
    const key = typeof flags.key === 'string' ? flags.key : join(homedir(), '.ssh', 'conductor_mac_ed25519')
    print(service.registerNode({
      id: String(flags.id ?? ''), name: typeof flags.name === 'string' ? flags.name : undefined,
      ssh: { host: String(flags.host ?? ''), user: String(flags.user ?? ''), identityFile: key, ...(flags.port ? { port: Number(flags.port) } : {}) },
      labels: list(flags.label), ...(flags.root ? { root: String(flags.root) } : {}), ...(flags.max ? { maxConcurrentJobs: Number(flags.max) } : {})
    }))
    return 0
  }
  if (command === 'nodes') { print(service.listNodes()); return 0 }
  if (command === 'probe') {
    const ids = positional.length ? positional : service.listNodes().map(node => node.id)
    const probed = []
    for (const id of ids) probed.push(await service.probeNode(id))
    print(probed)
    return probed.every(node => node.status === 'online') ? 0 : 1
  }
  if (command === 'jobs') { print(service.listJobs({ limit: Number(flags.limit ?? 20) }).map(({ stdoutTail, stderrTail, ...job }) => job)); return 0 }
  if (command === 'job') { print(service.getJob(positional[0])); return 0 }
  if (command === 'log') {
    const log = service.readLog(positional[0], positional[1] === 'stderr' ? 'stderr' : 'stdout', Number(flags.bytes ?? 65536))
    process.stdout.write(log.text)
    return 0
  }
  if (command === 'cancel') { print(await service.cancel(positional[0], typeof flags.reason === 'string' ? flags.reason : 'cancelled from scripts/mac-node.mjs')); await service.idle(); return 0 }
  if (command === 'recover') { print(await service.recover()); return 0 }
  if (command === 'run') {
    if (!rest.length) throw new Error('run needs a command after --')
    const checkout = flags.checkout === undefined ? undefined
      : { localRepoPath: typeof flags.checkout === 'string' ? resolve(flags.checkout) : repoRoot, ...(typeof flags.commit === 'string' ? { commit: flags.commit } : {}) }
    const job = await service.submit({
      command: rest.join(' '), title: typeof flags.title === 'string' ? flags.title : undefined,
      nodeId: typeof flags.node === 'string' ? flags.node : undefined, requires: list(flags.requires),
      cwd: typeof flags.cwd === 'string' ? flags.cwd : undefined, timeoutSec: flags.timeout ? Number(flags.timeout) : undefined,
      checkout, createdBy: 'scripts/mac-node.mjs'
    })
    console.error(`[mac-node] ${job.id} on ${job.nodeId}${job.checkout ? ` at ${job.checkout.commit.slice(0, 12)}` : ''}: ${job.title}`)
    process.once('SIGINT', () => { console.error('[mac-node] cancelling…'); void service.cancel(job.id, 'Ctrl-C') })
    // Follow the persisted logs, so what is printed is exactly what Conductor keeps.
    const offsets = { stdout: 0, stderr: 0 }
    const follow = () => {
      for (const stream of ['stdout', 'stderr']) {
        const { text, size } = service.readLog(job.id, stream, 1024 * 1024)
        if (size > offsets[stream]) {
          const fresh = Buffer.from(text).subarray(Math.max(0, Buffer.byteLength(text) - (size - offsets[stream]))).toString('utf8')
          ;(stream === 'stdout' ? process.stdout : process.stderr).write(fresh)
          offsets[stream] = size
        }
      }
    }
    const timer = setInterval(follow, 500)
    const done = await service.wait(job.id, (job.timeoutSec + 180) * 1000)
    clearInterval(timer)
    follow()
    await service.idle()
    const final = service.getJob(job.id)
    console.error(`[mac-node] ${final.id} ${final.status}${final.exitCode === null ? '' : ` (exit ${final.exitCode})`}${final.detail ? `: ${final.detail}` : ''}`)
    console.error(`[mac-node] logs: ${store.jobDir(final.id)}`)
    void done
    return final.status === 'failed' ? (final.exitCode ?? 255) : EXIT[final.status] ?? 255
  }
  console.log(`Usage: see the header of scripts/mac-node.mjs. Data: ${defaultDataDir()}`)
  return command === 'help' ? 0 : 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code }, error => { console.error(`[mac-node] ${error instanceof Error ? error.message : error}`); process.exitCode = 1 })
}
