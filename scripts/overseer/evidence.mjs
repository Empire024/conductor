import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CHECKOUT, clip, tailFile, writeJsonAtomic } from './util.mjs'

/** Every history event of a conversation, paging with afterSequence until a short page. */
export async function fetchAllHistory(call, agentSessionId, { afterSequence = 0, maxPages = 5000 } = {}) {
  const events = []
  let after = afterSequence
  for (let page = 0; page < maxPages; page++) {
    const batch = await call('agents.history', { agentSessionId, afterSequence: after })
    if (!Array.isArray(batch) || batch.length === 0) break
    events.push(...batch)
    after = batch[batch.length - 1].sequence
    if (batch.length < 100) break
  }
  return events
}

/** The local model data root, resolved like src/main/local-models/paths.ts readPointer(). */
export function localRoot({ env = process.env, checkout = CHECKOUT, home = homedir() } = {}) {
  const configured = env.CONDUCTOR_LOCAL_ROOT?.trim()
  if (configured) return resolve(configured)
  for (const pointer of [join(checkout, '.local-models', 'root.json'), join(home, '.conductor', 'local-root.json')]) {
    if (!existsSync(pointer)) continue
    try {
      const value = JSON.parse(readFileSync(pointer, 'utf8').replace(/^﻿/, ''))
      if (typeof value?.root === 'string' && value.root.trim()) return resolve(value.root.trim())
    } catch { /* corrupt pointer counts as absent */ }
  }
  return null
}

/** Same naming as src/main/local-models/llama.ts logFile(). */
export const serverLogName = modelId => String(modelId).replace(/[^a-z0-9.-]/gi, '_') + '.log'

const time = timestamp => (typeof timestamp === 'string' && timestamp.length >= 19 ? timestamp.slice(11, 19) : String(timestamp ?? ''))
const inline = value => (typeof value === 'string' ? value : JSON.stringify(value ?? null)).replace(/\r?\n/g, '⏎')

/** One line per raw event: time, type and the part a person needs. */
export function timelineLine(event) {
  const data = event.data ?? {}
  const head = `${time(event.timestamp)} #${event.sequence} ${data.type}`
  switch (data.type) {
    case 'tool': return `${head} ${data.name} [${data.status}]${data.exitCode !== undefined ? ` exit=${data.exitCode}` : ''}${data.input !== undefined ? ` in=${clip(inline(data.input), 300)}` : ''}${data.output ? ` out=${clip(inline(data.output), 1200)}` : ''}${data.stderr ? ` err=${clip(inline(data.stderr), 400)}` : ''}`
    case 'text': return `${head} ${data.role}/${data.mode}: ${clip(inline(data.text), 1200)}`
    case 'notice': return `${head}: ${clip(inline(data.message), 600)}${data.payload?.localStop ? ` [stop ${data.payload.localStop.reason}: ${inline(data.payload.localStop.detail)}]` : ''}`
    case 'error': return `${head}${data.code ? ` ${data.code}` : ''}: ${clip(inline(data.message), 1200)}`
    case 'session': return `${head} phase=${data.phase}${data.message ? `: ${clip(inline(data.message), 300)}` : ''}`
    case 'usage': return `${head} in=${data.inputTokens ?? '-'} out=${data.outputTokens ?? '-'} total=${data.totalTokens ?? '-'}`
    case 'changes': return `${head} ${(data.changes ?? []).map(change => change.path).join(', ')}`
    default: return `${head} ${clip(inline(data), 300)}`
  }
}

/**
 * Write one goal run's evidence into `dir`. Returns the file paths, which the fixer prompt cites.
 */
export async function writeEvidence(dir, { status, events, answer, evaluation, modelId, env, checkout }) {
  await mkdir(dir, { recursive: true })
  const files = {
    status: join(dir, 'status.json'),
    events: join(dir, 'events.jsonl'),
    timeline: join(dir, 'timeline.md'),
    answer: join(dir, 'answer.md'),
    evaluation: join(dir, 'evaluation.json')
  }
  await writeJsonAtomic(files.status, status ?? null)
  await writeFile(files.events, (events ?? []).map(event => JSON.stringify(event)).join('\n') + ((events ?? []).length ? '\n' : ''), 'utf8')
  await writeFile(files.timeline, `# Timeline\n\n${(events ?? []).map(event => `- ${timelineLine(event)}`).join('\n')}\n`, 'utf8')
  await writeFile(files.answer, (answer ?? '') + '\n', 'utf8')
  await writeJsonAtomic(files.evaluation, evaluation ?? null)
  if (modelId && String(modelId).startsWith('local/')) {
    const root = localRoot({ env, checkout })
    const tail = root ? await tailFile(join(root, 'logs', serverLogName(modelId)), 200) : null
    if (tail !== null) {
      files.serverLog = join(dir, 'server-log-tail.txt')
      await writeFile(files.serverLog, tail + '\n', 'utf8')
    }
  }
  return files
}
