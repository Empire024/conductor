import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { gt } from 'semver'

// Uses the real public GitHub provider and native Electron HTTP transport.
// Only the current installed version is simulated; no model, download or install.
const output=resolve('artifacts/release-discovery')
await mkdir(output,{recursive:true})
const response=await fetch('https://api.github.com/repos/Empire024/conductor/releases/latest',{headers:{'User-Agent':'Conductor-release-QA'}})
assert.equal(response.status,200)
const release=await response.json()
const latest=release.tag_name.replace(/^v/,'')
for(const asset of [`Conductor-Setup-${latest}.exe`,`Conductor-Setup-${latest}.exe.blockmap`,'latest.yml']) assert.ok(release.assets.some(item=>item.name===asset && item.size>0))
const result={realGitHubProvider:true,actualElectron:true,latest,release:release.html_url,checks:[],errors:[]}
for(const currentVersion of ['0.1.5','0.1.15']) {
  const root=await mkdtemp(join(tmpdir(),'conductor-release-discovery-'))
  await writeFile(join(root,'app-update.yml'),'provider: github\nowner: Empire024\nrepo: conductor\nupdaterCacheDirName: release-discovery-only\n')
  const env={...process.env,CONDUCTOR_RELEASE_QA_ROOT:root,CONDUCTOR_RELEASE_QA_VERSION:currentVersion,CONDUCTOR_TEST_USER_DATA:join(root,'profile'),CONDUCTOR_PROJECTS_ROOT:join(root,'projects'),CONDUCTOR_UPDATE_DEV:'1',CONDUCTOR_OFFLINE_TESTS:'1',CONDUCTOR_TEST_EMPTY_HISTORY:'1'}
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_UPDATE_URL; delete env.CONDUCTOR_LIVE_TESTS
  let app
  try {
    app=await electron.launch({args:[resolve('scripts/fixtures/release-discovery-bootstrap.cjs')],env,timeout:30000})
    const page=await app.firstWindow()
    const available=gt(latest,currentVersion)
    await expect.poll(()=>page.evaluate(()=>window.conductor?.updates.getState()),{timeout:45000}).toMatchObject({phase:available?'available':'idle',currentVersion,lastCheckedAt:expect.any(String),...(available?{source:'release',availableVersion:latest}:{})})
    await expect(page.locator('.status-version-number')).toHaveText('v'+currentVersion)
    if(available) {
      await expect(page.locator('.statusbar-update')).toHaveText('Update pending')
      await expect(page.getByRole('dialog')).toContainText(latest+' is ready to download')
    }
    assert.equal(await app.evaluate(()=>global.__releaseQA.prohibitedCalls),0)
    result.checks.push({currentVersion,state:await page.evaluate(()=>window.conductor.updates.getState()),downloadOrInstallCalls:0})
  } catch(error) { result.errors.push(error.stack??String(error)); process.exitCode=1 }
  finally { await app?.close() }
}
await writeFile(join(output,'results.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
