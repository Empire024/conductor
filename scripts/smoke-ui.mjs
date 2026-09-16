import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const port = Number(process.argv[2] || 9333)
const output = resolve(process.argv[3] || 'artifacts/workspace-smoke.png')
const workspaceRoot = resolve('.')

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
let capturedDragPreview = false

let targets
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    if (targets?.length) break
  } catch {
    await delay(250)
  }
}

const target = targets?.find((item) => item.type === 'page' && item.title === 'Conductor')
if (!target) throw new Error('Conductor renderer was not available through the debug port')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
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
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed')
  }
  return result
}

const evaluateOnTarget = async (debugTarget, expression) => {
  const targetSocket = new WebSocket(debugTarget.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => {
    targetSocket.addEventListener('open', resolveOpen, { once: true })
    targetSocket.addEventListener('error', reject, { once: true })
  })
  const result = await new Promise((resolveResult, reject) => {
    targetSocket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      if (message.error) reject(new Error(message.error.message))
      else resolveResult(message.result)
    })
    targetSocket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    }))
  })
  targetSocket.close()
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}

const pressCtrlW = async () => {
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'w', code: 'KeyW', modifiers: 2, windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', modifiers: 2, windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 })
}

const pressCtrlC = async () => {
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 })
}

const middleClick = async ({ x, y }) => {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'middle', buttons: 4, clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'middle', buttons: 0, clickCount: 1 })
}

await call('Runtime.enable')
await call('Page.enable')
await delay(800)

const managedSettings = await evaluate(`window.conductor.settings.get()`)
if (managedSettings.result.value.projectsRoot.includes('.managed-project-smoke')) {
  await evaluate(`document.querySelector('[title="Create new project"]')?.click()`)
  await delay(650)
  await evaluate(`(() => {
    const input = document.querySelector('.project-rename-input')
    if (!input) throw new Error('New project was not placed into inline rename mode')
    input.focus()
    input.select()
  })()`)
  await call('Input.insertText', { text: 'Smoke Managed' })
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await delay(750)
  const projects = await evaluate(`window.conductor.projects.list()`)
  const created = projects.result.value.find((project) => project.name === 'Smoke Managed')
  if (!created || !created.path.includes('.managed-project-smoke')) {
    throw new Error('Managed project creation did not use the configured projects folder')
  }
  const selectedOriginal = await evaluate(`(() => {
    const project = [...document.querySelectorAll('.project-row')]
      .find((row) => row.getAttribute('title')?.toLowerCase() === ${JSON.stringify(workspaceRoot.toLowerCase())})
    if (!project) return false
    project.click()
    return true
  })()`)
  if (!selectedOriginal.result.value) {
    await evaluate(`window.conductor.files.readForEditor(${JSON.stringify(created.id)}, 'package.json').then(base => window.conductor.files.write(${JSON.stringify(created.id)}, 'package.json', ${JSON.stringify('{\n  "name": "conductor-smoke-fixture"\n}\n')}, base))`)
    await evaluate(`window.conductor.files.readForEditor(${JSON.stringify(created.id)}, 'README.md').then(base => window.conductor.files.write(${JSON.stringify(created.id)}, 'README.md', ${JSON.stringify('# Smoke project\n\nMarkdown preview fixture.\n')}, base))`)
  }
  await delay(500)
}

