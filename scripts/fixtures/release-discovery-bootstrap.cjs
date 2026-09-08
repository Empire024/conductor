// Read-only release discovery in a disposable profile. No download or installation.
const path = require('node:path')
const { app } = require('electron')
const base = process.env.CONDUCTOR_RELEASE_QA_ROOT
const version = process.env.CONDUCTOR_RELEASE_QA_VERSION
if (!base || !version) throw new Error('Isolated release QA root and version required')
app.getVersion = () => version
const adapter = require(path.resolve('node_modules/electron-updater/out/ElectronAppAdapter.js'))
Object.defineProperty(adapter.ElectronAppAdapter.prototype, 'baseCachePath', { get: () => path.join(base,'cache') })
const module_ = require(path.resolve('node_modules/electron-updater/out/NsisUpdater.js'))
const Native = module_.NsisUpdater
global.__releaseQA = { prohibitedCalls: 0 }
module_.NsisUpdater = class DiscoveryOnlyUpdater extends Native {
  constructor(options) { super(options); this.updateConfigPath = path.join(base,'app-update.yml'); this.setFeedURL(options) }
  downloadUpdate() { global.__releaseQA.prohibitedCalls++; throw new Error('Release QA forbids downloads') }
  install() { global.__releaseQA.prohibitedCalls++; throw new Error('Release QA forbids installation') }
  quitAndInstall() { global.__releaseQA.prohibitedCalls++; throw new Error('Release QA forbids installation') }
}
require(path.resolve('out/main/index.js'))
