// FX36 agent-roster-lists-agents (owner: "Agent roster should contain agents btw ... agents that we're
// using (i meant in loops etc and like reviewer updater etc loop improver all that we've used even swarm
// controller)"). A parked Conductor (offline provider fixtures) opens a project that holds the roles'
// briefs, shows Orchestration -> Agents, and checks:
//   R1 the roster lists every role in src/shared/agent-roster.ts with its model, mode and brief;
//   R2 Start on "Fixer" with a goal opens a tab on claude / opus[1m] / high / Auto whose first message
//      is the role's brief plus the goal;
//   R3 Start on "Loop improver" without a goal opens it on codex / gpt-6-astra / high / Auto and tells it to
//      read its brief and ask. (A second Claude role cannot follow R2 here: once the offline fixture's
//      Claude runtime reports its models, the Claude catalog holds only its synthetic model. The Ask mode
//      of the Approval reviewer is covered by src/main/agent-roster.test.ts.)
//   node scripts/smoke-lock.mjs -- node scripts/smoke-agent-roster.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, configure, failed, finish, launchParked, openProject, page, poll, record, REPO, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'agent-roster', output: process.env.ROSTER_OUT ?? 'artifacts/verification/fx36-agent-roster' })
watchdog(8 * 60)
// The roles and their briefs, read from the source so the smoke follows the list.
const source = readFileSync(join(REPO, 'src/shared/agent-roster.ts'), 'utf8')
const roles = [...source.matchAll(/name: '([^']+)', role: '([^']+)', provider: '([^']+)', model: '([^']+)'(?:, effort: '([^']+)')?, permission: '([^']+)'[^\n]*\n\s*briefs: \[([^\]]+)\]/g)]
  .map(match => ({ name: match[1], role: match[2], provider: match[3], model: match[4], effort: match[5] ?? null, permission: match[6], briefs: [...match[7].matchAll(/'([^']+)'/g)].map(entry => entry[1]) }))
if (roles.length < 13) throw new Error(`parsed only ${roles.length} roles from agent-roster.ts`)
const files = Object.fromEntries(roles.flatMap(role => role.briefs).map(path => [path, `# ${path}\n`]))

let inst
try {
  inst = await launchParked({ mode: 'playwright', name: 'agent-roster' })
  const project = await openProject({ name: 'Roster project', files }, inst)
  const view = await page(inst)
  const projection = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id)?.projection_json ?? 'null') } finally { db.close() } }

  // Opening a started role's tab brings that tab to the front and closes the utility panel, so the
  // Agents panel is opened again before each Start.
  const openAgents = async () => {
    await view.evaluate(() => localStorage.setItem('conductor.utilityPanel', 'agents'))
    await view.reload()
    await view.waitForFunction(() => Boolean(window.conductor))
    await view.locator('.project-row').filter({ hasText: 'Roster project' }).first().click()
    await view.locator('.orchestration-agent-card').first().waitFor({ timeout: 30_000 })
  }
  step('R1: Orchestration -> Agents lists the roles')
  await openAgents()
  const cards = await view.locator('.orchestration-agent-card').evaluateAll(nodes => nodes.map(node => ({ role: node.getAttribute('data-role'), text: node.textContent ?? '' })))
  const missing = roles.filter(role => !cards.some(card => card.role === role.role && card.text.includes(role.name) && card.text.includes(role.model) && card.text.includes(role.briefs[0])))
  await sleep(1500)
  console.log('start button: ' + JSON.stringify(await view.locator('.orchestration-start-agent').first().evaluate(node => { const style = getComputedStyle(node); const name = getComputedStyle(node.parentElement.querySelector('strong')); return { font: style.fontSize, height: node.getBoundingClientRect().height, nameFont: name.fontSize, opacity: getComputedStyle(node.closest('.orchestration-hub')).opacity } })))
  const r1Shot = await shot('r1-roster', inst)
  record('R1-roster-lists-roles', missing.length === 0 && cards.some(card => card.role === 'auto-fixer') ? 'PASS' : 'FAIL', { roles: roles.length, cards: cards.length, missing: missing.map(role => role.role).join(',') || 'none' }, `${cards.map(card => card.role).join(', ')}; ${r1Shot}`)

  const start = async (roleId, goal) => {
    if (!await view.locator('.orchestration-agent-card').first().isVisible().catch(() => false)) await openAgents()
    const card = view.locator(`.orchestration-agent-card[data-role="${roleId}"]`)
    await card.locator('button.orchestration-start-agent').click()
    const before = new Set((await call('tabs.list', {}, { inst })).map(tab => tab.id))
    if (goal) await card.getByRole('textbox').fill(goal)
    await card.locator('.orchestration-agent-start button').click()
    const tab = await poll(async () => (await call('tabs.list', {}, { inst })).find(entry => !before.has(entry.id) && entry.kind === 'agent') ?? null, { timeoutMs: 30_000, label: `${roleId} tab` }).catch(async error => { const shown = await view.locator('.orchestration-error').textContent().catch(() => null); await shot(`${roleId}-no-tab`, inst); throw new Error(`${error.message}; roster error: ${shown}`) })
    const prompt = await poll(() => (projection(tab.resourceId)?.items ?? []).map(item => item.data).find(item => item?.type === 'text' && item.role === 'user')?.text ?? null, { timeoutMs: 30_000, label: `${roleId} first message` })
    const settings = projection(tab.resourceId)?.settings ?? {}
    return { tab, prompt, settings }
  }

  step('R2: Start the Fixer with a goal')
  const fixer = roles.find(role => role.role === 'swarm-fixer')
  const goal = 'FX36 smoke goal: report the roster you started from'
  const r2 = await start('swarm-fixer', goal)
  const r2Pass = r2.tab.title === fixer.name && r2.tab.state?.provider === 'claude' && r2.settings.model === fixer.model && r2.settings.effort === fixer.effort && r2.settings.permission === fixer.permission && r2.prompt.includes('docs/swarm/worker-rules.md') && r2.prompt.includes(`Goal: ${goal}`)
  const r2Shot = await shot('r2-fixer-started', inst)
  record('R2-start-fixer', r2Pass ? 'PASS' : 'FAIL', { title: r2.tab.title, provider: r2.tab.state?.provider ?? null, tabModel: r2.tab.state?.model ?? null, model: r2.settings.model ?? null, effort: r2.settings.effort ?? null, permission: r2.settings.permission ?? null }, `first message: "${r2.prompt.replace(/\s+/g, ' ').slice(0, 300)}"; ${r2Shot}`)

  step('R3: Start the Loop improver without a goal')
  const improver = roles.find(role => role.role === 'loop-improver')
  const r3 = await start('loop-improver', '')
  const r3Pass = r3.tab.state?.provider === improver.provider && r3.settings.model === improver.model && r3.settings.effort === improver.effort && r3.settings.permission === improver.permission && r3.prompt.includes('docs/logic-loops.md') && /ask the owner in one short question/.test(r3.prompt)
  const r3Shot = await shot('r3-loop-improver-started', inst)
  record('R3-start-loop-improver', r3Pass ? 'PASS' : 'FAIL', { title: r3.tab.title, provider: r3.tab.state?.provider ?? null, model: r3.settings.model ?? null, effort: r3.settings.effort ?? null, permission: r3.settings.permission ?? null }, `first message: "${r3.prompt.replace(/\s+/g, ' ').slice(0, 300)}"; project ${project.id}; ${r3Shot}`)
} catch (error) { await failed(error, 'agent-roster') }
await finish()
