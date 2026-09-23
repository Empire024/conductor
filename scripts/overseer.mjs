#!/usr/bin/env node
// Conductor overseer: an unattended supervisor that drives Conductor through its owner
// app-control endpoint from outside the app. See docs/overseer.md.
import { execFileSync } from 'node:child_process'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, connectInstalled, DevInstance, runBuild } from './overseer/app-instance.mjs'
import { devLayout, installedUserData } from './overseer/credentials.mjs'
import { deliver, projectScope } from './overseer/deliver.mjs'
import { dispatchFixer } from './overseer/fixer.mjs'
import { loadGoal } from './overseer/goal.mjs'
import { EXIT, runLoop } from './overseer/loop.mjs'
import { runGoalOnce } from './overseer/runner.mjs'
import { CHECKOUT, createLogger, samePath, stamp, writeJsonAtomic } from './overseer/util.mjs'

const USAGE = `Usage: node scripts/overseer.mjs <command> [options]
  run --goal <file> [--goal <file>...] [--target dev|installed] [--fixer-target auto|dev|installed]
      [--iterations N] [--fixers N] [--deliver] [--restart-installed] [--no-fix] [--run-dir <dir>] [--keep-app]
  test --goal <file> [--target dev|installed] [--run-dir <dir>] [--keep-app]
  status [--target dev|installed]
  app start|stop|restart
  call --method <m> [--args <json>] [--scope <json>] [--project <path-or-name>] [--target dev|installed]
  build
  deliver [--restart-installed]
Exit codes: 0 pass, 1 fail, 2 blocked (fixer blocked, budget exhausted, app unreachable).`

const BOOLEAN = new Set(['deliver', 'restart-installed', 'no-fix', 'keep-app', 'help'])

