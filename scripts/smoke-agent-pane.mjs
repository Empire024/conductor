import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const port = Number(process.argv[2] || 9350)
const output = resolve(process.argv[3] || 'artifacts/agent-pane-smoke.png')
const exercise = process.argv.includes('--exercise')
const provider = process.argv.find((argument) => argument.startsWith('--provider='))?.split('=')[1] || 'claude'
const providerLabel = ({ codex: 'Codex', claude: 'Claude Code', qwen: 'Qwen Code', kimi: 'Kimi Code', gemini: 'Gemini CLI' })[provider]
if (!providerLabel) throw new Error(`Unsupported smoke provider: ${provider}`)
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

let targets
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    if (targets?.length) break
  } catch {}
  await delay(250)
}
const target = targets?.find((item) => item.type === 'page' && item.title === 'Conductor')
if (!target) throw new Error('Conductor renderer was not available')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error) request.reject(new Error(message.error.message))
  else request.resolve(message.result)
})
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = ++sequence
  pending.set(id, { resolve: resolveCall, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result.value
}

await call('Runtime.enable')
await call('Page.enable')
await delay(700)

if (process.argv.includes('--inspect-only')) {
  const terminalScreen = await evaluate("[...document.querySelectorAll('.xterm-rows > div')].map((row) => row.textContent).join('\\n').slice(-12000)")
  const visualText = await evaluate("document.querySelector('.agent-conversation')?.innerText || ''")
  console.log(JSON.stringify({ terminalScreen, visualText }, null, 2))
  socket.close()
  process.exit(0)
}

if (!await evaluate("Boolean(document.querySelector('.pane-group'))")) {
  const created = await evaluate(`(() => {
    const button = document.querySelector('.no-workspace-state button') || document.querySelector('[title="Create new project"]')
    if (!button) return { clicked: false, body: document.body.innerText.slice(0, 1200) }
    button.click()
    return { clicked: true }
  })()`)
  if (!created.clicked) throw new Error(`No project control was available: ${created.body}`)
  await delay(800)
  await evaluate(`(() => {
    const input = document.querySelector('.project-rename-input')
    if (input) {
      input.value = 'Agent visual smoke'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })()`)
  await delay(600)
}

if (!await evaluate("Boolean(document.querySelector('.pane-group'))")) {
  await evaluate("document.querySelector('.session-add')?.click()")
  await delay(500)
}
if (await evaluate("Boolean(document.querySelector('.empty-pane-workspace'))")) {
  await evaluate("document.querySelector('.empty-pane-workspace button:not(:disabled)')?.click()")
  await delay(350)
}
if (await evaluate("Boolean(document.querySelector('.launcher-grid'))")) {
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.launcher-grid button')].find((item) => item.textContent.includes(${JSON.stringify(providerLabel)}))
    if (!button) throw new Error(${JSON.stringify(`${providerLabel} launcher was missing`)})
    button.click()
  })()`)
  await delay(1800)
}

const initial = await evaluate(`({
  visual: Boolean(document.querySelector('.agent-conversation')),
  composer: Boolean(document.querySelector('.agent-prompt')),
  switcher: Boolean(document.querySelector('.agent-view-switch')),
  tabClass: document.querySelector('.tab-activity')?.className || '',
  error: document.querySelector('.runtime-error')?.textContent || ''
})`)
if (!initial.visual || !initial.composer || !initial.switcher) throw new Error(`Visual agent pane did not mount: ${JSON.stringify(initial)}`)
await delay(2800)
const idleClass = await evaluate("document.querySelector('.tab-activity')?.className || ''")
if (idleClass.includes('working')) throw new Error(`Idle provider falsely remained active: ${idleClass}`)
const idleOpacity = await evaluate("getComputedStyle(document.querySelector('.tab-activity')).opacity")
if (idleClass.includes('idle') && idleOpacity !== '0') throw new Error(`Idle tab activity mark remained visible: ${idleOpacity}`)

for (let attempt = 0; attempt < 20; attempt += 1) {
  const trustHandled = await evaluate(`(() => {
    const trust = document.querySelector('.agent-question-actions button')
    if (!trust) return false
    trust.click()
    return true
  })()`)
  if (trustHandled) {
    await delay(900)
    break
  }
  await delay(150)
}

let submittedTurn = null
let assistantTurn = null
let blockedByLimit = null
if (exercise) {
  submittedTurn = await evaluate(`(() => {
    const textarea = document.querySelector('.agent-prompt textarea')
    const send = document.querySelector('.agent-send-button')
    if (!textarea || !send) throw new Error('Visual composer controls were missing')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, 'Reply with exactly VISUAL_SMOKE_OK. Do not edit files or run commands.')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    send.click()
    return true
  })()`)
  await delay(900)
  const userTurn = await evaluate("document.querySelector('.agent-turn.user')?.textContent || ''")
  if (!userTurn.includes('VISUAL_SMOKE_OK')) throw new Error(`Submitted user turn was not visually rendered: ${userTurn}`)
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await evaluate(`(() => {
      const trust = document.querySelector('.agent-question-actions button')
      if (trust) trust.click()
      const turns = [...document.querySelectorAll('.agent-turn.assistant')]
      const visualText = document.querySelector('.agent-conversation')?.innerText || ''
      return {
        assistant: turns.at(-1)?.innerText || '',
        limited: visualText.includes('Usage limit reached') ? 'Usage limit reached' : ''
      }
    })()`)
    if (response.assistant.includes('VISUAL_SMOKE_OK')) {
      assistantTurn = response.assistant
      break
    }
    if (response.limited) {
      blockedByLimit = response.limited
      break
    }
    await delay(500)
  }
  if (!assistantTurn && !blockedByLimit) throw new Error('The agent response did not reach the visual conversation within 45 seconds')
}

await evaluate("document.querySelectorAll('.agent-view-switch button')[1]?.click()")
await delay(350)
const cli = await evaluate(`({
  rawVisible: Boolean(document.querySelector('.xterm-host:not(.agent-terminal-hidden)')),
  visualPreserved: Boolean(document.querySelector('.agent-conversation')),
  composerPreserved: Boolean(document.querySelector('.agent-prompt')),
  visualSurfaceHidden: document.querySelector('.agent-visual-surface')?.classList.contains('hidden')
})`)
if (!cli.rawVisible || !cli.visualPreserved || !cli.composerPreserved || !cli.visualSurfaceHidden) throw new Error(`CLI fallback did not preserve Chat state: ${JSON.stringify(cli)}`)

await evaluate("document.querySelectorAll('.agent-view-switch button')[0]?.click()")
await delay(350)
await evaluate("document.querySelector('[title=\"Processes\"]')?.click()")
await delay(1450)
const idleDashboardSpinners = await evaluate("document.querySelectorAll('.process-sections .spin').length")
if (!exercise && idleDashboardSpinners) throw new Error(`The idle process dashboard had ${idleDashboardSpinners} animated loaders`)
await evaluate("document.querySelector('[title=\"Processes\"]')?.click()")
await delay(250)
const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const terminalScreen = await evaluate("[...document.querySelectorAll('.xterm-rows > div')].map((row) => row.textContent).join('\\n').slice(-12000)")
await mkdir(dirname(output), { recursive: true })
await writeFile(output, Buffer.from(screenshot.data, 'base64'))
console.log(JSON.stringify({ provider, initial, idleClass, idleOpacity, submittedTurn, assistantTurn, blockedByLimit, cli, idleDashboardSpinners, terminalScreen, output }, null, 2))
socket.close()