const clickChoice = async (text) => {
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.launcher-grid button')]
      .find((item) => item.textContent.includes(${JSON.stringify(text)}))
    if (!button) throw new Error('Missing launcher choice: ' + ${JSON.stringify(text)})
    button.click()
    return true
  })()`)
  await delay(450)
}

const splitGroup = async (index, title) => {
  const direct = await evaluate(`(() => {
    const group = document.querySelectorAll('.pane-group')[${index}]
    const button = group?.querySelector(${JSON.stringify(`[title="${title}"]`)})
    if (!group) throw new Error('Missing tab group')
    if (!button) {
      group.querySelector('[title="Tab actions"]')?.click()
      return false
    }
    button.click()
    return true
  })()`)
  if (!direct.result.value) {
    await delay(80)
    await evaluate(`(() => {
      const expected = ${JSON.stringify(title.replace('Split ', 'Split '))}
      const button = [...document.querySelectorAll('.pane-context-menu button')]
        .find((item) => item.textContent.trim().toLowerCase() === expected.toLowerCase())
      if (!button) throw new Error('Missing split action: ' + expected)
      button.click()
    })()`)
  }
  await delay(250)
}

if (!await evaluate(`Boolean(document.querySelector('.project-row'))`).then((result) => result.result.value)) {
  await evaluate(`document.querySelector('.activity-rail button[aria-label="Workspace"]')?.click()`)
  await delay(200)
}
if (!await evaluate(`Boolean(document.querySelector('.project-row'))`).then((result) => result.result.value)) {
  await evaluate(`document.querySelector('[title="Create new project"]')?.click()`)
  await delay(750)
  await evaluate(`(() => {
    const input = document.querySelector('.project-rename-input')
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Workspace smoke')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await delay(650)
}
await evaluate(`(async () => {
  const projects = await window.conductor.projects.list()
  const project = projects.find((item) => item.name === 'Workspace smoke') ?? projects[0]
  if (!project) return
  await window.conductor.files.write(project.id, 'package.json', ${JSON.stringify('{\n  "name": "conductor-smoke-fixture"\n}\n')}, await window.conductor.files.readForEditor(project.id, 'package.json'))
  await window.conductor.files.write(project.id, 'README.md', ${JSON.stringify('# Workspace smoke\n')}, await window.conductor.files.readForEditor(project.id, 'README.md'))
})()`)

const activeWorkspaceAtStart = await evaluate(`Boolean(document.querySelector('.session-tab.active'))`)
if (!activeWorkspaceAtStart.result.value) {
  await evaluate(`(() => {
    const button = document.querySelector('.no-workspace-state button') ?? document.querySelector('.session-add')
    if (!button) throw new Error('No control was available to create a workspace')
    button.click()
  })()`)
  await delay(350)
}

const emptyTabsAtStart = await evaluate(`Boolean(document.querySelector('.empty-pane-workspace'))`)
if (emptyTabsAtStart.result.value) {
  await evaluate(`document.querySelector('.empty-pane-workspace button:not(:disabled)')?.click()`)
  await delay(250)
}

const initial = await evaluate(`document.querySelectorAll('.pane-group').length`)
if (initial.result.value === 1) {
  await clickChoice('Claude Code')
  await splitGroup(0, 'Split right')
  await clickChoice('Codex')
  await splitGroup(1, 'Split below')
  await clickChoice('PowerShell')
  await splitGroup(0, 'Split below')
  await clickChoice('PowerShell')
  await delay(1200)
}

const dragTab = async (sourceTitle, targetTitle, zoneClass) => {
  await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.pane-tab')]
    const source = tabs.find((tab) => tab.textContent.trim().startsWith(${JSON.stringify(sourceTitle)}))
    const target = tabs.find((tab) => tab.textContent.trim().startsWith(${JSON.stringify(targetTitle)}))
    const targetGroup = target?.closest('.pane-group')
    if (!source || !target || !targetGroup) throw new Error('Drag target was not found')
    const transfer = new DataTransfer()
    const sourceRect = source.getBoundingClientRect()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer, clientX: sourceRect.left + 12, clientY: sourceRect.top + 12 }))
    window.__conductorSmokeDrag = {
      source,
      transfer,
      sourceTitle: ${JSON.stringify(sourceTitle)},
      targetTitle: ${JSON.stringify(targetTitle)}
    }
    return true
  })()`)
  await delay(80)
  await evaluate(`(() => {
    const drag = window.__conductorSmokeDrag
    const target = [...document.querySelectorAll('.pane-tab')]
      .find((tab) => tab.textContent.trim().startsWith(drag?.targetTitle ?? ''))
    const targetGroup = target?.closest('.pane-group')
    const zone = targetGroup?.querySelector(${JSON.stringify(zoneClass)})
    if (!drag || !zone) throw new Error('Requested docking option was not available after drag start')
    const zoneRect = zone.getBoundingClientRect()
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: drag.transfer, clientX: zoneRect.left + zoneRect.width / 2, clientY: zoneRect.top + zoneRect.height / 2 }))
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: drag.transfer, clientX: zoneRect.left + zoneRect.width / 2, clientY: zoneRect.top + zoneRect.height / 2 }))
    drag.zone = zone
    return true
  })()`)
  await delay(180)
  const visual = await evaluate(`(() => {
    const drag = window.__conductorSmokeDrag
    const tabs = [...document.querySelectorAll('.pane-tab')]
    const source = tabs.find((tab) => tab.textContent.trim().startsWith(drag?.sourceTitle ?? ''))
    const target = tabs.find((tab) => tab.textContent.trim().startsWith(drag?.targetTitle ?? ''))
    const targetGroup = target?.closest('.pane-group')
    const preview = document.querySelector('.dock-snap-preview')
    const ghost = document.querySelector('.pane-drag-ghost')
    const sourceGroup = source?.closest('.pane-group')
    const sameGroup = sourceGroup === targetGroup
    const hover = Boolean(targetGroup?.matches('.dock-hover'))
    const liveContent = targetGroup?.querySelector(':scope > .pane-content')
    const hoverTransform = liveContent ? getComputedStyle(liveContent).transform : 'none'
    const sourceZoneCount = sourceGroup?.querySelectorAll('.dock-zone').length ?? -1
    const targetZoneCount = targetGroup?.querySelectorAll('.dock-zone').length ?? -1
    if (!drag || !preview || !ghost) return {
      hasDrag: Boolean(drag),
      hasPreview: Boolean(preview),
      hasGhost: Boolean(ghost),
      hover,
      hoverTransform,
      sourceZoneCount,
      targetZoneCount
    }
    const previewRect = preview.getBoundingClientRect()
    return {
      ghostTitle: ghost.textContent,
      previewWidth: previewRect.width,
      targetWidth: targetGroup?.offsetWidth ?? 0,
      hover,
      hoverTransform,
      sourceZoneCount,
      targetZoneCount,
      sameGroup,
      targetHasCenter: Boolean(targetGroup?.querySelector('.dock-center'))
    }
  })()`)
  if (!visual.result.value?.ghostTitle?.includes(sourceTitle)) {
    throw new Error(`Tab drag did not render a visible ghost and snap preview: ${JSON.stringify(visual.result.value)}`)
  }
  if (zoneClass !== '.dock-center' && visual.result.value.previewWidth > visual.result.value.targetWidth * 0.7) {
    throw new Error('Edge docking preview did not show the pane snap size')
  }
  if (!visual.result.value.hover || visual.result.value.hoverTransform === 'none') {
    throw new Error('Dock hover did not live-reflow the destination tab area')
  }
  if (visual.result.value.targetZoneCount === 0 ||
      (!visual.result.value.sameGroup && visual.result.value.sourceZoneCount !== 0) ||
      (visual.result.value.sameGroup && visual.result.value.targetHasCenter)) {
    throw new Error(`Docking exposed invalid drop zones: ${JSON.stringify(visual.result.value)}`)
  }
  if (!capturedDragPreview && zoneClass !== '.dock-center') {
    const previewShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const previewOutput = resolve(dirname(output), 'drag-preview.png')
    await mkdir(dirname(previewOutput), { recursive: true })
    await writeFile(previewOutput, Buffer.from(previewShot.data, 'base64'))
    capturedDragPreview = true
  }
  await evaluate(`(() => {
    const drag = window.__conductorSmokeDrag
    const tabs = [...document.querySelectorAll('.pane-tab')]
    const source = tabs.find((tab) => tab.textContent.trim().startsWith(drag.sourceTitle))
    const target = tabs.find((tab) => tab.textContent.trim().startsWith(drag.targetTitle))
    const zone = target?.closest('.pane-group')?.querySelector(${JSON.stringify(zoneClass)})
    if (!source || !zone) throw new Error('Docking nodes disappeared before drop')
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: drag.transfer }))
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: drag.transfer }))
    delete window.__conductorSmokeDrag
  })()`)
  await delay(45)
  const animatedSnap = await evaluate(`(() => ({
    arrival: Boolean(document.querySelector('.pane-group.snap-arrival')),
    animations: document.getAnimations().length
  }))()`)
  // Existing groups keep the short snap-arrival class; newly-created split
  // groups can be represented entirely by the browser's view transition.
  if (!animatedSnap.result.value.arrival && animatedSnap.result.value.animations === 0) {
    throw new Error(`Docked pane did not animate into its snapped layout: ${JSON.stringify(animatedSnap.result.value)}`)
  }
  await delay(305)
}

await dragTab('Claude', 'Codex', '.dock-center')
const grouped = await evaluate(`(() => ({
  groups: document.querySelectorAll('.pane-group').length,
  maxTabs: Math.max(...[...document.querySelectorAll('.pane-tabs')].map((group) => group.querySelectorAll('.pane-tab').length))
}))()`)
if (grouped.result.value.groups !== 3 || grouped.result.value.maxTabs !== 2) {
  throw new Error(`Center docking failed: ${JSON.stringify(grouped.result.value)}`)
}

await dragTab('Claude', 'Codex', '.dock-right')
const splitBackOut = await evaluate(`document.querySelectorAll('.pane-group').length`)
if (splitBackOut.result.value !== 4) throw new Error('Splitting a grouped tab back out failed')

await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.pane-tab')].find((item) => item.textContent.includes('PowerShell'))
  const header = tab?.closest('.pane-group')?.querySelector('.pane-header')
  if (!header) throw new Error('PowerShell tab header was not found')
  header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
})()`)
await delay(250)
const maximized = await evaluate(`document.querySelectorAll('.pane-group').length`)
if (maximized.result.value !== 1) throw new Error('Tab maximize failed')
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.pane-tab')].find((item) => item.textContent.includes('PowerShell'))
  if (!tab) throw new Error('Maximized PowerShell tab was not found')
  const transfer = new DataTransfer()
  const rect = tab.getBoundingClientRect()
  tab.dispatchEvent(new DragEvent('dragstart', {
    bubbles: true,
    dataTransfer: transfer,
    clientX: rect.left + 12,
    clientY: rect.top + 12,
    screenX: window.screenX + rect.left + 12,
    screenY: window.screenY + rect.top + 12
  }))
  window.__conductorMaximizedDrag = { tab, transfer }
})()`)
await delay(250)
const restored = await evaluate(`(() => ({
  groups: document.querySelectorAll('.pane-group').length,
  maximizedBadge: Boolean(document.querySelector('.maximized-badge')),
  ghost: Boolean(document.querySelector('.pane-drag-ghost'))
}))()`)
if (restored.result.value.groups !== 4 || restored.result.value.maximizedBadge || !restored.result.value.ghost) {
  throw new Error(`Starting a drag did not restore the maximized layout: ${JSON.stringify(restored.result.value)}`)
}
await evaluate(`(() => {
  const drag = window.__conductorMaximizedDrag
  drag.tab.dispatchEvent(new DragEvent('dragend', {
    bubbles: true,
    dataTransfer: drag.transfer,
    screenX: window.screenX + 100,
    screenY: window.screenY + 100
  }))
  delete window.__conductorMaximizedDrag
})()`)
await delay(700)

const claudeBeforeCtrlC = await evaluate(`window.conductor.agents.listProcesses()`)
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.pane-tab')].find((item) => item.textContent.trim().startsWith('Claude'))
  if (!tab) throw new Error('Claude tab was not found')
  tab.click()
  tab.closest('.pane-group')?.querySelector('.xterm-helper-textarea')?.focus()
})()`)
await delay(80)
await pressCtrlC()
await delay(300)
const claudeAfterCtrlC = await evaluate(`(async () => ({
  processes: await window.conductor.agents.listProcesses(),
  hasClaude: [...document.querySelectorAll('.pane-tab')].some((item) => item.textContent.trim().startsWith('Claude'))
}))()`)
const ctrlCAfter = claudeAfterCtrlC.result.value.processes
const ctrlCBeforeProcess = claudeBeforeCtrlC.result.value.find((item) => item.title.includes('Claude'))
const ctrlCAfterProcess = ctrlCAfter.find((item) => item.id === ctrlCBeforeProcess?.id)
if (!claudeAfterCtrlC.result.value.hasClaude ||
    (ctrlCBeforeProcess?.status === 'running' && ['exited', 'error'].includes(ctrlCAfterProcess?.status))) {
  throw new Error(`Ctrl+C disrupted the Claude agent tab: ${JSON.stringify({
    before: ctrlCBeforeProcess,
    after: ctrlCAfterProcess,
    ui: claudeAfterCtrlC.result.value
  })}`)
}

