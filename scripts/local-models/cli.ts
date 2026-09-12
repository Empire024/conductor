#!/usr/bin/env node
/** Developer entry point for Conductor's local model stack: setup, start, stop, status, a
 *  single non-interactive run, and the smoke and security suites. Runs directly on Node 24
 *  (TypeScript is stripped at load), and shares every module with the Conductor provider so the
 *  CLI and the app enforce exactly the same boundary and the same storage layout. */
import { existsSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONTEXT_TOKENS, DEFAULT_SANDBOX, QWEN_35B, QWEN_9B, configPath, defaultModelConfig, endpointFor,
  ensureApiKey, loadConfig, logsDir, modelDir, modelFilePath, readApiKey, saveConfig, tempDir
} from '../../src/main/local-models/config.ts'
import type { LocalModelConfig, LocalStackConfig } from '../../src/main/local-models/config.ts'
import {
  LOCAL_ROOT_ENV, MIN_FREE_BYTES, assertLocalRootUsable, chooseLocalRoot, ensureLayout, freeBytes,
  layout, layoutFor, readPointer, sessionWorkspace, systemDrive, onSystemDrive, writePointer
} from '../../src/main/local-models/paths.ts'
import { downloadModel, downloadUrl, migrateModelFile, readProvenance, verifyModel } from '../../src/main/local-models/provenance.ts'
import { health, resolveLlamaServer, serverStatus, startServer, stopServer } from '../../src/main/local-models/llama.ts'
import { DockerSandbox, dockerAvailable, dockerExecutable, sandboxImageExists } from '../../src/main/local-models/sandbox.ts'
import { LocalAgentSession } from '../../src/main/local-models/agent.ts'
import { chatCompletion, type CompletionResult } from '../../src/main/local-models/client.ts'
import { runSecuritySuite } from './security.ts'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'status'
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const has = (name: string): boolean => argv.includes(`--${name}`)
const log = (message: string): void => { process.stdout.write(message + '\n') }
const fail = (message: string): never => { process.stderr.write(message + '\n'); process.exit(1) }
const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

const modelsOf = (config: LocalStackConfig, only?: string): LocalModelConfig[] => {
  const models = Object.values(config.models)
  if (!only) return models
  const model = config.models[only]
  if (!model) return fail(`Unknown model ${only}; known: ${models.map(entry => entry.id).join(', ')}`)
  return [model]
}

/** Fail closed before anything else runs: no command silently recreates state on C:. */
const requireRoot = (): ReturnType<typeof assertLocalRootUsable> => {
  try { return assertLocalRootUsable() } catch (error) { return fail(error instanceof Error ? error.message : 'Local root unavailable') }
}

/** Places an earlier setup may have left a GGUF, checked before anything is downloaded again. */
const legacyModelPaths = (model: LocalModelConfig): string[] => [
  join(process.cwd(), '.local-models', 'models', model.file),
  join(homedir(), '.conductor', 'local-models', 'models', model.file),
  join(layout().models, model.file)
]

async function dockerStorage(): Promise<string> {
  const docker = await dockerAvailable()
  if (!docker.available) return docker.reason ?? 'unavailable'
  const info = await new Promise<string>(resolve => execFile(dockerExecutable(), ['info', '--format', '{{.OperatingSystem}} | root {{.DockerRootDir}}'], { windowsHide: true, timeout: 30_000 }, (_error, stdout) => resolve((stdout ?? '').trim())))
  return `${docker.version} | ${info || 'storage location not reported'}`
}

