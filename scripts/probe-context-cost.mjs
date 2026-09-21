// Live probe: what one Conductor turn costs on real providers. Opens a parked Conductor window
// (CONDUCTOR_TEST_USER_DATA keeps it off every display and out of the taskbar) with a throwaway
// profile, seeds project memories, and for each requested model sends two one-word prompts to a
// fresh tab, reading the provider's own usage report after each. The difference between the two
// turns' first-call context is what a follow-up message costs in that session: the owner's words
// plus whatever Conductor appended. Optionally opens a second tab on the first model to show what
// a new tab costs (cache read versus cache write on its first call).
//
//   node scripts/probe-context-cost.mjs --label=after --models=claude:haiku,codex:gpt-5.6-luna:low --second-tab
//
// This performs real inference on the owner's provider accounts: two tiny turns per model.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const m = /^--([^=]+)(?:=(.*))?$/.exec(arg); return m ? [m[1], m[2] ?? true] : [arg, true] }))
const label = String(args.label ?? 'probe')
const models = String(args.models ?? 'claude:haiku,codex:gpt-5.6-luna:low').split(',').filter(Boolean).map(entry => { const [provider, model, effort] = entry.split(':'); return { provider, model, effort } })
const secondTab = Boolean(args['second-tab'])
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex', local: 'Local' }
const TEXTBOX = { claude: 'Message Claude Code', codex: 'Message Codex', local: 'Message Local model' }
const PROMPTS = ['Reply with exactly the word OK and nothing else.', 'Reply once more with exactly the word OK and nothing else.']
// Eight memories about the size real ones have, all cued to the words of the prompts so recall
// finds them, so the probe measures the memory block as a real session would carry it.
const MEMORIES = Array.from({ length: 8 }, (_, index) => `Probe memory ${index + 1}: when asked to reply with a single word, the reply is the word alone; this project records that answers are checked exactly and that a probe turn must not add prose, headings or explanations around the word it was asked for.`)

const root = await mkdtemp(join(tmpdir(), 'conductor-context-probe-'))
const output = resolve('artifacts/context-cost')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(30000)
const results = []
const snapshot = id => page.evaluate(id => window.conductor.structured.snapshot(id), id)

async function openTab(name, provider) {
  const project = await page.evaluate(name => window.conductor.projects.create(name), name)
  for (const gist of MEMORIES) await page.evaluate(input => window.conductor.memory.remember(input), { projectId: project.id, kind: 'semantic', gist, cues: ['reply', 'word', 'probe', 'exactly'] })
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: PROVIDER_LABEL[provider] }).click()
  const textbox = page.getByRole('textbox', { name: TEXTBOX[provider], exact: true })
  await expect(textbox).toBeEnabled()
  const pane = page.locator('.structured-agent-pane', { has: textbox }).last()
  const id = await pane.getAttribute('data-structured-session')
  if (!id) throw new Error('No structured session for ' + name)
  return { project, id }
}

/** Sends one prompt and waits for the turn to settle; returns the items it produced. */
async function turn(id, prompt, model, effort) {
  const before = await snapshot(id)
  await page.evaluate(async ({ id, prompt, model, effort }) => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, prompt, { ...state.settings, model, ...(effort ? { effort } : {}) }, [])
  }, { id, prompt, model, effort })
  await expect.poll(async () => (await snapshot(id)).phase, { timeout: 300000, intervals: [500, 1000, 2000] }).toMatch(/^(completed|failed|disconnected)$/)
  const after = await snapshot(id)
  // Items are merged by id in the projection: a usage report updated during this turn keeps its
  // original sequence and carries the update in updatedSequence.
  const items = after.items.filter(item => (item.updatedSequence ?? item.sequence) > before.sequence && !item.parentId)
  const usage = items.filter(item => item.data.type === 'usage')
  const message = usage.find(item => item.data.scope === 'message')
  const session = usage.filter(item => item.data.scope === 'session').at(-1)
  const context = [...usage].reverse().find(item => item.data.limits && typeof item.data.limits.contextUsedTokens === 'number')
  const text = items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join('').trim()
  const errors = items.filter(item => item.data.type === 'error').map(item => item.data.message)
  return {
    phase: after.phase, reply: text.slice(0, 80), errors,
    // Claude: the first API call of the turn, so its input is the whole context at that moment.
    firstCall: message ? { context: message.data.inputTokens, cached: message.data.cachedTokens, cacheWrite: message.data.cacheCreationTokens, output: message.data.outputTokens } : undefined,
    // Codex: cumulative thread totals plus the last call's context, from thread/tokenUsage/updated.
    sessionTotals: session ? { input: session.data.inputTokens, cached: session.data.cachedTokens, output: session.data.outputTokens } : undefined,
    contextUsed: context?.data.limits.contextUsedTokens
  }
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  for (const [index, { provider, model, effort }] of models.entries()) {
    const entry = { provider, model, effort, label }
    try {
      const tab = await openTab(`Probe ${label} ${provider} ${model}`, provider)
      entry.turn1 = await turn(tab.id, PROMPTS[0], model, effort)
      entry.turn2 = await turn(tab.id, PROMPTS[1], model, effort)
      const t1 = entry.turn1.firstCall?.context, t2 = entry.turn2.firstCall?.context
      if (t1 !== undefined && t2 !== undefined) entry.followupCost = t2 - t1
      if (entry.turn1.sessionTotals && entry.turn2.sessionTotals) entry.followupInput = entry.turn2.sessionTotals.input - entry.turn1.sessionTotals.input
      if (secondTab && index === 0) {
        const second = await openTab(`Probe ${label} ${provider} ${model} second tab`, provider)
        entry.secondTab = await turn(second.id, PROMPTS[0], model, effort)
      }
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error) }
    results.push(entry)
    console.log(JSON.stringify(entry))
  }
} finally {
  await writeFile(join(output, `${label}.json`), JSON.stringify({ label, generatedAt: new Date().toISOString(), results }, null, 2))
  await app.close().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
console.log(`\nContext cost (${label}):`)
for (const entry of results) {
  if (entry.error) { console.log(`  ${entry.provider}:${entry.model} — ${entry.error}`); continue }
  const fc = t => t.firstCall ? `context ${t.firstCall.context} (cached ${t.firstCall.cached ?? '?'}, written ${t.firstCall.cacheWrite ?? '?'})` : t.contextUsed !== undefined ? `context ${t.contextUsed}` : 'no usage report'
  console.log(`  ${entry.provider}:${entry.model}${entry.effort ? ':' + entry.effort : ''}: turn 1 ${fc(entry.turn1)}; turn 2 ${fc(entry.turn2)}; follow-up cost ${entry.followupCost ?? entry.followupInput ?? '?'} tokens; replies "${entry.turn1.reply}" / "${entry.turn2.reply}"`)
  if (entry.secondTab) console.log(`    second tab, first call: ${fc(entry.secondTab)}`)
}