const editorPresent = await evaluate(`Boolean(document.querySelector('.monaco-editor'))`)
if (!editorPresent.result.value) {
  await evaluate(`(() => {
    document.querySelector('.activity-rail button[aria-label="Explorer"]')?.click()
  })()`)
  await delay(900)
  await evaluate(`(() => {
    const file = [...document.querySelectorAll('.explorer-row.file')]
      .find((row) => row.textContent.trim() === 'package.json')
    if (!file) throw new Error('package.json was not visible in Explorer')
    file.click()
  })()`)
  await delay(3500)
}
const hasEditor = await evaluate(`Boolean(document.querySelector('.monaco-editor'))`)
if (!hasEditor.result.value) throw new Error('Monaco editor did not mount')
const editorOutsideTabs = await evaluate(`Boolean(document.querySelector('.workspace-document')) && ![...document.querySelectorAll('.pane-tab')].some((item) => item.textContent.includes('package.json'))`)
if (!editorOutsideTabs.result.value) throw new Error('Project file was incorrectly opened as a runtime tab')

const middleTabPoint = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.pane-tab')]
    .find((item) => item.textContent.includes('PowerShell'))
  if (!tab) throw new Error('PowerShell tab was not found')
  const rect = tab.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})()`)
await middleClick(middleTabPoint.result.value)
await delay(350)
const closedPowerShellCount = await evaluate(`[...document.querySelectorAll('.pane-tab')].filter((item) => item.textContent.includes('PowerShell')).length`)
if (closedPowerShellCount.result.value !== 1) throw new Error('Middle-click did not close the runtime tab')

await evaluate(`(() => {
  document.querySelector('.pane-group .pane-header')
    ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 640, clientY: 360 }))
})()`)
await delay(150)
const contextPosition = await evaluate(`(() => {
  const menu = document.querySelector('.pane-context-menu')
  return menu ? { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top) } : null
})()`)
if (!contextPosition.result.value || Math.abs(contextPosition.result.value.left - 640) > 2) {
  throw new Error('Pane context menu did not open at the pointer')
}
await evaluate(`(() => {
  const action = [...document.querySelectorAll('.pane-context-menu button')]
    .find((button) => button.textContent.includes('Retrieve closed tab'))
  if (!action || action.disabled) throw new Error('Retrieve closed tab action was unavailable')
  action.click()
})()`)
await delay(250)
const retrieved = await evaluate(`[...document.querySelectorAll('.pane-tab')].filter((item) => item.textContent.includes('PowerShell')).length === 2`)
if (!retrieved.result.value) throw new Error('Closed runtime tab was not retrieved')

const gutterBefore = await evaluate(`(() => {
  const gutter = document.querySelector('.split-node.horizontal > .split-gutter')
  const first = gutter?.previousElementSibling
  if (!gutter || !first) return null
  const rect = gutter.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: first.getBoundingClientRect().width }
})()`)
if (!gutterBefore.result.value) throw new Error('Resize gutter was not found')
const point = gutterBefore.result.value
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
for (const offset of [20, 45, 75]) {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + offset, y: point.y, button: 'left', buttons: 1 })
  await delay(30)
}
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 75, y: point.y, button: 'left', clickCount: 1 })
await delay(250)
const gutterAfter = await evaluate(`(() => {
  const gutter = document.querySelector('.split-node.horizontal > .split-gutter')
  return gutter?.previousElementSibling?.getBoundingClientRect().width ?? 0
})()`)
if (Math.abs(gutterAfter.result.value - point.width) < 35) throw new Error('Pointer resizing did not move naturally')

const zoomBefore = await evaluate(`window.conductor.settings.get()`)
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', code: 'Equal', ctrlKey: true, bubbles: true }))`)
await delay(200)
const zoomAfter = await evaluate(`window.conductor.settings.get()`)
if (zoomAfter.result.value.zoomFactor <= zoomBefore.result.value.zoomFactor) throw new Error('Ctrl+Plus did not increase zoom')
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', code: 'Digit0', ctrlKey: true, bubbles: true }))`)
await delay(200)