async function setup(): Promise<void> {
  // 1. The one canonical setting: an explicit --root, an existing pointer/environment value, or
  //    an automatically chosen fixed non-system drive with enough free space.
  const requested = flag('root') ?? readPointer()
  let root: string
  if (requested) {
    if (onSystemDrive(requested)) return void fail(`Refusing a local root on the system drive (${systemDrive()}): ${requested}`)
    root = requested
  } else {
    const chosen = chooseLocalRoot()
    root = chosen.root
    log(`selected drive ${chosen.drive.letter}${chosen.drive.label ? ` (${chosen.drive.label})` : ''} with ${gb(chosen.drive.freeBytes)} free`)
  }
  ensureLayout(root)
  const free = freeBytes(root)
  if (free < MIN_FREE_BYTES) return void fail(`Insufficient space: ${root} has ${gb(free)} free, ${gb(MIN_FREE_BYTES)} required. Free space or pass --root <path on another fixed drive>.`)
  const pointers = writePointer(root, 'Conductor local model data root')
  log(`local root: ${root} (${gb(free)} free)`)
  log(`  recorded in ${pointers.join(' and ')} (${LOCAL_ROOT_ENV} overrides it)`)
  const paths = assertLocalRootUsable()
  log(`  models ${paths.models} | temp ${paths.temp} | cache ${paths.cache} | workspaces ${paths.workspaces}`)

  // 2. llama.cpp: reuse whatever is already installed, never reinstall to relocate a binary.
  const resolved = await resolveLlamaServer(flag('llama-server'))
  if (!resolved) return void fail('llama.cpp missing: install a CUDA build of llama-server (winget install ggml.llamacpp) or pass --llama-server <path>')
  log(`FOUND llama.cpp: ${resolved.path}`)
  log(`  ${resolved.version}`)

  const existing = existsSync(configPath()) ? (() => { try { return loadConfig() } catch { return null } })() : null
  const quant9b = flag('quant-9b') ?? existing?.models[QWEN_9B]?.quant ?? 'Q4_K_M'
  const context = Number(flag('context') ?? existing?.models[QWEN_9B]?.contextTokens ?? DEFAULT_CONTEXT_TOKENS)
  const config: LocalStackConfig = {
    version: 1,
    llamaServer: resolved.path,
    llamaVersion: resolved.version,
    models: {
      [QWEN_9B]: { ...(existing?.models[QWEN_9B] ?? defaultModelConfig(QWEN_9B, quant9b)), ...defaultModelConfig(QWEN_9B, quant9b), contextTokens: context },
      [QWEN_35B]: { ...(existing?.models[QWEN_35B] ?? defaultModelConfig(QWEN_35B)), ...defaultModelConfig(QWEN_35B), contextTokens: context }
    },
    sandbox: { ...DEFAULT_SANDBOX, ...(existing?.sandbox ?? {}) }
  }
  saveConfig(config)
  ensureApiKey()
  log(`config: ${configPath()}`)

  // 3. Models: keep what is already correct, migrate what an earlier setup left elsewhere,
  //    download only what is genuinely missing.
  if (!has('skip-models')) {
    for (const model of Object.values(config.models)) {
      const destination = modelFilePath(model)
      if (existsSync(destination)) {
        const verified = await verifyModel(model)
        if (verified.ok) { log(`FOUND ${model.id}: ${destination} (checksum verified)`); continue }
        log(`${model.id}: ${verified.reason}; replacing`)
        rmSync(destination, { force: true })
      }
      const legacy = legacyModelPaths(model).find(path => path !== destination && existsSync(path))
      if (legacy) {
        log(`MIGRATE ${model.id}: ${legacy} -> ${destination}`)
        const moved = await migrateModelFile(model, legacy)
        log(`  ok  ${gb(moved.sizeBytes)}, sha256 verified after the move; old copy removed`)
        continue
      }
      for (const partial of legacyModelPaths(model).map(path => path + '.part').filter(existsSync)) {
        log(`  discarding stale partial download ${partial} (${gb(statSync(partial).size)})`)
        rmSync(partial, { force: true })
      }
      log(`DOWNLOAD ${model.id}: ${downloadUrl(model)}`)
      log(`  staging in ${tempDir()}`)
      let lastPercent = -1
      await downloadModel(model, (received, total) => {
        const percent = Math.floor((received / Math.max(total, 1)) * 100)
        if (percent !== lastPercent && percent % 5 === 0) { lastPercent = percent; process.stdout.write(`  ${percent}%\r`) }
      })
      log(`  ok  ${model.file} (sha256 verified against the pinned upstream value)`)
    }
  }

  // 4. Sandbox image.
  if (!has('skip-image')) {
    const docker = await dockerAvailable()
    if (!docker.available) log(`sandbox image skipped: ${docker.reason}`)
    else if (await sandboxImageExists(config.sandbox.image)) log(`FOUND sandbox image ${config.sandbox.image}`)
    else {
      log(`building sandbox image ${config.sandbox.image} ...`)
      const code = await new Promise<number>(resolve => {
        const build = spawn(dockerExecutable(), ['build', '--tag', config.sandbox.image, join(import.meta.dirname, 'sandbox')], { shell: false, windowsHide: true, stdio: 'inherit' })
        build.on('error', () => resolve(-1))
        build.on('close', value => resolve(value ?? -1))
      })
      if (code !== 0) fail('Sandbox image build failed')
      log(`  ok  ${config.sandbox.image}`)
    }
  }

  // 5. Leave nothing behind on the system drive except the few bytes of pointer.
  const legacyRoot = join(process.cwd(), '.local-models')
  for (const directory of ['models', 'run', 'logs'].map(name => join(legacyRoot, name))) {
    try { if (existsSync(directory) && !readdirSync(directory).length) rmdirSync(directory) } catch { /* leave anything still in use */ }
  }
  log('')
  log('setup complete. Next: scripts/local-models/start.ps1')
}

