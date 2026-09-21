/**
 * What this computer can carry, said once per native runtime.
 *
 * Every project the owner opens shares one machine, and an agent that starts a second local
 * model server or a multi-gigabyte download can stall the whole desktop. The sentence below
 * is derived from the hardware at startup and deliberately free of anything that changes
 * minute to minute (free memory, load), so it can ride in the static part of the briefing
 * without breaking prompt caches. `docs/machine-profile.md` holds the longer version for
 * this repository; this line is what reaches every other project too.
 */
import { execFile } from 'node:child_process'
import { cpus, totalmem } from 'node:os'

export interface MachineFacts {
  threads: number
  ramGb: number
  gpus: Array<{ name: string; vramGb: number }>
}

export const baseMachineFacts = (): MachineFacts => ({ threads: cpus().length, ramGb: Math.round(totalmem() / 2 ** 30), gpus: [] })

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: one GPU per line. */
export const parseGpuInventory = (stdout: string): MachineFacts['gpus'] =>
  stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line => {
    const [name, total] = line.split(',').map(part => part.trim())
    const mib = Number(total)
    return name && Number.isFinite(mib) && mib > 0 ? [{ name, vramGb: Math.round(mib / 1024) }] : []
  })

const queryNvidiaSmi = (): Promise<string> => new Promise((resolve, reject) => {
  execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 6000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))
})

/** RAM and CPU are known at once; the GPU is asked for and simply absent when nvidia-smi is. */
export async function detectMachine(query: () => Promise<string> = queryNvidiaSmi): Promise<MachineFacts> {
  const base = baseMachineFacts()
  try { return { ...base, gpus: parseGpuInventory(await query()) } } catch { return base }
}

export const describeMachine = (facts: MachineFacts): string => {
  const gpu = facts.gpus.length ? facts.gpus.map(item => `${item.name} with ${item.vramGb} GB VRAM`).join(' and ') : 'no NVIDIA GPU detected'
  return `Machine limits (this computer, shared by every project open here): ${facts.threads} CPU threads, ${facts.ramGb} GB RAM, ${gpu}. One local model server at a time, and only a model that fits that VRAM; never download model files, install software or start a second model server without the owner; run app smoke tests one at a time.`
}
