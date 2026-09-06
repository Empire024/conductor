import React from 'react'
import ReactDOM from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './monaco'
import './styles.css'
import './appearance.css'
import { App } from './App'
import { DetachedWindowApp } from './DetachedWindowApp'
import { DebugWindowApp } from './DebugWindowApp'
import { applyAppTheme } from './appearance'

const parameters = new URLSearchParams(window.location.search)
const detachedId = parameters.get('detached')
const debugConsole = parameters.get('debug-console') === '1'
applyAppTheme(window.conductor.settings.getStartup())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {debugConsole ? <DebugWindowApp /> : detachedId ? <DetachedWindowApp detachedId={detachedId} /> : <App />}
  </React.StrictMode>
)