await evaluate(`document.querySelector('.activity-rail button[aria-label="Settings"]')?.click()`)
await delay(100)
await evaluate(`(() => {
  const select = document.querySelector('.theme-family-select select')
  if (!select) throw new Error('Theme settings were unavailable')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(select, 'obsidian')
  select.dispatchEvent(new Event('change', { bubbles: true }))
})()`)
await delay(100)
await evaluate(`(() => { const auto = document.querySelector('.theme-auto-setting input'); if (auto?.checked) auto.click() })()`)
await delay(100)
await evaluate(`[...document.querySelectorAll('.theme-variant-setting button')].find((item) => item.textContent.includes('Day'))?.click()`)
await delay(250)
const themeApplied = await evaluate(`document.documentElement.dataset.themeId === 'obsidian' && document.documentElement.dataset.themeVariant === 'day' && document.documentElement.dataset.themeAuto === 'false'`)
if (!themeApplied.result.value) throw new Error('Theme family/day variant/Auto state did not apply')
await evaluate(`document.querySelector('.settings-panel > header button')?.click()`)
await delay(100)

await evaluate(`(() => {
  const toggle = document.querySelector('.continuation-toggle')
  if (!toggle) throw new Error('Limit continuation control was unavailable')
  if (toggle.getAttribute('aria-pressed') === 'true') toggle.click()
})()`)
await delay(100)
await evaluate(`document.querySelector('.continuation-toggle')?.click()`)
await delay(60)
const continuationVisual = await evaluate(`(() => ({
  active: document.querySelector('.continuation-toggle')?.getAttribute('aria-pressed') === 'true',
  workspaceBadge: Boolean(document.querySelector('.session-tab.active.limit-active .session-limit-badge')),
  animated: [...document.getAnimations()].some((animation) =>
    ['continuation-clock-on', 'continuation-ripple', 'session-clock-set'].includes(animation.animationName))
}))()`)
if (!continuationVisual.result.value.active || !continuationVisual.result.value.workspaceBadge || !continuationVisual.result.value.animated) {
  throw new Error(`Limit continuation did not animate and mark its workspace: ${JSON.stringify(continuationVisual.result.value)}`)
}
await delay(700)

