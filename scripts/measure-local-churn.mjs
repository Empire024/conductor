import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const value = name => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const integer = (name, fallback, min, max) => {
  const parsed = Number(value(name) ?? fallback)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`)
  return parsed
}

const durationSec = integer('duration', 120, 5, 900)
const intervalMs = integer('interval', 1000, 250, 10_000)
const output = resolve(value('out') ?? join('artifacts', 'local-churn', `sample-${Date.now()}.json`))
const label = (value('label') ?? 'local-workload').slice(0, 120)
const localRoot = process.env.CONDUCTOR_LOCAL_ROOT?.trim() || 'D:\\ConductorLocal'

const run = async (file, args, timeout = 5000) => {
  try { return (await execFileAsync(file, args, { windowsHide: true, timeout, maxBuffer: 256 * 1024 })).stdout.trim() }
  catch { return '' }
}

const runRecords = async () => {
  const directory = join(localRoot, 'runtime')
  try {
    const records = []
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await readFile(join(directory, file), 'utf8'))
        if (Number.isInteger(parsed.pid) && parsed.pid > 0) records.push({ pid: parsed.pid, model: String(parsed.model ?? 'unknown') })
      } catch { /* A stale or partial record is omitted, never repaired by a measurement. */ }
    }
    return records
  } catch { return [] }
}

const cpuSnapshot = () => cpus().map(cpu => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, item) => sum + item, 0) }))
const cpuPercent = (before, after) => {
  let idle = 0, total = 0
  for (let index = 0; index < Math.min(before.length, after.length); index++) {
    idle += after[index].idle - before[index].idle
    total += after[index].total - before[index].total
  }
  return total > 0 ? Number(((1 - idle / total) * 100).toFixed(1)) : null
}

const gpuSample = async () => {
  const raw = await run('nvidia-smi.exe', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'])
  if (!raw) return null
  const [utilization, usedMiB, totalMiB] = raw.split(/\r?\n/, 1)[0].split(',').map(item => Number(item.trim()))
  return [utilization, usedMiB, totalMiB].every(Number.isFinite) ? { utilizationPercent: utilization, usedMiB, totalMiB } : null
}

const processSample = async records => {
  if (!records.length) return []
  const ids = records.map(record => record.pid).join(',')
  const command = `$ids=@(${ids}); Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress; exit 0`
  const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
  if (!raw) return records.map(record => ({ ...record, unavailable: true }))
  try {
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    return records.map(record => {
      const found = entries.find(entry => Number(entry.Id) === record.pid)
      return found ? { ...record, cpuSeconds: Number(found.CPU), workingSetMiB: Number((Number(found.WorkingSet64) / 2 ** 20).toFixed(1)) } : { ...record, unavailable: true }
    })
  } catch { return records.map(record => ({ ...record, unavailable: true })) }
}

const records = await runRecords()
const samples = []
let previousCpu = cpuSnapshot()
const startedAt = new Date().toISOString()
const deadline = Date.now() + durationSec * 1000
while (Date.now() < deadline) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs))
  const currentCpu = cpuSnapshot()
  const [gpu, processes] = await Promise.all([gpuSample(), processSample(records)])
  samples.push({
    at: new Date().toISOString(),
    systemCpuPercent: cpuPercent(previousCpu, currentCpu),
    ramUsedMiB: Number(((totalmem() - freemem()) / 2 ** 20).toFixed(1)),
    ramTotalMiB: Number((totalmem() / 2 ** 20).toFixed(1)),
    gpu,
    processes
  })
  previousCpu = currentCpu
}

const finite = values => values.filter(Number.isFinite)
const stats = values => {
  const sorted = finite(values).sort((a, b) => a - b)
  if (!sorted.length) return null
  return { min: sorted[0], max: sorted.at(-1), mean: Number((sorted.reduce((sum, item) => sum + item, 0) / sorted.length).toFixed(1)) }
}
const report = {
  schemaVersion: 1,
  label,
  startedAt,
  finishedAt: new Date().toISOString(),
  durationSec,
  intervalMs,
  sampleCount: samples.length,
  runRecords: records,
  summary: {
    systemCpuPercent: stats(samples.map(sample => sample.systemCpuPercent)),
    ramUsedMiB: stats(samples.map(sample => sample.ramUsedMiB)),
    gpuUtilizationPercent: stats(samples.map(sample => sample.gpu?.utilizationPercent)),
    gpuUsedMiB: stats(samples.map(sample => sample.gpu?.usedMiB))
  },
  samples
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ output, sampleCount: samples.length, summary: report.summary }))
