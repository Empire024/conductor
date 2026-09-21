import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { freemem } from 'node:os'
import type { LocalModelConfig } from './config.ts'
import { ORNITH_9B, PINNED_MODELS, QWEN_35B, QWEN_9B } from './config.ts'

const GiB = 1024 ** 3
// Machine-wide (not per checkout/root). The OS releases this mutex even on a crash;
// unlike expiring lock files, a slow startup can never have its lock stolen.
export const ADMISSION_PORT = 51434
export async function withAdmissionLock<T>(action: () => Promise<T>, timeoutMs = 310_000, port = ADMISSION_PORT): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const lock = createServer(socket => socket.destroy())
    const acquired = await new Promise<boolean>((resolve, reject) => {
      lock.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(new Error(`Local model admission lock unavailable (${error.code}); no server started`)))
      lock.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true))
    })
    if (acquired) {
      try { return await action() } finally { await new Promise<void>(resolve => lock.close(() => resolve())) }
    }
    if (Date.now() >= deadline) throw new Error('Another local model startup is still in progress (or admission port 51434 is occupied). No second server was started; try again after it finishes.')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export interface ResourceSnapshot { ramFreeBytes: number | null; vramFreeBytes: number | null; detail?: string }
export interface ServerProcess { pid: number; model: string; port?: number }
const exec = (file: string, args: string[]): string => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** Read-only inventory also finds servers with missing records and servers under another root.
 * Command lines may contain keys: return only the model/port/pid, never the raw command. */
export function runningLlamaProcesses(): ServerProcess[] {
  if (process.platform !== 'win32') throw new Error('Cannot verify the machine-wide llama.cpp process inventory on this platform; no server started')
  try {
    const raw = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" -ErrorAction Stop | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"])
    const parsed = JSON.parse(raw || '[]')
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p: { ProcessId: number; CommandLine?: string }) => {
      const command = p.CommandLine ?? ''
      const value = (flag: string): string | undefined => new RegExp(`(?:^|\\s)${flag}(?:=|\\s+)(?:"([^"]+)"|([^\\s]+))`).exec(command)?.slice(1).find(Boolean)
      return { pid: p.ProcessId, model: value('--alias') ?? value('--model|-m') ?? 'unidentified llama.cpp model', port: Number(value('--port')) || undefined }
    })
  } catch { throw new Error('Cannot read the running llama.cpp process inventory; no second server was started. Check process access and retry.') }
}

export function measureResources(): ResourceSnapshot {
  let ramFreeBytes: number | null = null
  try { ramFreeBytes = freemem() } catch { /* fail closed below */ }
  try {
    const rows = exec('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits']).split(/\r?\n/).map(Number)
    // MAIN has one NVIDIA GPU. Multiple GPUs require an explicit placement policy.
    if (rows.length !== 1 || !Number.isFinite(rows[0]) || rows[0]! <= 0) throw new Error('unreadable GPU inventory')
    return { ramFreeBytes, vramFreeBytes: rows[0]! * 1024 ** 2 }
  } catch { return { ramFreeBytes, vramFreeBytes: null, detail: 'NVIDIA free VRAM could not be measured' } }
}

/** Deliberately conservative envelopes from MAIN's machine profile, not active parameter
 * counts: full GGUF residency in RAM, context/KV growth, compute buffers and desktop reserves.
 * These are admission estimates, not assertions about actual allocations. */
export function resourceRequirements(model: LocalModelConfig): { ramBytes: number; vramBytes: number } {
  const pinned = PINNED_MODELS[model.id]?.find(p => p.file === model.file && p.sizeBytes === model.sizeBytes)
  if (!pinned || ![QWEN_9B, QWEN_35B, ORNITH_9B].includes(model.id) || model.extraArgs.length) throw new Error(`No reviewed memory envelope for ${model.id} with these weights/extra arguments; no server started. Review GGUF size, context, offload and runtime buffers first.`)
  // Reviewed hybrid attention geometry (docs/local-model-shortlist.md): the 9B models
  // cache 8 layers × 4 KV heads; the 35B caches 10 × 2. Head size 256, K+V, fp16.
  // Compute/linear-attention buffers remain covered by the separate reserves below.
  const small = model.id !== QWEN_35B
  const kv = model.contextTokens * (small ? 8 * 4 : 10 * 2) * 256 * 2 * 2
  const layers = small ? 32 : 40
  // Partial offload is uneven (especially MoE tensors); add 25% to the layer share.
  const gpuWeights = model.sizeBytes * Math.min(1, model.gpuLayers >= layers ? 1 : 1.25 * model.gpuLayers / layers)
  return { ramBytes: model.sizeBytes + kv + 2 * GiB + 8 * GiB, vramBytes: model.gpuLayers ? gpuWeights + kv + 1.75 * GiB : 0 }
}

export function assertResourceHeadroom(model: LocalModelConfig, measured = measureResources()): void {
  const required = resourceRequirements(model)
  const valid = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0
  if (!valid(measured.ramFreeBytes) || (required.vramBytes > 0 && !valid(measured.vramFreeBytes))) throw new Error(`Cannot verify RAM/VRAM headroom for ${model.id}; no server started. ${measured.detail ?? 'Resource measurements unavailable'}. Close other workloads or restore resource monitoring and retry.`)
  if (measured.ramFreeBytes < required.ramBytes || (required.vramBytes > 0 && measured.vramFreeBytes! < required.vramBytes)) throw new Error(`Not enough memory to safely start ${model.id}: requires ${(required.ramBytes / GiB).toFixed(1)} GiB free RAM and ${(required.vramBytes / GiB).toFixed(1)} GiB free VRAM including reserves; available ${(measured.ramFreeBytes / GiB).toFixed(1)} GiB RAM and ${measured.vramFreeBytes === null ? 'unknown' : (measured.vramFreeBytes / GiB).toFixed(1)} GiB VRAM. No server was stopped or started.`)
}

export function admissionRefusal(requested: string, running: string): Error {
  return new Error(`Cannot start ${requested}: ${running} is already running or starting. This machine allows one llama.cpp server at a time (12 GB VRAM). Use the running model, or stop it explicitly when its work is finished before switching models. Conductor has not stopped it.`)
}