const codingTabsBeforeUtility = await evaluate(`document.querySelectorAll('.pane-tab').length`)
await evaluate(`document.querySelector('.activity-rail button[aria-label="Memory"]')?.click()`)
await delay(180)
const memoryWorkspaceView = await evaluate(`(() => ({
  drawer: Boolean(document.querySelector('.workspace-utility-drawer .memory-pane')),
  tabs: document.querySelectorAll('.pane-tab').length,
  nonOverlapping: (() => {
    const drawer = document.querySelector('.workspace-utility-drawer')?.getBoundingClientRect()
    const content = document.querySelector('.workspace-content-main')?.getBoundingClientRect()
    return Boolean(drawer && content && (drawer.right <= content.left + 1 || content.right <= drawer.left + 1))
  })()
}))()`)
if (!memoryWorkspaceView.result.value.drawer || !memoryWorkspaceView.result.value.nonOverlapping || memoryWorkspaceView.result.value.tabs !== codingTabsBeforeUtility.result.value) {
  throw new Error('Project memory did not open as a content-space workspace dock')
}
await evaluate(`(() => {
  const drawer = document.querySelector('.workspace-utility-drawer')
  if (drawer?.classList.contains('utility-right')) drawer.querySelector('.utility-header-actions button')?.click()
})()`)
await delay(140)
const memoryMovedLeft = await evaluate(`document.querySelector('.workspace-utility-drawer')?.classList.contains('utility-left')`)
if (!memoryMovedLeft.result.value) throw new Error('Workspace utility drawer could not move to the left side')
await evaluate(`document.querySelector('.activity-rail button[aria-label="Processes"]')?.click()`)
await delay(180)
const processWorkspaceView = await evaluate(`(() => ({
  drawer: Boolean(document.querySelector('.workspace-utility-drawer .process-dashboard')),
  tabs: document.querySelectorAll('.pane-tab').length
}))()`)
if (!processWorkspaceView.result.value.drawer || processWorkspaceView.result.value.tabs !== codingTabsBeforeUtility.result.value) {
  throw new Error('Process dashboard opened as a coding tab instead of a workspace view')
}
const idleProcessSpinner = await evaluate(`(() => {
  const heading = [...document.querySelectorAll('.process-sections h3')].find((item) => item.textContent.includes('In progress'))
  const count = Number(heading?.querySelector('span')?.textContent ?? 0)
  return { count, spinning: Boolean(heading?.querySelector('.spin')) }
})()`)
if (idleProcessSpinner.result.value.count === 0 && idleProcessSpinner.result.value.spinning) throw new Error('In Progress spinner moved with zero active processes')
await evaluate(`document.querySelector('.workspace-utility-drawer .utility-header-actions button:last-child')?.click()`)
await delay(120)