async function start(): Promise<void> {
  const paths = requireRoot()
  const config = loadConfig()
  const apiKey = readApiKey()
  const mode = has('fast') ? 'size' : 'full'
  log(`local root: ${paths.root} (${gb(freeBytes(paths.root))} free)`)
  log(`llama.cpp: ${config.llamaServer}`)
  log(`  ${config.llamaVersion ?? 'version not recorded'}`)
  const docker = await dockerAvailable()
  log(docker.available ? `docker: ${docker.version}` : `docker: unavailable (${docker.reason}) - tool execution will be refused, never run on the host`)
  if (docker.available && !await sandboxImageExists(config.sandbox.image)) log(`sandbox image missing: ${config.sandbox.image} (run setup)`)
  for (const model of modelsOf(config, flag('model'))) {
    log(`verifying ${model.file} (${mode}) ...`)
    const verified = await verifyModel(model, mode)
    if (!verified.ok) fail(verified.reason ?? 'GGUF verification failed')
    const outcome = await startServer(config.llamaServer, model, apiKey)
    log(`${model.id}: ${outcome.message} on 127.0.0.1:${model.port} (ctx ${model.contextTokens}, gpu layers ${model.gpuLayers})`)
  }
  await status()
}

async function stop(): Promise<void> {
  requireRoot()
  const config = loadConfig()
  for (const model of modelsOf(config, flag('model'))) log(`${model.id}: ${await stopServer(model)}`)
  if (has('sandbox')) {
    const sandbox = new DockerSandbox('cli', sessionWorkspace('cli'), config.sandbox)
    await sandbox.stop()
    log('sandbox container removed')
  }
}

async function status(): Promise<void> {
  const paths = requireRoot()
  const config = loadConfig()
  const apiKey = readApiKey()
  log(`local root: ${paths.root} (${gb(freeBytes(paths.root))} free, system drive is ${systemDrive()})`)
  log(`models: ${paths.models} | workspaces: ${paths.workspaces} | temp: ${paths.temp} | logs: ${logsDir()}`)
  log(`llama.cpp: ${config.llamaServer} (${config.llamaVersion ?? 'version not recorded'})`)
  log(`docker: ${await dockerStorage()}`)
  for (const model of Object.values(config.models)) {
    const state = await serverStatus(model, apiKey)
    const file = modelFilePath(model)
    log(`${model.id}: ${state.running ? `pid ${state.pid}` : 'stopped'} | 127.0.0.1:${state.port} | ${state.healthy ? 'healthy' : `unhealthy (${state.detail ?? 'no answer'})`} | api key enforced: ${state.keyEnforced}`)
    log(`  file: ${file} ${existsSync(file) ? `(${gb(statSync(file).size)})` : '(missing)'}`)
  }
  for (const record of readProvenance()) log(`provenance: ${record.id} ${record.repo}@${record.revision.slice(0, 12)} ${record.file} sha256=${record.sha256.slice(0, 16)}... (${record.sha256Source})`)
}

/** Why a smoke completion produced no usable text. Kept to one short line each: enough to tell an
 *  empty answer from a reasoning-only one, a truncation from a malformed stream, without dumping
 *  the body (which can echo the prompt) or anything key-shaped. */
function diagnose(completion: CompletionResult): string {
  const parts: string[] = [`finish=${completion.finishReason}`, `events=${completion.stream.events}`]
  if (completion.stream.malformed) parts.push(`unparsable-events=${completion.stream.malformed}`)
  if (completion.usage?.outputTokens !== undefined) parts.push(`out=${completion.usage.outputTokens}tok`)
  if (completion.toolCalls.length) parts.push(`tool-calls=${completion.toolCalls.map(call => call.name).join(',')}`)
  if (completion.reasoning.trim()) parts.push(`reasoning-only=${completion.reasoning.trim().length}ch`)
  if (!completion.stream.events) parts.push('no stream events (malformed or empty response)')
  else if (!completion.content.trim() && !completion.reasoning.trim() && !completion.toolCalls.length) parts.push('empty content')
  return parts.join(' ')
}

/** Reachability, auth, a real generation and response parsing — and nothing else. Reasoning is
 *  turned off for the probe so the small token budget buys an answer rather than a thinking pass
 *  the model never finishes; real sessions leave reasoning alone. */
