import { useEffect, useState } from 'react'
import type { DebugConsoleSnapshot, IssueReportContext } from '../../shared/models'
import { applyAppTheme } from './appearance'
import { DebugConsole } from './components/DebugConsole'

const emptyContext: IssueReportContext = {
  projectCount: 0,
  sessionCount: 0,
  activeSessionId: null,
  activeSessionName: null,
  activeTabKinds: [],
  attentionCount: 0,
  theme: 'night-owl/night',
  zoomFactor: 1
}

export function DebugWindowApp(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DebugConsoleSnapshot | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!window.conductor) return
    void window.conductor.debug.getSnapshot().then(setSnapshot)
    return window.conductor.debug.onSnapshot(setSnapshot)
  }, [])

  useEffect(() => {
    if (!window.conductor) return
    void window.conductor.settings.get().then((settings) => applyAppTheme(settings))
    return window.conductor.updates.onPrepareInstall(({ requestId }) => {
      window.conductor.updates.acknowledgePrepare(requestId)
    })
  }, [])

  return (
    <div className="debug-window-shell">
      <DebugConsole
        detached
        context={snapshot?.context ?? emptyContext}
        entries={snapshot?.entries ?? []}
        onClear={() => window.conductor?.debug.clearSource()}
        onClose={() => window.conductor?.window.close()}
        onCopied={() => {
          setNotice('Issue report copied')
          window.setTimeout(() => setNotice(''), 1800)
        }}
      />
      {notice && <div className="debug-window-notice">{notice}</div>}
    </div>
  )
}