const workspaceSidebarInitiallyOpen = await evaluate(`Boolean(document.querySelector('aside.sidebar'))`)
if (!workspaceSidebarInitiallyOpen.result.value) await evaluate(`document.querySelector('.activity-rail button[aria-label="Workspace"]')?.click()`)
await delay(100)
await evaluate(`document.querySelector('.activity-rail button[aria-label="Workspace"]')?.click()`)
await delay(120)
const workspaceHidden = await evaluate(`!document.querySelector('aside.sidebar') && Boolean(document.querySelector('.activity-rail'))`)
if (!workspaceHidden.result.value) throw new Error('Clicking the active Workspace control did not hide its sidebar')
await evaluate(`document.querySelector('.activity-rail button[aria-label="Workspace"]')?.click()`)
await delay(140)
const workspaceReopened = await evaluate(`Boolean(document.querySelector('aside.sidebar'))`)
if (!workspaceReopened.result.value) throw new Error('Workspace control did not reopen its sidebar')

await evaluate(`document.querySelector('.activity-rail button[aria-label="Explorer"]')?.click()`)
await delay(500)
const explorerReady = await evaluate(`Boolean(document.querySelector('.explorer-sidebar .explorer-tree'))`)
if (!explorerReady.result.value) throw new Error('Explorer did not replace the workspace sidebar')
await evaluate(`(() => {
  const readme = [...document.querySelectorAll('.explorer-row.file')].find((item) => item.textContent.trim() === 'README.md')
  if (!readme) throw new Error('Explorer did not show README.md')
  readme.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 270, clientY: 240 }))
})()`)
await delay(100)
await evaluate(`(() => {
  const preview = [...document.querySelectorAll('.explorer-context-menu button')].find((item) => item.textContent.includes('Preview'))
  if (!preview) throw new Error('Markdown preview action was unavailable')
  preview.click()
})()`)
await delay(400)
const previewReady = await evaluate(`Boolean(document.querySelector('.file-preview-pane .markdown-document'))`)
if (!previewReady.result.value) throw new Error('Markdown did not open in the in-app previewer')

await evaluate(`document.querySelector('.statusbar-link')?.click()`)
await delay(400)
const chromiumReady = await evaluate(`Boolean(document.querySelector('.browser-sidebar webview.chromium-webview'))`)
if (!chromiumReady.result.value) throw new Error('Browser sidebar did not mount a Chromium webview')
await evaluate(`document.querySelector('.activity-rail button[aria-label="Workspace"]')?.click()`)
await delay(150)

