// VR8e (verify loop v3): review-cost-bounded after FX37 (91c1175) - A3, A4 and the VR8a regressions.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8e-cost.mjs [--label head|prefix]
// Run it from the worktree of the build under test (verify-kit's BUILD is <repo>/out). The harness is
// VR8a's (scripts/fixtures/approval-review-harness.mjs); the reviewer is synthetic, since whether a
// routine action reaches the reviewer at all does not depend on the reviewer being real.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, loadCheck, poll, record, safeClose, shot, step, watchdog } from './verify-kit.mjs'
import { OWNER, chipText, denyAsOwner, edit, launch, measured, readJournal, setup, snapshot, told, write } from './fixtures/approval-review-harness.mjs'

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'head'
configure({ name: 'vr8e-cost-' + label, output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8e' })
watchdog(19 * 60)
await loadCheck()

const prompts = async ctx => (await ctx.reviewerTurns()).filter(entry => entry.kind === 'prompt')
const routineKeys = profile => readJournal(profile).filter(item => item.coveredBy?.startsWith('routine:')).map(item => item.coveredBy)
const brief = entry => ({ body: entry.body.slice(0, 60), reviews: entry.reviews, outcome: entry.outcome, phase: entry.phase })
/** Asks one request; a request left to the owner is denied so the coworker can go on. */
async function asked(inst, ctx, body) {
  const entry = await measured(ctx, body)
  if (entry.outcome === 'owner') await denyAsOwner(inst, ctx, entry.card, 'VR8e: unblocking the coworker')
  return entry
}

try {
  const inst = await launch('vr8e-' + label, {})
  const ctx = await setup(inst, { ownerMessage: OWNER })
  const readme = join(inst.projectPath, 'README.md')

  step('E1: the first routine action of each class')
  const first = []
  for (const body of ['npm test', edit(readme, 'Teh', 'The'), 'git diff --stat', 'npm run lint']) first.push(await asked(inst, ctx, body))
  const neighbour = await asked(inst, ctx, 'node scripts/check.mjs')
  const e1Keys = routineKeys(inst.profile)
  const wanted = ['routine:npm test', 'routine:edit:workspace', 'routine:git diff', 'routine:npm run lint']
  record('E1-' + label, first.every(entry => entry.reviews === 0 && entry.outcome === 'allowed') && wanted.every(key => e1Keys.includes(key)) && neighbour.reviews === 1 ? 'PASS' : 'FAIL',
    { firstOfClass: first.map(brief), journaledRoutine: e1Keys, neighbourNotRoutine: brief(neighbour) }, 'owner: "how many stronger approval reviews ... stop this LEAK"; routine first-of-class must cost 0 reviews')

  step('E2: a Write into folders that do not exist yet')
  const target = join(inst.projectPath, 'notes', 'deep', 'todo.md')
  const before = (await prompts(ctx)).length
  const created = await asked(inst, ctx, write(target, '# Todo\n'))
  const onDisk = existsSync(target) && readFileSync(target, 'utf8') === '# Todo\n'
  const existing = await asked(inst, ctx, write(join(inst.projectPath, 'scripts', 'new-check.mjs'), 'console.log(1)\n'))
  const e2Keys = routineKeys(inst.profile).length - e1Keys.length
  record('E2-' + label, created.outcome === 'allowed' && created.reviews === 0 && e2Keys >= 1 ? 'PASS' : 'FAIL',
    { newFolders: { ...brief(created), rationale: created.rationale ?? null, onDisk }, existingFolder: brief(existing), newRoutineRecords: e2Keys, reviewsDuring: (await prompts(ctx)).length - before }, 'A4: a new file in a new folder inside the workspace is not paused to the owner')

  step('E3: session rule, not-routine still reviewed, budget, reuse, usage line')
  const repeat = await asked(inst, ctx, 'node scripts/check.mjs --fast')
  const pushBefore = routineKeys(inst.profile).length
  const push = await asked(inst, ctx, 'git push origin main')
  const pushRoutine = routineKeys(inst.profile).length > pushBefore
  let paused, sent = 0
  for (let n = 1; n <= 25 && !paused; n++) {
    const entry = await measured(ctx, `node scripts/s${String(n).padStart(2, '0')}.mjs`)
    sent++
    if (entry.outcome === 'owner') paused = entry
  }
  const all = await prompts(ctx)
  const reviewers = new Set(all.map(entry => entry.pid)).size
  const toldWizard = await poll(() => told(ctx.wizard.id), { timeoutMs: 10_000 }).catch(() => false)
  const toldWorker = await poll(() => told(ctx.coworker), { timeoutMs: 10_000 }).catch(() => false)
  const chip = await chipText(ctx, inst).catch(error => 'no chip: ' + error.message)
  const chipShot = await shot('E3-usage-line-' + label, inst)
  const notice = (await snapshot(ctx.coworker)).items.filter(item => item.data.type === 'notice' && /^Approval reviews:/.test(item.data.message ?? '')).at(-1)?.data.message ?? ''
  const routineCount = Number(/(\d+) routine allowed without review/.exec(notice)?.[1] ?? -1)
  const status = await call('agents.status', { agentSessionId: ctx.coworker }, { inst })
  record('E3-' + label, repeat.reviews === 0 && repeat.outcome === 'allowed' && !pushRoutine && (push.reviews >= 1 || push.outcome === 'owner') && paused && all.length === 20 && paused.phase === 'paused' && /budget/i.test(paused.rationale ?? '') && toldWizard && toldWorker && reviewers <= 2 && /20\/20/.test(chip ?? '') && routineCount >= 6 ? 'PASS' : 'FAIL',
    { sessionRuleRepeat: brief(repeat), push: { ...brief(push), routine: pushRoutine }, newClassesSent: sent, reviewsAtPause: all.length, pausedPhase: paused?.phase, toldWizard, toldWorker, reviewerProcesses: reviewers, chip, notice, routineCount, reviewerUsage: status.usage?.reviewer ?? null },
    `${chipShot}; ${paused?.rationale?.slice(0, 160) ?? 'never paused'}`)
  if (paused) await denyAsOwner(inst, ctx, paused.card, 'VR8e: done')
  await safeClose(inst)
} catch (error) { await failed(error, 'vr8e-' + label) }
await finish()
