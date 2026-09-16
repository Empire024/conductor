import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-theme-'))
const output = resolve('artifacts/theme-sidebar')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_MODEL_CATALOG: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(10000)
const result = { actualElectron: true, providerTurns: 0, checks: [], colors: [], errors: [] }
page.on('pageerror', error => result.errors.push(error.stack ?? error.message))
const contrast = (foreground, background) => {
  const luminance = rgb => rgb.slice(0,3).reduce((sum, value, index) => {
    const n = value / 255
    return sum + (n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4) * [.2126,.7152,.0722][index]
  },0)
  const a=luminance(foreground), b=luminance(background)
  return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)
}
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve,150)))))
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, name+'.png'), Buffer.from(png,'base64'))
}
async function verify(locator, name, theme, variant) {
  const colors = await locator.evaluate(el => {
    const rgba = value => value.match(/[\d.]+/g).map(Number)
    const color=getComputedStyle(el).color
    let bg='rgba(0,0,0,0)'
    for(let node=el;node;node=node.parentElement) {
      const next=getComputedStyle(node).backgroundColor
      const parts=rgba(next)
      if(parts.length===3 || parts[3]===1) { bg=next; break }
    }
    return { color, background: bg, foreground:rgba(color), surface:rgba(bg) }
  })
  const ratio=contrast(colors.foreground,colors.surface)
  result.colors.push({theme,variant,name,...colors,contrast:ratio})
  assert.ok(ratio>=4.5, `${theme} ${variant} ${name} contrast ${ratio.toFixed(2)}: ${JSON.stringify(colors)}`)
  if(variant==='day') assert.ok(colors.surface.every((n,i) => i>2 || n>160), `${name} kept a dark surface`)
}
try {
  await page.waitForFunction(() => Boolean(window.conductor?.projects))
  await page.evaluate(async () => {
    const project=await window.conductor.projects.create('Conductor')
    await window.conductor.sessions.create(project.id,'Theme review')
    await window.conductor.projects.create('Second project')
    await window.conductor.settings.setThemeAuto(false)
  })
  for(const theme of ['night-owl','obsidian','nord']) for(const variant of ['day','night']) {
    await page.evaluate(async ({theme,variant}) => {
      await window.conductor.settings.setTheme(theme)
      await window.conductor.settings.setThemeVariant(variant)
    },{theme,variant})
    await page.reload()
    await page.locator('.project-row').filter({hasText:'Conductor'}).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme-variant',variant)
    await page.mouse.move(850,400)
    await verify(page.locator('.sidebar-search span'),'Jump to',theme,variant)
    await verify(page.locator('.titlebar-version'),'title-bar version',theme,variant)
    assert.ok(await page.locator('.titlebar-version').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=10))
    await verify(page.locator('.project-row.active .ellipsis'),'selected project',theme,variant)
    await verify(page.locator('.project-row:not(.active) .ellipsis'),'other project',theme,variant)
    await verify(page.locator('.sidebar-session-row button.active .ellipsis'),'selected workspace',theme,variant)
    await verify(page.locator('.sidebar-session-row button:not(.active) .ellipsis').first(),'other workspace',theme,variant)
    await capture(theme+'-'+variant)
    await page.locator('.sidebar-search').hover()
    await verify(page.locator('.sidebar-search span'),'hovered Jump to',theme,variant)
    await page.locator('.project-row:not(.active)').hover()
    await verify(page.locator('.project-row:not(.active) .ellipsis'),'hovered project',theme,variant)
    await page.locator('.sidebar-session-row button:not(.active)').filter({has:page.locator('.ellipsis')}).first().hover()
    await verify(page.locator('.sidebar-session-row button:not(.active) .ellipsis').first(),'hovered workspace',theme,variant)
    result.checks.push(theme+' '+variant+': readable surfaces and text in normal, selected and hover states')
  }
  const state={phase:'idle',currentVersion:'0.1.15',configured:true,lastCheckedAt:new Date().toISOString()}
  await app.evaluate(({BrowserWindow,ipcMain},state)=> {
    ipcMain.removeHandler('updates:get-state')
    ipcMain.handle('updates:get-state',()=>state)
    ipcMain.removeHandler('updates:check')
    ipcMain.handle('updates:check',()=>new Promise(resolve=> { globalThis.__finishThemeUpdateCheck=()=>resolve(state) }))
    BrowserWindow.getAllWindows()[0].webContents.send('updates:state',state)
  },state)
  const version=page.locator('.status-version-number')
  await expect(version).toHaveText('v0.1.15')
  await expect(page.locator('.status-version-button')).toHaveAttribute('title',/Installed: v0\.1\.15/)
  assert.ok(await version.evaluate(el=> parseFloat(getComputedStyle(el).fontSize)>=10 && el.scrollWidth<=el.clientWidth))
  await page.locator('.status-version-button').click()
  await expect(version).toHaveText('v0.1.15')
  await expect(page.locator('.status-version-button')).toContainText('Checking')
  await app.evaluate(()=>globalThis.__finishThemeUpdateCheck())
  await expect(page.locator('.status-version-button')).toContainText('Latest version already installed')
  await expect(version).toHaveText('v0.1.15')
  result.checks.push('Full version remains readable during and after a manual update check')
  await page.evaluate(async () => { await window.conductor.settings.setTheme('night-owl'); await window.conductor.settings.setThemeVariant('day') })
  await page.reload()
  await app.evaluate(({BrowserWindow},state)=>BrowserWindow.getAllWindows()[0].webContents.send('updates:state',state),state)
  await expect(version).toHaveText('v0.1.15')
  await expect(page.locator('.titlebar-version')).toHaveText('v0.1.15')
  await verify(version,'installed version','night-owl','day')
  await capture('night-owl-day')
  assert.deepEqual(result.errors,[])
} catch(error) { result.errors.push(error.stack??String(error)); await capture('failure'); process.exitCode=1 }
finally { await app.close(); await writeFile(join(output,'results.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify({checks:result.checks,errors:result.errors},null,2)) }