const tabsBeforeDetach = await evaluate(`document.querySelectorAll('.pane-tab').length`)
const processesBeforeDetach = await evaluate(`window.conductor.agents.listProcesses()`)
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.pane-tab')].find((item) => item.textContent.trim().startsWith('Claude'))
  const header = tab?.closest('.pane-group')?.querySelector('.pane-header')
  if (!header) throw new Error('Claude header was unavailable for detach')
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 720, clientY: 260 }))
})()`)
await delay(100)
await evaluate(`(() => {
  const action = [...document.querySelectorAll('.pane-context-menu button')]
    .find((button) => button.textContent.includes('Open as window'))
  if (!action) throw new Error('Open as window action was unavailable')
  action.click()
})()`)
await delay(900)
const detachedTargets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
const detachedTarget = detachedTargets.find((item) => item.type === 'page' && item.url.includes('detached='))
if (!detachedTarget) throw new Error('Detaching a tab did not create a separate Electron window')
const detachedState = await evaluateOnTarget(detachedTarget, `(() => ({
  shell: Boolean(document.querySelector('.detached-shell')),
  rail: Boolean(document.querySelector('.detached-activity-rail')),
  sidebar: Boolean(document.querySelector('.detached-context-sidebar')),
  tabs: document.querySelectorAll('.pane-tab').length
}))()`)
if (!detachedState.shell || !detachedState.rail || detachedState.sidebar || detachedState.tabs !== 1) {
  throw new Error(`Detached window did not start with only its slim session menu: ${JSON.stringify(detachedState)}`)
}
await evaluateOnTarget(detachedTarget, `document.querySelector('[aria-label="Workspace"]')?.click(); true`)
await delay(180)
const openedDetachedSidebar = await evaluateOnTarget(detachedTarget, `Boolean(document.querySelector('.detached-context-sidebar'))`)
if (!openedDetachedSidebar) throw new Error('Detached session sidebar could not be reopened')
await evaluateOnTarget(detachedTarget, `document.querySelector('[aria-label="Workspace"]')?.click(); true`)
await delay(100)
const closedDetachedSidebar = await evaluateOnTarget(detachedTarget, `!document.querySelector('.detached-context-sidebar')`)
if (!closedDetachedSidebar) throw new Error('Workspace control did not hide the secondary window sidebar')
const processesAfterDetach = await evaluate(`window.conductor.agents.listProcesses()`)
if (processesAfterDetach.result.value.length !== processesBeforeDetach.result.value.length) {
  throw new Error('Detaching duplicated or disposed a live runtime')
}
await evaluateOnTarget(detachedTarget, `window.conductor.window.close(); true`)
await delay(650)
await evaluate(`(() => {
  const header = document.querySelector('.pane-header')
  if (!header) throw new Error('No coding tab area remained after detach')
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 720, clientY: 260 }))
})()`)
await delay(100)
await evaluate(`(() => {
  const action = [...document.querySelectorAll('.pane-context-menu button')]
    .find((button) => button.textContent.includes('Retrieve closed tab'))
  if (!action || action.disabled) throw new Error('Detached tab was not recoverable after its window closed')
  action.click()
})()`)
await delay(260)
const tabsAfterRetrieve = await evaluate(`document.querySelectorAll('.pane-tab').length`)
if (tabsAfterRetrieve.result.value !== tabsBeforeDetach.result.value) {
  throw new Error('Detached tab did not return through closed-tab retrieval')
}

const state = await evaluate(`(() => ({
  groups: document.querySelectorAll('.pane-group').length,
  tabs: [...document.querySelectorAll('.pane-tab > span')].map((node) => node.textContent),
  hasTerminal: Boolean(document.querySelector('.xterm-host .xterm')),
  hasFileTree: Boolean(document.querySelector('.file-tree-pane')),
  hasEditor: Boolean(document.querySelector('.monaco-editor')),
  text: document.body.innerText.slice(0, 5000)
}))()`)

const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
await mkdir(dirname(output), { recursive: true })
await writeFile(output, Buffer.from(screenshot.data, 'base64'))

if (process.argv.includes('--preserve')) {
  console.log(JSON.stringify({ output, ...state.result.value }, null, 2))
  socket.close()
  process.exit(0)
}

const sessionCountBefore = await evaluate(`document.querySelectorAll('.session-tab').length`)
await evaluate(`document.querySelector('.session-add')?.click()`)
await delay(300)
const sessionCountAfterCreate = await evaluate(`document.querySelectorAll('.session-tab').length`)
if (sessionCountAfterCreate.result.value !== sessionCountBefore.result.value + 1) throw new Error('New session was not created')
await evaluate(`document.querySelector('.session-tab.active')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
await delay(100)
const renameInput = await evaluate(`Boolean(document.querySelector('.session-tab.active .session-tab-rename'))`)
if (!renameInput.result.value) throw new Error('Double-click did not begin workspace rename')
await call('Input.insertText', { text: 'Renamed workspace' })
await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await delay(180)
const workspaceRenamed = await evaluate(`document.querySelector('.session-tab.active .session-tab-name')?.textContent === 'Renamed workspace'`)
if (!workspaceRenamed.result.value) throw new Error('Workspace rename did not persist in the session bar')
const middleSessionPoint = await evaluate(`(() => {
  const tab = document.querySelector('.session-tab.active')
  if (!tab) throw new Error('Active session tab was not found')
  const rect = tab.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})()`)
