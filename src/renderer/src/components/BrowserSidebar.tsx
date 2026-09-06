import { BrowserPane } from '../panes/BrowserPane'

export function BrowserSidebar({ projectId }: { projectId?: string }): React.JSX.Element {
  const storageKey = `conductor.browserSidebar.${projectId ?? 'global'}`
  return (
    <section className="workspace-sidebar-pane browser-sidebar" aria-label="Browser">
      <header className="workspace-sidebar-title">Browser</header>
      <BrowserPane
        compact
        viewportStorageKey={`${storageKey}.viewport`}
        initialUrl={localStorage.getItem(storageKey) || 'http://localhost:3000'}
        onUrlChange={(url) => localStorage.setItem(storageKey, url)}
      />
    </section>
  )
}
