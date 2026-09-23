import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_DOLPHIN_X1_8B, LOCAL_ORNITH_9B, LOCAL_QWEN_35B, LOCAL_QWEN_9B } from '../../shared/local-models.ts'
import { assertLocalRootUsable, layout, localRoot } from './paths.ts'

/** One locally served model: which GGUF it is, where it came from, and how its llama.cpp
 *  server is bound. `sha256`/`revision` are the pinned upstream facts recorded when the file
 *  list was reviewed; `setup` compares the download against them and `start` re-verifies. */
export interface LocalModelConfig {
  id: string
  label: string
  repo: string
  revision: string
  file: string
  quant: string
  sizeBytes: number
  sha256: string
  port: number
  contextTokens: number
  /** Layers pushed onto the RTX 5070. The 35B MoE deliberately keeps most weights in the
   *  64 GB of system RAM. Only one model server may be resident at a time. */
  gpuLayers: number
  extraArgs: string[]
  /** KV cache element type for K and V. f16 is llama.cpp's default; q8_0 halves the cache at a
   *  negligible quality cost and is what makes a 64K window fit beside the weights in 12 GB.
   *  A quantized V cache needs flash attention, which the launcher turns on for it. Only passed
   *  when the installed llama-server advertises the flag. */
  kvCacheType?: KvCacheType
  /** Flash attention: llama.cpp's own default is auto (on where the backend supports it). */
  flashAttention?: 'auto' | 'on' | 'off'
}

export const KV_CACHE_TYPES = ['f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0'] as const
export type KvCacheType = (typeof KV_CACHE_TYPES)[number]
/** Bytes per element relative to f16, for the admission estimate. */
export const KV_CACHE_SCALE: Record<KvCacheType, number> = { f16: 1, bf16: 1, q8_0: 0.53, q5_1: 0.375, q5_0: 0.34, q4_1: 0.31, q4_0: 0.28 }

export interface SandboxConfig {
  image: string
  baseDigest?: string
  memory: string
  cpus: string
  pids: number
  timeoutSec: number
  maxOutputBytes: number
  tmpfsSizeMb: number
}

export interface LocalStackConfig {
  version: 1
  llamaServer: string
  llamaVersion?: string
  models: Record<string, LocalModelConfig>
  sandbox: SandboxConfig
}

export const LOCAL_MODEL_PREFIX = 'local/'
/** Re-exported from the one place both processes read these ids from: the renderer names a
 *  model by id and nothing else, so the id cannot be allowed to drift between the two. */
export const QWEN_9B = LOCAL_QWEN_9B
export const QWEN_35B = LOCAL_QWEN_35B
export const ORNITH_9B = LOCAL_ORNITH_9B
export const DOLPHIN_X1_8B = LOCAL_DOLPHIN_X1_8B

/** Upstream facts pinned at review time (Hugging Face model API, blobs=true). A download that
 *  does not match these bytes is rejected: a repository that later serves different content
 *  under the same filename is exactly the supply-chain case this guards against. */
