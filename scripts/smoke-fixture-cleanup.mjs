/** Deliberate teardown for isolated Electron smoke profiles. It stops only sessions visible in
 * this fixture app, clears their unsent composer state, answers the application's real close
 * guards with explicit discard/stop choices, and proves the launched child actually exited. */
const bounded = async (promise, timeoutMs, message) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

export async function cleanupFixtureApp(app, report, label = 'fixture cleanup') {
  const cleanup = {
    label, sessions: [], dialogs: [], draftsCleared: 0, childExit: null, forcedExit: null, errors: [],
    dialogPolicy: { unsavedEditors: "Don't Save", runningWork: 'Stop work and quit/restart', fallback: 'Declared default action' }
  }
  report.cleanup ??= []
  report.cleanup.push(cleanup)
  if (!app) return cleanup

  const child = app.process()
  for (const page of app.windows()) {
    if (page.isClosed()) continue
    try {
      const result = await page.evaluate(async () => {
        const ids = [...document.querySelectorAll('[data-structured-session]')].map(element => element.getAttribute('data-structured-session')).filter(Boolean)
        const rows = []
        for (const id of new Set(ids)) {
          try {
            let state = await window.conductor.structured.snapshot(id)
            for (const queued of state.queuedPrompts ?? []) await window.conductor.structured.cancelQueued(id, queued.id)
            if (['starting', 'running', 'waiting_input', 'waiting_approval', 'interrupting'].includes(state.phase)) await window.conductor.structured.interrupt(id, false)
            const until = Date.now() + 5000
            do {
              state = await window.conductor.structured.snapshot(id)
              if (!['starting', 'running', 'waiting_input', 'waiting_approval', 'interrupting'].includes(state.phase)) break
              await new Promise(resolve => setTimeout(resolve, 25))
            } while (Date.now() < until)
            for (const pending of state.pendingSteering ?? []) if (['cancelled', 'uncertain'].includes(pending.status)) await window.conductor.structured.cancelQueued(id, pending.id)
            rows.push({ id, phase: state.phase })
          } catch (error) { rows.push({ id, error: String(error) }) }
        }
        return rows
      })
      cleanup.sessions.push(...result)
      for (const row of result) if (row.error || ['starting', 'running', 'waiting_input', 'waiting_approval', 'interrupting'].includes(row.phase)) cleanup.errors.push(`Session ${row.id} did not stop: ${row.error ?? row.phase}`)
    } catch (error) { cleanup.errors.push('Could not inspect fixture sessions: ' + String(error)) }

    try {
      const composers = page.locator('.structured-agent-pane textarea[aria-label^="Message "]:not(:disabled)')
      for (let index = 0; index < await composers.count(); index += 1) {
        const composer = composers.nth(index)
        if (await composer.inputValue()) { await composer.fill(''); cleanup.draftsCleared++ }
      }
      const remove = page.getByRole('button', { name: /^Remove context / })
      while (await remove.count()) { await remove.first().click(); cleanup.draftsCleared++ }
    } catch (error) { cleanup.errors.push('Could not clear fixture drafts: ' + String(error)) }
  }

  try {
    cleanup.dialogs = await app.evaluate(({ dialog }) => {
      const decisions = []
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        const buttons = Array.isArray(options?.buttons) ? options.buttons : []
        let response = buttons.indexOf("Don't Save")
        if (response < 0) response = buttons.findIndex(button => /^Stop work and (?:quit|restart)$/.test(button))
        if (response < 0) response = options?.defaultId ?? 0
        decisions.push({ title: options?.title ?? '', buttons, response })
        return { response, checkboxChecked: false }
      }
      globalThis.__conductorSmokeCloseDecisions = decisions
      return decisions
    })
  } catch (error) { cleanup.errors.push('Could not install fixture close decisions: ' + String(error)) }

  const exited = new Promise((resolve, reject) => {
    if (child.exitCode !== null) { resolve({ code: child.exitCode, signal: child.signalCode }); return }
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', reject)
  })
  try {
    // Playwright's ElectronApplication.close uses its customClose callback to call app.quit().
    // Invoke that same lifecycle directly so Conductor's real close guards and our deliberate
    // dialog choices run. Bound the evaluation itself: a main-process shutdown defect must be
    // recorded and force-cleaned, never turn fixture cleanup into an unbounded wait.
    try { await bounded(app.evaluate(({ app: electronApp }) => { electronApp.quit() }), 3_000, 'Electron app.quit evaluation timed out') }
    catch (error) {
      // The evaluation transport commonly closes before it can return because quit succeeded.
      if (child.exitCode === null && !/(closed|destroyed|target)/i.test(String(error))) throw error
    }
    cleanup.childExit = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Electron child did not exit after the guarded application quit')), 15_000))])
  } catch (error) {
    cleanup.errors.push(String(error))
    // On Windows, killing Playwright's loader can orphan Electron's Chromium children. Force the
    // isolated Electron main process down first, then use the child handle only as a last guard.
    cleanup.forcedExit = { requested: true }
    await bounded(app.evaluate(({ app: electronApp }) => electronApp.exit(2)), 2_000, 'Electron app.exit evaluation timed out').catch(exitError => { cleanup.forcedExit.evaluateError = String(exitError) })
    if (child.exitCode === null) child.kill()
    try {
      cleanup.childExit = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Electron child survived forced fixture cleanup')), 5_000))])
      cleanup.forcedExit.childExit = cleanup.childExit
    }
    catch (exitError) { cleanup.errors.push(String(exitError)) }
  }
  if (cleanup.errors.length) throw new Error(`${label} failed: ${cleanup.errors.join('; ')}`)
  return cleanup
}

export function combinedSmokeFailure(original, cleanup) {
  if (original && cleanup) return new AggregateError([original, cleanup], 'Smoke assertions and fixture cleanup both failed')
  return original ?? cleanup
}
