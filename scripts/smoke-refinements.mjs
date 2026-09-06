import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const port = Number(process.argv[2] || 9360)
const output = resolve(process.argv[3] || 'artifacts/refinements-smoke.png')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
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
let id = 0
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
})
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const callId = ++id
  pending.set(callId, { resolve: resolveCall, reject })
  socket.send(JSON.stringify({ id: callId, method, params }))
})
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result.value
}
await call('Runtime.enable')
await call('Page.enable')
await delay(600)

await evaluate("if (!document.querySelector('.file-menu')) document.querySelector('.titlebar-brand')?.click()")
await delay(100)
const fileMenu = await evaluate(`(() => {
  const menu = document.querySelector('.file-menu')
  return { open: Boolean(menu), labels: [...(menu?.querySelectorAll('button') ?? [])].map((button) => button.innerText), brand: document.querySelector('.titlebar-brand')?.outerHTML, body: document.body.innerText.slice(0, 300) }
})()`)
if (!fileMenu.open || !fileMenu.labels.some((label) => label.includes('New workspace')) || !fileMenu.labels.some((label) => label.includes('New runtime tab'))) {
  throw new Error(`Conductor File menu was incomplete: ${JSON.stringify(fileMenu)}`)
}
await evaluate("document.querySelector('.titlebar-brand')?.click()")

const agentControls = await evaluate(`(() => {
  const model = document.querySelector('.agent-prompt-model select')
  const effort = document.querySelector('.agent-prompt-effort input[type="range"]')
  return { modelTag: model?.tagName, models: model?.options.length ?? 0, effortTag: effort?.tagName, efforts: Number(effort?.max ?? -1) + 1 }
})()`)
if (agentControls.modelTag !== 'SELECT' || agentControls.models < 2 || agentControls.effortTag !== 'INPUT' || agentControls.efforts < 2) {
  throw new Error(`Model selector/effort slider were not populated: ${JSON.stringify(agentControls)}`)
}

const preserved = await evaluate(`(() => {
  const textarea = document.querySelector('.agent-prompt textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(textarea, 'preserve this draft')
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelectorAll('.agent-view-switch button')[1]?.click()
  document.querySelectorAll('.agent-view-switch button')[0]?.click()
  return { value: document.querySelector('.agent-prompt textarea')?.value, conversation: Boolean(document.querySelector('.agent-conversation')) }
})()`)
if (preserved.value !== 'preserve this draft' || !preserved.conversation) throw new Error(`Chat state was discarded: ${JSON.stringify(preserved)}`)

await evaluate("document.querySelector('.agent-mode-button')?.click()")
await delay(80)
await evaluate(`[...document.querySelectorAll('.agent-mode-menu button')].find((button) => button.querySelector('strong')?.textContent === 'Plan')?.click()`)
await delay(80)
const rememberedMode = await evaluate(`(() => {
  const preference = Object.entries(localStorage).find(([key]) => key.startsWith('conductor.agentPromptMode.provider.'))
  return preference ? { key: preference[0], value: preference[1] } : null
})()`)
if (!rememberedMode || rememberedMode.value !== 'plan') throw new Error(`Agent mode was not saved per provider: ${JSON.stringify(rememberedMode)}`)
const providerLabel = ({ codex: 'Codex', claude: 'Claude Code', qwen: 'Qwen Code', kimi: 'Kimi Code', gemini: 'Gemini CLI' })[rememberedMode.key.split('.').at(-1)]
await evaluate("document.querySelector('.pane-group.focused .pane-add-tab')?.click()")
await delay(80)
await evaluate(`(() => {
  const label = ${JSON.stringify(providerLabel)}
  ;[...document.querySelectorAll('.pane-group.focused .launcher-grid button')]
    .find((button) => button.querySelector('strong')?.textContent === label)?.click()
})()`)
await delay(400)
const inheritedMode = await evaluate("document.querySelector('.pane-group.focused .agent-mode-button span')?.textContent")
if (inheritedMode !== 'Plan') throw new Error(`A new ${providerLabel} tab did not inherit Plan mode: ${JSON.stringify(inheritedMode)}`)

await evaluate("if (!document.querySelector('.pane-context-menu')) document.querySelector('.pane-group.focused .pane-menu-button')?.click()")
await delay(80)
const paneMenuStyle = await evaluate(`(() => {
  const menu = document.querySelector('.pane-context-menu')
  const style = menu && getComputedStyle(menu)
  const button = menu?.querySelector('button')
  const buttonStyle = button && getComputedStyle(button)
  return style && buttonStyle ? { background: style.backgroundColor, radius: style.borderRadius, width: style.width, buttonHeight: Math.round(parseFloat(buttonStyle.height)) } : null
})()`)
await evaluate("document.querySelector('.main-stage')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))")
await delay(80)
await evaluate("if (!document.querySelector('.runtime-action-menu')) document.querySelector('.pane-group.focused .runtime-menu-button')?.click()")
await delay(80)
const runtimeMenuStyle = await evaluate(`(() => {
  const menu = document.querySelector('.runtime-action-menu')
  const style = menu && getComputedStyle(menu)
  const button = menu?.querySelector('button')
  const buttonStyle = button && getComputedStyle(button)
  return style && buttonStyle ? { background: style.backgroundColor, radius: style.borderRadius, width: style.width, buttonHeight: Math.round(parseFloat(buttonStyle.height)) } : null
})()`)
if (!paneMenuStyle || !runtimeMenuStyle || JSON.stringify(paneMenuStyle) !== JSON.stringify(runtimeMenuStyle)) {
  throw new Error(`Pane dropdowns do not share one style: ${JSON.stringify({ paneMenuStyle, runtimeMenuStyle })}`)
}
await evaluate("document.querySelector('.pane-group.focused .runtime-menu-button')?.click()")