async function smoke(): Promise<void> {
  requireRoot()
  const config = loadConfig()
  const apiKey = readApiKey()
  let failures = 0
  for (const model of modelsOf(config, flag('model'))) {
    const probe = await health(model.port, apiKey)
    if (!probe.ok) { log(`FAIL ${model.id}: server health check failed (${probe.detail})`); failures++; continue }
    let completion: CompletionResult
    try {
      completion = await chatCompletion({
        endpoint: endpointFor(model), apiKey, model: model.id,
        messages: [{ role: 'user', content: 'Reply with exactly: LOCAL_QWEN_OK' }],
        maxTokens: 32, temperature: 0, reasoningEffort: 'none'
      })
    } catch (error) {
      log(`FAIL ${model.id}: request failed (${error instanceof Error ? error.message : 'unknown error'})`)
      failures++
      continue
    }
    const text = completion.content.trim()
    if (text.includes('LOCAL_QWEN_OK')) { log(`PASS ${model.id}: ${text.slice(0, 80)}`); continue }
    log(`FAIL ${model.id}: ${text ? `unexpected text ${JSON.stringify(text.slice(0, 80))}` : '(no text)'} [${diagnose(completion)}]`)
    failures++
  }
  if (failures) process.exitCode = 1
}

async function run(): Promise<void> {
  requireRoot()
  const config = loadConfig()
  const apiKey = readApiKey()
  const id = flag('model') ?? QWEN_9B
  const model = config.models[id]
  if (!model) return void fail(`Unknown model ${id}; known: ${Object.keys(config.models).join(', ')}`)
  const prompt = argv.filter((value, index) => index > 0 && !value.startsWith('--') && argv[index - 1] !== '--model' && argv[index - 1] !== '--cwd' && argv[index - 1] !== '--session' && argv[index - 1] !== '--max-iterations').join(' ').trim()
  if (!prompt) return void fail('A prompt is required: run --model local/qwen3.5-9b "Explain this project."')
  // Without an explicit project directory the agent works in its own session workspace on the
  // local root; that directory - and only that directory - is what the sandbox mounts.
  const session = flag('session') ?? `cli-${process.pid}`
  const workspace = flag('cwd') ?? sessionWorkspace(session)
  const readOnly = has('read-only')
  const probe = await health(model.port, apiKey)
  if (!probe.ok) return void fail(`Server health check failed for ${model.id} (${probe.detail}); run scripts/local-models/start.ps1`)
  log(`workspace: ${workspace}`)
  const sandbox = readOnly ? null : new DockerSandbox(session, workspace, config.sandbox)
  const agent = new LocalAgentSession({
    endpoint: endpointFor(model), apiKey, model: model.id, workspace, sandbox, readOnly,
    timeoutSec: config.sandbox.timeoutSec, contextTokens: model.contextTokens,
    maxIterations: Number(flag('max-iterations') ?? 16)
  })
  try {
    await agent.run(prompt, {
      text: delta => process.stdout.write(delta),
      toolStart: call => process.stderr.write(`\n[tool ${call.name}] ${call.input.slice(0, 200)}\n`),
      toolEnd: call => process.stderr.write(`[tool ${call.name} ${call.failed ? 'failed' : 'ok'} ${call.durationMs}ms]\n`),
      notice: message => process.stderr.write(`[notice] ${message}\n`)
    })
    process.stdout.write('\n')
  } finally {
    if (sandbox) await sandbox.stop()
  }
}

async function main(): Promise<void> {
  switch (command) {
    case 'setup': return setup()
    case 'start': return start()
    case 'stop': return stop()
    case 'status': return status()
    case 'smoke': return smoke()
    case 'run': return run()
    case 'security-test': {
      const paths = requireRoot()
      const ok = await runSecuritySuite({ workspace: flag('cwd') ?? sessionWorkspace('security-check'), root: paths })
      if (!ok) process.exitCode = 1
      return
    }
    case 'where': {
      const root = readPointer()
      if (!root) return void fail(`Local root is not configured; run setup or set ${LOCAL_ROOT_ENV}`)
      const paths = layoutFor(root)
      log(Object.entries(paths).map(([name, value]) => `${name.padEnd(11)} ${value}`).join('\n'))
      return
    }
    case 'models': {
      const configured = readPointer() && existsSync(configPath()) ? loadConfig() : null
      log(configured ? Object.values(configured.models).map(model => `${model.id}\t${model.quant}\t127.0.0.1:${model.port}\tctx ${model.contextTokens}\t${modelDir(model)}`).join('\n') : 'not set up')
      return
    }
    default:
      log('usage: node scripts/local-models/cli.ts <setup|start|stop|status|smoke|run|security-test|where|models> [options]')
      log('       setup [--root <dir on a non-system drive>] [--llama-server <path>] [--quant-9b Q4_K_M|Q6_K] [--context 32768] [--skip-models] [--skip-image]')
      process.exitCode = 1
  }
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exit(1)
})