await middleClick(middleSessionPoint.result.value)
await delay(350)
const sessionCountAfterMiddle = await evaluate(`document.querySelectorAll('.session-tab').length`)
if (sessionCountAfterMiddle.result.value !== sessionCountBefore.result.value) throw new Error('Middle-click did not close the session')

const tabsBeforeCtrlW = await evaluate(`document.querySelectorAll('.pane-tab').length`)
const workspacesBeforeCtrlW = await evaluate(`document.querySelectorAll('.session-tab').length`)
await pressCtrlW()
await delay(220)
const firstCtrlW = await evaluate(`(() => ({
  tabs: document.querySelectorAll('.pane-tab').length,
  workspaces: document.querySelectorAll('.session-tab').length,
  appAlive: Boolean(document.querySelector('.app-shell'))
}))()`)
if (firstCtrlW.result.value.tabs !== tabsBeforeCtrlW.result.value - 1 ||
    firstCtrlW.result.value.workspaces !== workspacesBeforeCtrlW.result.value ||
    !firstCtrlW.result.value.appAlive) {
  throw new Error(`Ctrl+W did not close the active tab before the workspace: ${JSON.stringify(firstCtrlW.result.value)}`)
}

// Leave exactly one workspace so the final Ctrl+W verifies the zero-workspace state,
// independent of any sessions retained by an earlier smoke run.
for (let attempt = 0; attempt < 20; attempt += 1) {
  const inactivePoint = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.session-tab')]
    if (tabs.length <= 1) return null
    const tab = tabs.find((item) => !item.classList.contains('active'))
    if (!tab) return null
    const rect = tab.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  if (!inactivePoint.result.value) break
  const before = await evaluate(`document.querySelectorAll('.session-tab').length`)
  await middleClick(inactivePoint.result.value)
  await delay(180)
  const after = await evaluate(`document.querySelectorAll('.session-tab').length`)
  if (after.result.value !== before.result.value - 1) throw new Error('Middle-click did not close an inactive workspace')
}

for (let attempt = 0; attempt < 50; attempt += 1) {
  const openPanes = await evaluate(`document.querySelectorAll('.pane-tab').length`)
  if (openPanes.result.value === 0) break
  await pressCtrlW()
  await delay(160)
}
const emptyWorkspace = await evaluate(`Boolean(document.querySelector('.empty-pane-workspace'))`)
if (!emptyWorkspace.result.value) throw new Error('Ctrl+W did not allow all panes to close')
await pressCtrlW()
await delay(500)
const zeroWorkspace = await evaluate(`(() => ({
  workspaces: document.querySelectorAll('.session-tab').length,
  activeWorkspace: Boolean(document.querySelector('.session-tab.active')),
  paneWorkspace: Boolean(document.querySelector('.pane-workspace')),
  emptyState: Boolean(document.querySelector('.no-workspace-state')),
  appAlive: Boolean(document.querySelector('.app-shell'))
}))()`)
if (zeroWorkspace.result.value.workspaces !== 0 || zeroWorkspace.result.value.activeWorkspace ||
    zeroWorkspace.result.value.paneWorkspace || !zeroWorkspace.result.value.emptyState || !zeroWorkspace.result.value.appAlive) {
  throw new Error(`Closing the final workspace created a replacement or closed the app: ${JSON.stringify(zeroWorkspace.result.value)}`)
}
await delay(450)
const stayedAtZero = await evaluate(`document.querySelectorAll('.session-tab').length === 0 && Boolean(document.querySelector('.no-workspace-state'))`)
if (!stayedAtZero.result.value) throw new Error('A replacement workspace was created after the final workspace closed')

console.log(JSON.stringify({ output, ...state.result.value }, null, 2))
if (process.argv.includes('--close')) {
  await evaluate(`window.conductor.window.close()`)
  await delay(200)
}
socket.close()