export function parseArgs(argv) {
  const positional = []
  const options = { goal: [] }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) { positional.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s)
    if (BOOLEAN.has(name)) { options[name] = inline === undefined ? true : inline !== 'false'; continue }
    const value = inline ?? argv[++index]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    if (name === 'goal') options.goal.push(value)
    else options[name] = value
  }
  const integer = (name, fallback, min) => {
    if (options[name] === undefined) return fallback
    const value = Number(options[name])
    if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`)
    return value
  }
  const target = options.target ?? 'dev'
  if (!['dev', 'installed'].includes(target)) throw new Error('--target must be dev or installed')
  const fixerTarget = options['fixer-target'] ?? 'auto'
  if (!['auto', 'dev', 'installed'].includes(fixerTarget)) throw new Error('--fixer-target must be auto, dev or installed')
  return {
    command: positional[0], sub: positional[1], goals: options.goal, target, fixerTarget,
    iterations: integer('iterations', 5, 1), fixers: integer('fixers', 4, 1),
    deliver: Boolean(options.deliver), restartInstalled: Boolean(options['restart-installed']), noFix: Boolean(options['no-fix']), keepApp: Boolean(options['keep-app']),
    runDir: options['run-dir'], method: options.method, args: options.args, scope: options.scope, project: options.project, help: Boolean(options.help)
  }
}

const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CHECKOUT, encoding: 'utf8', windowsHide: true }).trim()

/** One shared client per app, so parallel fixers never overlap calls to the same server. */
function appRegistry({ instance, log }) {
  let installed = null
  return {
    async installed() {
      if (installed) return installed
      const attempt = await connectInstalled()
      if (!attempt.ok) throw new Error(`installed Conductor is not reachable: ${attempt.reason}`)
      installed = attempt.client
      return installed
    },
    forgetInstalled(client) { installed = client ?? null },
    async dev() { return instance.client ?? await instance.ensure() },
    async fixer(fixerTarget) {
      if (fixerTarget === 'installed') return this.installed()
      if (fixerTarget === 'dev') return this.dev()
      try { return await this.installed() } catch (error) { log(`fixer target auto: ${error.message}; using the dev instance`); return this.dev() }
    }
  }
}

async function commandRun(args, log, { testOnly = false } = {}) {
  if (!args.goals.length) throw new Error('at least one --goal is required')
  const goals = []
  for (const path of args.goals) goals.push(await loadGoal(path))
  const runDir = resolve(args.runDir ?? join(devLayout().base, 'runs', `${stamp()}-${goals.map(goal => goal.id).join('+')}`.slice(0, 120)))
  const runFile = join(runDir, 'run.json')
  let lastState = { goals: goals.map(goal => goal.id), target: args.target, iterations: [], outcome: 'starting' }
  const writeRun = async state => { lastState = state; await writeJsonAtomic(runFile, state) }
  const instance = new DevInstance({ runDir, log })
  const apps = appRegistry({ instance, log })
  const targetClient = () => args.target === 'dev' ? apps.dev() : apps.installed()
  const fixerScopes = new WeakMap()
  const fixerApp = async () => {
    const client = await apps.fixer(args.fixerTarget)
    if (!fixerScopes.has(client)) fixerScopes.set(client, await projectScope(client, CHECKOUT))
    return { call: client.call, scope: fixerScopes.get(client) }
  }
  const onSignal = async () => {
    log('interrupted; recording run state and stopping the dev app')
    try { await writeJsonAtomic(runFile, { ...lastState, outcome: 'interrupted', exitCode: EXIT.blocked, finishedAt: new Date().toISOString() }) } catch { /* best effort */ }
    if (args.target === 'dev' && !args.keepApp) await instance.stop().catch(() => {})
    process.exit(EXIT.blocked)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  log(`run dir ${runDir}`)
  const deps = {
    log, writeRun,
    ensureTarget: async () => { await targetClient() },
    runGoal: async (goal, n) => runGoalOnce({ client: await targetClient(), goal, iteration: n, target: args.target, projectsRoot: instance.projectsRoot, runDir, checkout: CHECKOUT, log }),
    dispatchFixer: async (goal, n, result) => dispatchFixer({ app: await fixerApp(), goal, iteration: n, iterations: args.iterations, result, checkout: CHECKOUT, head, log }),
    build: async n => runBuild({ checkout: CHECKOUT, logPath: join(runDir, `build-${n}.log`) }),
    reloadTarget: async () => {
      if (args.target === 'dev') {
        try { await instance.restart(); return { ok: true } } catch (error) { return { ok: false, reason: error.message } }
      }
      if (!args.restartInstalled) return { ok: false, fatal: true, reason: 'fixes are committed, but the installed target only runs them after an update; rerun with --restart-installed or use --target dev' }
      const result = await deliver({ client: await apps.installed(), userData: installedUserData(), restart: true, log })
      if (result.client) apps.forgetInstalled(result.client)
      return result.ok ? { ok: true, version: result.appVersion } : { ok: false, fatal: true, reason: result.reason }
    },
    deliver: async () => {
      const result = await deliver({ client: await apps.installed(), userData: installedUserData(), restart: args.restartInstalled, log })
      if (result.client) apps.forgetInstalled(result.client)
      return result
    }
  }
  const options = testOnly
    ? { iterations: 1, fixers: 1, noFix: true, deliver: false, target: args.target, fixerTarget: args.fixerTarget }
    : { iterations: args.iterations, fixers: args.fixers, noFix: args.noFix, deliver: args.deliver, target: args.target, fixerTarget: args.fixerTarget }
  let outcome
  try {
    outcome = await runLoop({ goals, options, deps })
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (args.target === 'dev' && !args.keepApp) await instance.stop().catch(error => log(`could not stop the dev app: ${error.message}`))
  }
  log(`${outcome.outcome.toUpperCase()}: ${outcome.summary} | ${runDir}`)
  return outcome.exitCode
}

async function clientFor(target, log) {
  if (target === 'installed') {
    const attempt = await connectInstalled()
    if (!attempt.ok) throw Object.assign(new Error(`installed Conductor is not reachable: ${attempt.reason}`), { exitCode: EXIT.blocked })
    return attempt
  }
  const attempt = await connect(devLayout().userData)
  if (!attempt.ok) throw Object.assign(new Error(`dev instance is not running (${attempt.reason}); start it with: node scripts/overseer.mjs app start`), { exitCode: EXIT.blocked })
  return attempt
}

async function commandStatus(args, log) {
  const { client, credential } = await clientFor(args.target, log)
  const state = await client.call('app.state', {}, null)
  const projects = await client.call('projects.list', {}, null)
  const agents = []
  for (const project of projects ?? []) for (const workspace of project.workspaces ?? []) {
    try {
      const list = await client.call('agents.list', {}, { projectId: project.id, workspaceId: workspace.id })
      for (const agent of list ?? []) if (!agent.crossProject && ['running', 'queued', 'starting', 'waiting_approval', 'waiting_input', 'interrupting'].includes(agent.phase)) agents.push({ project: project.name, title: agent.title, provider: agent.provider, phase: agent.phase, agentSessionId: agent.agentSessionId })
    } catch (error) { agents.push({ project: project.name, error: error.message }) }
  }
  console.log(JSON.stringify({ target: args.target, reachable: true, endpoint: credential.endpoint, pid: credential.pid, appVersion: state?.appVersion ?? credential.appVersion, packaged: credential.packaged, owner: state?.owner ?? null, projects: (projects ?? []).map(project => ({ id: project.id, name: project.name, path: project.path, workspaces: (project.workspaces ?? []).length })), runningAgents: agents }, null, 2))
  return EXIT.pass
}

async function commandCall(args, log) {
  if (!args.method) throw new Error('--method is required')
  const { client } = await clientFor(args.target, log)
  let scope = args.scope ? JSON.parse(args.scope) : undefined
  if (!scope && args.project) {
    const projects = await client.call('projects.list', {}, null)
    const found = (projects ?? []).find(project => project.name === args.project || (project.path && samePath(project.path, args.project)))
    if (!found) throw new Error(`no open project named or at ${args.project}`)
    scope = { projectId: found.id, workspaceId: found.workspaces?.[0]?.id }
  }
  const result = await client.call(args.method, args.args ? JSON.parse(args.args) : {}, scope ?? null)
  console.log(JSON.stringify(result, null, 2))
  return EXIT.pass
}

async function commandApp(args, log) {
  if (args.target !== 'dev') throw new Error('app start|stop|restart manages the parked dev instance only')
  const instance = new DevInstance({ log })
  if (args.sub === 'start') { await instance.ensure(); return EXIT.pass }
  if (args.sub === 'stop') { await instance.stop(); return EXIT.pass }
  if (args.sub === 'restart') { await instance.restart(); return EXIT.pass }
  throw new Error('app needs start, stop or restart')
}

async function commandBuild(args, log) {
  log('npm run build in the checkout')
  const result = await runBuild({ checkout: CHECKOUT, logPath: join(devLayout().base, 'build.log') })
  log(result.ok ? `build ok in ${Math.round(result.durationMs / 1000)} s` : `build failed (exit ${result.exitCode}):\n${result.tail}`)
  return result.ok ? EXIT.pass : EXIT.fail
}

async function commandDeliver(args, log) {
  const attempt = await connectInstalled()
  if (!attempt.ok) { log(`installed Conductor is not reachable: ${attempt.reason}`); return EXIT.blocked }
  const result = await deliver({ client: attempt.client, userData: installedUserData(), restart: args.restartInstalled, log })
  const { client, ...printable } = result
  console.log(JSON.stringify(printable, null, 2))
  return result.ok ? EXIT.pass : EXIT.fail
}

export async function main(argv = process.argv.slice(2)) {
  const log = createLogger()
  let args
  try { args = parseArgs(argv) } catch (error) { console.error(`${error.message}\n\n${USAGE}`); return EXIT.fail }
  if (args.help || !args.command) { console.log(USAGE); return args.help ? EXIT.pass : EXIT.fail }
  try {
    switch (args.command) {
      case 'run': return await commandRun(args, log)
      case 'test': return await commandRun(args, log, { testOnly: true })
      case 'status': return await commandStatus(args, log)
      case 'call': return await commandCall(args, log)
      case 'app': return await commandApp(args, log)
      case 'build': return await commandBuild(args, log)
      case 'deliver': return await commandDeliver(args, log)
      default: console.error(`unknown command ${args.command}\n\n${USAGE}`); return EXIT.fail
    }
  } catch (error) {
    log(`error: ${error.message}`)
    return error.exitCode ?? EXIT.blocked
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'overseer.mjs' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
