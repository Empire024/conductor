#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { generateRoomSecret, roomIdFor } from '../main/relay-room.ts'
import { startRelayServer } from './server.ts'

/**
 * Runs the relay. Node reads this file directly - TypeScript is stripped at load - so there is no
 * build step between the source the owner can read and the process that holds their traffic.
 *
 * Everything it needs is one secret. `npm run relay:secret` prints a fresh one; put the same value
 * on the server and in every Conductor that should meet there.
 */

const args = process.argv.slice(2)

const flag = (name: string): string | undefined => {
  const prefix = `--${name}=`
  const inline = args.find(argument => argument.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

if (args[0] === 'new-secret') {
  const secret = generateRoomSecret()
  console.log(secret)
  console.error(`\nRoom id (what the relay sees, and never the secret): ${roomIdFor(secret)}`)
  console.error('Put this value in CONDUCTOR_RELAY_SECRET on the server, and paste it into')
  console.error('Account & machines on every computer that should meet there.')
  process.exit(0)
}

const secrets = (flag('secret') ?? process.env.CONDUCTOR_RELAY_SECRET ?? process.env.CONDUCTOR_RELAY_SECRETS ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

if (!secrets.length) {
  console.error('No room secret. Set CONDUCTOR_RELAY_SECRET or pass --secret, and run')
  console.error('`npm run relay:secret` if you do not have one yet.')
  process.exit(2)
}

const port = Number(flag('port') ?? process.env.CONDUCTOR_RELAY_PORT ?? 8787)
const host = flag('host') ?? process.env.CONDUCTOR_RELAY_HOST ?? '0.0.0.0'
const keyPath = flag('tls-key') ?? process.env.CONDUCTOR_RELAY_TLS_KEY
const certPath = flag('tls-cert') ?? process.env.CONDUCTOR_RELAY_TLS_CERT

const tls = keyPath && certPath ? { key: readFileSync(keyPath), cert: readFileSync(certPath) } : undefined

const { server, port: bound } = await startRelayServer({
  secrets,
  port,
  host,
  tls,
  log: line => console.log(`${new Date().toISOString()} ${line}`)
})

const scheme = tls ? 'wss' : 'ws'
console.log(`${new Date().toISOString()} conductor relay listening on ${scheme}://${host}:${bound}`)
console.log(`${new Date().toISOString()} serving ${secrets.length} room(s); paste the relay address into Account & machines`)
if (!tls) {
  console.log(`${new Date().toISOString()} no TLS here: run this behind a proxy that terminates it, or pass --tls-key/--tls-cert, before letting it off this machine`)
}

let stopping = false
const stop = (signal: string): void => {
  if (stopping) return
  stopping = true
  console.log(`${new Date().toISOString()} ${signal}: closing sockets`)
  void server.close().then(() => process.exit(0))
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