await evaluate(`(() => {
  if (!document.querySelector('.pane-tab.active .tab-limit-continuation')) {
    document.querySelector('.continuation-toggle')?.click()
  }
})()`)
await delay(120)
if (!await evaluate("Boolean(document.querySelector('.pane-tab.active .tab-limit-continuation'))")) throw new Error('Limit continuation icon was not visible on the agent tab')

await evaluate("document.querySelector('.activity-rail button[aria-label=\"Workspace\"]')?.click()")
await delay(120)
const projectBefore = await evaluate(`(() => ({ tree: Boolean(document.querySelector('.session-tree')), active: document.querySelector('.project-row.active')?.textContent }))()`)
if (!projectBefore.tree) throw new Error(`Active project did not begin expanded: ${JSON.stringify(projectBefore)}`)
await evaluate("document.querySelector('.project-row.active')?.click()")
await delay(80)
if (!await evaluate("Boolean(document.querySelector('.session-tree'))")) throw new Error('Clicking the active project name changed its expanded state')
await evaluate("document.querySelector('.project-row-wrap.active .project-toggle')?.click()")
await delay(80)
if (await evaluate("Boolean(document.querySelector('.session-tree'))")) throw new Error('Project chevron did not collapse the active project')
await evaluate("document.querySelector('.project-row.active')?.click()")
await delay(80)
if (await evaluate("Boolean(document.querySelector('.session-tree'))")) throw new Error('Clicking a collapsed active project name reopened it')
await evaluate("document.querySelector('.project-row-wrap.active .project-toggle')?.click()")
await delay(80)
if (!await evaluate("Boolean(document.querySelector('.session-tree'))")) throw new Error('Project chevron did not expand the active project')

await evaluate("if (!document.querySelector('.workspace-utility-drawer')) document.querySelector('.activity-rail button[aria-label=\"Automation\"]')?.click()")
await delay(520)
const utilityStart = await evaluate(`(() => {
  const drawer = document.querySelector('.workspace-utility-drawer')
  const resizer = document.querySelector('.utility-column-resizer')
  const rect = resizer?.getBoundingClientRect()
  return drawer && rect ? { width: drawer.getBoundingClientRect().width, x: rect.left + rect.width / 2, y: rect.top + Math.min(100, rect.height / 2), right: drawer.classList.contains('utility-right') } : null
})()`)
if (!utilityStart) throw new Error('Automation resize gutter was not available')
const utilityEndX = utilityStart.x + (utilityStart.right ? -72 : 72)
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: utilityStart.x, y: utilityStart.y, button: 'left', clickCount: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: utilityEndX, y: utilityStart.y, button: 'left', buttons: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: utilityEndX, y: utilityStart.y, button: 'left', clickCount: 1 })
await delay(120)
const utilityEnd = await evaluate(`(() => ({
  width: document.querySelector('.workspace-utility-drawer')?.getBoundingClientRect().width,
  saved: localStorage.getItem('conductor.utilityWidths')
}))()`)
if (!utilityEnd.width || utilityEnd.width < utilityStart.width + 50 || !utilityEnd.saved) throw new Error(`Automation column did not resize and persist: ${JSON.stringify({ utilityStart, utilityEnd })}`)
await evaluate("document.querySelector('.activity-rail button[aria-label=\"Automation\"]')?.click()")

await evaluate("if (!document.querySelector('.browser-sidebar')) document.querySelector('.statusbar-link')?.click()")
await delay(400)
const browser = await evaluate(`(() => ({
  phone: document.querySelector('.browser-device-presets button.active')?.textContent,
  width: document.querySelector('.browser-device-frame')?.style.width,
  presets: document.querySelectorAll('.browser-device-presets button').length
}))()`)
if (browser.phone !== 'Phone' || browser.width !== '390px' || browser.presets !== 4) throw new Error(`Responsive browser did not open mobile-first: ${JSON.stringify(browser)}`)
await evaluate("[...document.querySelectorAll('.browser-device-presets button')].find((button) => button.textContent === 'Tablet')?.click()")
await delay(200)
if (await evaluate("document.querySelector('.browser-device-frame')?.style.width") !== '820px') throw new Error('Tablet preset did not resize Chromium')

const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
await mkdir(dirname(output), { recursive: true })
await writeFile(output, Buffer.from(screenshot.data, 'base64'))
console.log(JSON.stringify({ fileMenu, agentControls, preserved, rememberedMode, inheritedMode, paneMenuStyle, runtimeMenuStyle, projectBefore, utilityStart, utilityEnd, browser, output }, null, 2))
socket.close()
