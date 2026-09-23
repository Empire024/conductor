import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Real Electron main/preload/renderer and the real HTTPS phone listener; only the provider
// process is the synthetic Claude fixture. No model inference happens.
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-smoke-'))
const output = resolve('artifacts/phone-access')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }

/** One HTTPS call with the CA the phone would have installed; `ca` null means "trust nothing yet". */
const call = (origin, path, { method, token, body, ca } = {}) => new Promise((resolve, reject) => {
  method ??= body === undefined ? 'GET' : 'POST'
  const url = new URL(path, origin)
  const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, ...(ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }), headers: { host: url.host, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } resolve({ status: response.statusCode, headers: response.headers, text, json }) })
  })
  req.once('error', reject)
  if (body !== undefined) req.write(JSON.stringify(body))
  req.end()
})
const api = async (origin, path, options) => {
  const reply = await call(origin, path, options)
  assert.equal(reply.status, 200, `${path}: ${reply.text}`)
  return reply.json
}
const until = async (read, predicate, label, timeout = 20000) => {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(value).slice(0, 400))
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

let stream
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  const project = await page.evaluate(() => window.conductor.projects.create('Phone smoke'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Phone smoke' }).click()
  await expect(page.locator('.launcher-grid button').filter({ hasText: 'Claude' })).toBeVisible()

  let desktop = await page.evaluate(() => window.conductor.phone.state())
  assert.equal(desktop.listening, false)
  desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  assert.ok(desktop.caFingerprint && desktop.pushConfigured && desktop.secureStorage)
  const port = new URL(desktop.primaryEndpoint).port
  const origin = `https://127.0.0.1:${port}`
  check('Phone access starts an HTTPS listener from the settings bridge with a certificate authority and push keys')

  // The CA is fetched over the not-yet-trusted connection, as a phone does before installing it,
  // and from then on every call verifies the chain against it.
  const authority = await call(origin, '/ca.crt')
  assert.equal(authority.status, 200)
  assert.equal(authority.headers['content-type'], 'application/x-x509-ca-cert')
  const ca = authority.text
  const shell = await call(origin, '/', { ca })
  assert.equal(shell.status, 200)
  assert.ok(shell.headers['content-security-policy'].includes("script-src 'self'"))
  assert.ok(shell.text.includes('/app.js'))
  for (const asset of ['/app.js', '/app.css', '/sw.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png']) assert.equal((await call(origin, asset, { ca })).status, 200, asset)
  check('The phone app shell, worker, manifest and icons are served over the CA-signed certificate chain')

  desktop = await page.evaluate(() => window.conductor.phone.pair())
  assert.ok(desktop.pairing?.code && desktop.pairing.url.endsWith('#pair=' + desktop.pairing.code))
  assert.equal((await call(origin, '/api/pair', { ca, body: { code: 'AAAA-AAAA', name: 'Nope' } })).status, 403)
  const paired = await api(origin, '/api/pair', { ca, body: { code: desktop.pairing.code, name: 'Smoke phone' } })
  const token = paired.token
  assert.equal(paired.device.name, 'Smoke phone')
  assert.equal((await call(origin, '/api/state', { ca })).status, 401)
  desktop = await page.evaluate(() => window.conductor.phone.state())
  assert.equal(desktop.pairing, null)
  assert.equal(desktop.devices.length, 1)
  check('A pairing code from the desktop is single-use and yields a bearer token the API requires')

  const events = []
  stream = await new Promise((resolve, reject) => {
    const url = new URL('/api/stream', origin)
    const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname, ca, rejectUnauthorized: true, headers: { host: url.host, authorization: 'Bearer ' + token } }, response => {
      let buffer = ''
      response.on('data', chunk => {
        buffer += String(chunk)
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2)
          const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1]
          if (event && data) events.push({ event, data: JSON.parse(data) })
        }
      })
      resolve({ response })
    })
    req.once('error', reject)
    req.end()
  })
  await until(() => events, list => list.some(entry => entry.event === 'state'), 'the first state frame')
  await expect.poll(async () => (await page.evaluate(() => window.conductor.phone.state())).devices[0].connected).toBe(true)
  check('The live stream opens with the current state and the desktop shows the phone as connected')

  const state = await api(origin, '/api/state', { ca, token })
  assert.equal(state.machineName.length > 0, true)
  const phoneProject = state.projects.find(entry => entry.id === project.id)
  assert.ok(phoneProject && phoneProject.workspaces.length === 1)
  const claude = state.providers.find(entry => entry.id === 'claude')
  assert.ok(claude?.available && claude.models.length, 'Claude fixture is available with models')
  assert.ok(state.machines.some(machine => machine.id === phoneProject.machineId && machine.projectIds.includes(project.id)))
  const opened = await api(origin, '/api/tabs/open', { ca, token, body: { projectId: project.id, workspaceId: phoneProject.workspaces[0].id, machineId: phoneProject.machineId, provider: 'claude', model: claude.models[0].id, title: 'Phone task', prompt: 'SYNTHETIC QUESTION from the phone' } })
  assert.ok(opened.sessionId && opened.tabId)
  // The tab is added without stealing the desktop's focus, so it is in the strip but need not be the active pane.
  await expect(page.getByText('Phone task', { exact: true }).first()).toBeVisible()
  await expect(page.locator(`[data-structured-session="${opened.sessionId}"]`)).toBeAttached()
  const asking = await until(() => api(origin, '/api/sessions/' + opened.sessionId, { ca, token }), conversation => conversation.pending.length === 1, 'the fixture question')
  assert.equal(asking.summary.state, 'attention')
  assert.equal(asking.summary.needs, 'question')
  assert.ok(asking.items.some(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text.includes('from the phone')))
  await until(() => events, list => list.some(entry => entry.event === 'notification' && entry.data.kind === 'attention' && entry.data.sessionId === opened.sessionId), 'the attention notification')
  check('Opening a task from the phone creates a visible desktop tab, sends its first message, and a question arrives as an attention notification')

  const question = asking.pending[0]
  const answered = await api(origin, '/api/sessions/' + opened.sessionId + '/respond', { ca, token, body: { requestId: question.id, answers: { [question.questions[0].id]: ['Night'] } } })
  assert.ok(answered.phase)
  const finished = await until(() => api(origin, '/api/sessions/' + opened.sessionId, { ca, token }), conversation => conversation.summary.state === 'done', 'the turn to finish after the answer')
  assert.equal(finished.pending.length, 0)
  await until(() => events, list => list.some(entry => entry.event === 'notification' && entry.data.kind === 'done' && entry.data.sessionId === opened.sessionId), 'the done notification')
  check('Answering the question from the phone resumes the turn, which finishes and is announced as done')

  const sent = await api(origin, '/api/sessions/' + opened.sessionId + '/message', { ca, token, body: { text: 'SYNTHETIC B follow-up from the phone', mode: 'auto' } })
  assert.equal(sent.mode, 'submit')
  const followed = await until(() => api(origin, '/api/sessions/' + opened.sessionId, { ca, token }), conversation => conversation.summary.state === 'done' && conversation.items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text.includes('Synthetic fixture continuation')), 'the follow-up reply')
  assert.ok(followed.summary.lastText.includes('Synthetic fixture continuation'))
  check('A follow-up sent from the phone is submitted as the owner and its reply shows in the trimmed conversation')

  const metrics = await api(origin, '/api/metrics', { ca, token })
  assert.ok(metrics.system.cpuCores > 0 && metrics.system.memoryTotalBytes > 0)
  assert.ok(metrics.runtimes.some(runtime => runtime.id === opened.sessionId && runtime.projectName === 'Phone smoke'))
  const listed = await api(origin, '/api/state', { ca, token })
  assert.ok(listed.sessions.some(session => session.id === opened.sessionId && session.tabId === opened.tabId && session.state === 'done'))
  check('Machine load and runtimes are readable from the phone alongside the session list')

  const revoked = await page.evaluate(id => window.conductor.phone.revoke(id), desktop.devices[0].id)
  assert.equal(revoked.devices.length, 0)
  assert.equal((await call(origin, '/api/me', { ca, token })).status, 401)
  check('Revoking the phone on the desktop closes its access immediately')

  // Settings has a page per section now: the Phone page renders the setup steps with the live
  // listener state.
  await page.locator('button[aria-label="Settings"]').click()
  await page.locator('.settings-nav button').filter({ hasText: /^Phone$/ }).click()
  await expect(page.getByText('Let my phones control this Conductor')).toBeVisible()
  await expect(page.locator('.phone-access-settings')).toContainText('Reachable')
  await expect(page.getByText('No phones paired yet.')).toBeVisible()
  await page.keyboard.press('Escape')
  check('The desktop settings drawer renders the Phone access section with the listener state')

  await page.screenshot({ path: join(output, 'phone-access-desktop.png') })
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw process' }, null, 2))
} finally {
  stream?.response.destroy()
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