export const PINNED_MODELS: Record<string, Array<Omit<LocalModelConfig, 'port' | 'contextTokens' | 'gpuLayers' | 'extraArgs'>>> = {
  [ORNITH_9B]: [
    { id: ORNITH_9B, label: 'Ornith 1.5 9B (local)', repo: 'ornith-ai/Ornith-1.5-9B-GGUF', revision: 'abdd624b12ebf020b767fff532ff44fe552b28c3', file: 'Ornith-1.5-9B-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 5780090816, sha256: '70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6' }
  ],
  [QWEN_9B]: [
    { id: QWEN_9B, label: 'Qwen3.5 9B (local)', repo: 'lmstudio-community/Qwen3.5-9B-GGUF', revision: '1379f25c6b505a3fc737bd7818cb09389cf807c1', file: 'Qwen3.5-9B-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 5627044256, sha256: 'cd76ec205963b3b33350093e6904d9de16c4e666fd104e1f632d25c7f15f2a13' },
    { id: QWEN_9B, label: 'Qwen3.5 9B (local)', repo: 'lmstudio-community/Qwen3.5-9B-GGUF', revision: '1379f25c6b505a3fc737bd7818cb09389cf807c1', file: 'Qwen3.5-9B-Q6_K.gguf', quant: 'Q6_K', sizeBytes: 7359259040, sha256: 'b2ccc477f0a2449de299bef560b63e498cae94a2f3a3bae13df01168d77773e6' }
  ],
  [QWEN_35B]: [
    { id: QWEN_35B, label: 'Qwen3.6 35B-A3B (local)', repo: 'ggml-org/Qwen3.6-35B-A3B-GGUF', revision: 'baec3ebee244827cda0f4557eafa8b28f7545fa6', file: 'Qwen3.6-35B-A3B-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 20419565568, sha256: '671e47e0ec53c665d048b98c3ecbfd5236b5ca9c3e02ed19fc8f81f7b85140c7' }
  ],
  // Uncensored by fine-tuning (dphn, the Dolphin lab), not by abliteration; first-party GGUF.
  // Llama 3.1 8B caches every layer, so Q4_K_M rather than Q5 keeps 32k inside the VRAM envelope.
  // Reviewed in docs/local-model-dolphin-x1-8b.md.
  [DOLPHIN_X1_8B]: [
    { id: DOLPHIN_X1_8B, label: 'Dolphin X1 8B (local)', repo: 'dphn/Dolphin-X1-8B-GGUF', revision: 'e9a40049775e918557e2ee8f8165a059bd10b85a', file: 'Dolphin-X1-8B-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 4920738784, sha256: '90b091874cdfe3fa924302067b71f93a277dc6b99f839cf5569c5bc364d27d9d' }
  ]
}

/** Defaults for MAIN: 12 GB VRAM, 63 GB RAM, one server at a time. Admission checks
 * full GGUF residency, context/KV growth, offload and desktop reserves before spawning.
 * The 35B MoE keeps most weights in RAM; its active parameter count is not its size. */
export const DEFAULT_CONTEXT_TOKENS = 32768
export const DEFAULT_PORTS: Record<string, number> = { [ORNITH_9B]: 51435, [QWEN_9B]: 51437, [QWEN_35B]: 51436, [DOLPHIN_X1_8B]: 51438 }
export const DEFAULT_GPU_LAYERS: Record<string, number> = { [ORNITH_9B]: 999, [QWEN_9B]: 999, [QWEN_35B]: 10, [DOLPHIN_X1_8B]: 999 }

export const DEFAULT_SANDBOX: SandboxConfig = {
  image: 'conductor-local-sandbox:1',
  memory: '4g',
  cpus: '4',
  pids: 256,
  timeoutSec: 120,
  maxOutputBytes: 262144,
  tmpfsSizeMb: 512
}

/** Everything sizeable lives under the one configured local root (see paths.ts): GGUFs, staged
 *  downloads, caches, runtime state, logs, config and agent workspaces. No drive letter is
 *  hardcoded anywhere else, and none of it is ever recreated on the system drive. */
export const localModelsRoot = (): string => localRoot()

export const configPath = (): string => join(layout().config, 'config.json')
export const apiKeyPath = (): string => join(layout().config, 'api-key')
export const provenancePath = (): string => join(layout().config, 'provenance.json')
export const modelsDir = (): string => layout().models
export const runDir = (): string => layout().runtime
export const logsDir = (): string => layout().logs
export const tempDir = (): string => layout().temp

/** Path to the JSON run record for a model. Shared between llama.ts, which writes it, and
 *  `endpointFor` below, which reads the port back out: a server that moved to a free port or was
 *  adopted from an earlier run is still reachable only because both sides agree on this path. */
export const runFile = (model: LocalModelConfig): string => join(runDir(), model.id.replace(/[^a-z0-9.-]/gi, '_') + '.json')

export function ensureDirectories(): void {
  assertLocalRootUsable()
}

/** A random key generated once and kept out of the repository. The servers are bound to
 *  127.0.0.1 as well, but the key means another local process cannot drive the models just by
 *  finding the port. */
export function ensureApiKey(): string {
  ensureDirectories()
  const path = apiKeyPath()
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing.length >= 32) return existing
  }
  const key = randomBytes(32).toString('hex')
  writeFileSync(path, key + '\n', { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* Windows ACLs already limit this to the user profile. */ }
  return key
}

export function readApiKey(): string {
  const path = apiKeyPath()
  if (!existsSync(path)) throw new Error('Local model API key missing; run scripts/local-models/setup.ps1')
  const key = readFileSync(path, 'utf8').trim()
  if (key.length < 32) throw new Error('Local model API key is malformed; delete the api-key file under the local root config directory and run setup again')
  return key
}

const PORT_MIN = 1024
const PORT_MAX = 65535

/** Every structured value that reaches a process argument is validated here rather than
 *  trusted: model ids, ports, quantizations and image references are all reachable through a
 *  config file that an agent with workspace write access could have edited. */
export function validateConfig(config: LocalStackConfig): LocalStackConfig {
  if (!config || config.version !== 1) throw new Error('Unsupported local model config version')
  if (typeof config.llamaServer !== 'string' || !config.llamaServer.trim()) throw new Error('config.llamaServer is required')
  const ports = new Set<number>()
  for (const [id, model] of Object.entries(config.models ?? {})) {
    if (!/^local\/[a-z0-9][a-z0-9._-]{0,48}$/.test(id) || id !== model.id) throw new Error(`Invalid local model id: ${id}`)
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model.repo)) throw new Error(`Invalid model repository for ${id}`)
    if (!/^[A-Za-z0-9._-]+\.gguf$/.test(model.file)) throw new Error(`Invalid GGUF filename for ${id}`)
    if (!/^[a-f0-9]{64}$/i.test(model.sha256)) throw new Error(`Invalid SHA256 for ${id}`)
    if (!Number.isInteger(model.port) || model.port < PORT_MIN || model.port > PORT_MAX) throw new Error(`Invalid port for ${id}`)
    if (ports.has(model.port)) throw new Error(`Duplicate port ${model.port}`)
    ports.add(model.port)
    if (!Number.isInteger(model.contextTokens) || model.contextTokens < 2048 || model.contextTokens > 262144) throw new Error(`Invalid context size for ${id}`)
    if (!Number.isInteger(model.gpuLayers) || model.gpuLayers < 0 || model.gpuLayers > 999) throw new Error(`Invalid gpuLayers for ${id}`)
    if (!Array.isArray(model.extraArgs) || model.extraArgs.some(arg => typeof arg !== 'string')) throw new Error(`Invalid extraArgs for ${id}`)
    if (model.kvCacheType !== undefined && !(KV_CACHE_TYPES as readonly string[]).includes(model.kvCacheType)) throw new Error(`Invalid kvCacheType for ${id}; one of ${KV_CACHE_TYPES.join(', ')}`)
    if (model.flashAttention !== undefined && !['auto', 'on', 'off'].includes(model.flashAttention)) throw new Error(`Invalid flashAttention for ${id}; auto, on or off`)
    if (model.kvCacheType && model.kvCacheType !== 'f16' && model.kvCacheType !== 'bf16' && model.flashAttention === 'off') throw new Error(`A quantized KV cache for ${id} needs flash attention; set flashAttention to auto or on`)
  }
  const sandbox = config.sandbox
  if (!sandbox || !/^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/.test(sandbox.image)) throw new Error('Invalid sandbox image reference')
  if (!/^\d+[mg]$/.test(sandbox.memory)) throw new Error('Invalid sandbox memory limit')
  if (!/^\d+(\.\d+)?$/.test(sandbox.cpus)) throw new Error('Invalid sandbox cpu limit')
  if (!Number.isInteger(sandbox.pids) || sandbox.pids < 16 || sandbox.pids > 4096) throw new Error('Invalid sandbox pid limit')
  if (!Number.isInteger(sandbox.timeoutSec) || sandbox.timeoutSec < 1 || sandbox.timeoutSec > 3600) throw new Error('Invalid sandbox command timeout')
  if (!Number.isInteger(sandbox.maxOutputBytes) || sandbox.maxOutputBytes < 1024 || sandbox.maxOutputBytes > 16 * 1024 * 1024) throw new Error('Invalid sandbox output limit')
  if (!Number.isInteger(sandbox.tmpfsSizeMb) || sandbox.tmpfsSizeMb < 16 || sandbox.tmpfsSizeMb > 8192) throw new Error('Invalid sandbox tmpfs size')
  return config
}

export function defaultModelConfig(id: string, quant?: string): LocalModelConfig {
  const options = PINNED_MODELS[id]
  if (!options?.length) throw new Error(`Unknown local model: ${id}`)
  const pinned = quant ? options.find(option => option.quant === quant) : options[0]
  if (!pinned) throw new Error(`Unknown quantization ${quant} for ${id}`)
  return { ...pinned, port: DEFAULT_PORTS[id]!, contextTokens: DEFAULT_CONTEXT_TOKENS, gpuLayers: DEFAULT_GPU_LAYERS[id]!, extraArgs: [] }
}

export function loadConfig(): LocalStackConfig {
  const path = configPath()
  if (!existsSync(path)) throw new Error('Local model stack is not set up; run scripts/local-models/setup.ps1')
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')) as LocalStackConfig)
}

export function saveConfig(config: LocalStackConfig): void {
  ensureDirectories()
  writeFileSync(configPath(), JSON.stringify(validateConfig(config), null, 2) + '\n', 'utf8')
}

/** Directory name for one model under <root>/models, derived from its id. */
export const modelSlug = (id: string): string => id.replace(LOCAL_MODEL_PREFIX, '').replace(/[^a-z0-9._-]/gi, '-')
export const modelDir = (model: LocalModelConfig): string => join(modelsDir(), modelSlug(model.id))
export const modelFilePath = (model: LocalModelConfig): string => join(modelDir(model), model.file)
/** Prefers the port actually recorded for a running server over the configured one: startServer
 *  may have moved to a free port, or adopted an orphaned process, once the configured port turned
 *  out to be unbindable. Falls back to the configured port when there is no run record yet. */
export const endpointFor = (model: LocalModelConfig): string => `http://127.0.0.1:${recordedPort(model)}`

/** The port a running server is actually on: the one `startServer` recorded, not the one the
 *  config asks for. Every client - `endpointFor` and the adapter's health probe alike - has to
 *  ask this rather than `model.port`, or a server that moved is invisible to half the app. */
export function recordedPort(model: LocalModelConfig): number {
  try {
    const record = JSON.parse(readFileSync(runFile(model), 'utf8')) as { port?: unknown }
    return typeof record.port === 'number' && Number.isInteger(record.port) && record.port > 0 ? record.port : model.port
  } catch { return model.port }
}
