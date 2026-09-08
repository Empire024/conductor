import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  FilePlus2,
  FolderOpen,
  Laptop,
  LayoutPanelTop,
  Maximize2,
  Minimize2,
  Minus,
  MoonStar,
  PanelTopOpen,
  Settings2,
  Sun,
  X
} from 'lucide-react'
import type { AppUpdateState, ThemeVariant, ThemeId } from '../../../shared/models'
import { THEME_OPTIONS } from '../../../shared/models'
import { useWindowMaximized } from '../use-window-maximized'

interface TitleBarProps {
  projectName?: string
  themeVariant: ThemeVariant
  themeAuto: boolean
  themeId?: ThemeId
  onTheme?(id: ThemeId): void
  onThemeAuto?(enabled: boolean): void
  onThemeVariant(variant: ThemeVariant): void
  onNewProject?(): void
  onOpenProject?(): void
  onOpenWorkspace?(): void
  onNewWorkspace?(): void
  onNewTab?(): void
  onCloseWorkspace?(): void
  onSettings?(): void
  updateState?: AppUpdateState
}

export function TitleBar(props: TitleBarProps): React.JSX.Element {
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const themeMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!themeMenuOpen) return
    const close = (event: MouseEvent): void => { if (!themeMenuRef.current?.contains(event.target as Node)) setThemeMenuOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); setThemeMenuOpen(false) } }
    window.addEventListener('mousedown', close); window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape, true) }
  }, [themeMenuOpen])
  const menuRef = useRef<HTMLDivElement>(null)
  const ThemeIcon = props.themeAuto ? Laptop : props.themeVariant === 'night' ? MoonStar : Sun
  const nextVariant: ThemeVariant = props.themeVariant === 'night' ? 'day' : 'night'
  const label = props.themeAuto ? 'auto' : props.themeVariant
  const maximized = useWindowMaximized()

  useEffect(() => {
    if (!fileMenuOpen) return
    const close = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setFileMenuOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setFileMenuOpen(false) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [fileMenuOpen])

  const run = (action?: () => void): void => {
    setFileMenuOpen(false)
    action?.()
  }

  return (
    <header className="titlebar">
      <div className="titlebar-file" ref={menuRef}>
        <button className={fileMenuOpen ? 'titlebar-brand active' : 'titlebar-brand'} onClick={() => setFileMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={fileMenuOpen}>
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>CONDUCTOR</span>
          {props.updateState?.currentVersion && (
            <span className="titlebar-version">v{props.updateState.currentVersion}</span>
          )}
          <ChevronDown size={12} />
        </button>
        {fileMenuOpen && (
          <div className="file-menu" role="menu">
            <header><strong>File</strong><span>Local workspace</span></header>
            {props.onNewProject && <button onClick={() => run(props.onNewProject)}><FilePlus2 size={16} /><span><strong>New project</strong><small>Create it in the Conductor folder</small></span></button>}
            {props.onOpenProject && <button onClick={() => run(props.onOpenProject)}><FolderOpen size={16} /><span><strong>Open project folder…</strong><small>Add an existing local folder</small></span></button>}
            {(props.onNewProject || props.onOpenProject) && <div className="file-menu-separator" />}
            <button disabled={!props.onOpenWorkspace} onClick={() => run(props.onOpenWorkspace)}><FolderOpen size={16} /><span><strong>Open workspace</strong><small>Show project sessions and layouts</small></span></button>
            <button disabled={!props.onNewWorkspace} onClick={() => run(props.onNewWorkspace)}><LayoutPanelTop size={16} /><span><strong>New workspace</strong><small>Another persistent project session</small></span></button>
            <button disabled={!props.onNewTab} onClick={() => run(props.onNewTab)}><PanelTopOpen size={16} /><span><strong>New runtime tab</strong><small>Agent or PowerShell</small></span></button>
            {props.onCloseWorkspace && <button onClick={() => run(props.onCloseWorkspace)}><X size={16} /><span><strong>Close workspace</strong><small>Project files remain untouched</small></span></button>}
            {props.onSettings && <><div className="file-menu-separator" /><button onClick={() => run(props.onSettings)}><Settings2 size={16} /><span><strong>Settings</strong><small>Projects, themes, and zoom</small></span></button></>}
          </div>
        )}
      </div>
      <div className="titlebar-drag">
        {props.projectName ? <span className="titlebar-project">{props.projectName} <span>/</span> Local workspace</span> : <span className="titlebar-project">Local agent workspace</span>}
      </div>
      <div className="quick-theme-menu-host" ref={themeMenuRef}>
      <button onContextMenu={(event) => { event.preventDefault(); setThemeMenuOpen((open) => !open) }} className="quick-theme-toggle" aria-label={`Switch to ${nextVariant} theme`} onClick={() => { setThemeMenuOpen(false); props.onThemeVariant(nextVariant) }} title={props.themeAuto ? `Theme follows local time. Click to use ${nextVariant} manually.` : `Theme: ${props.themeVariant}. Click for ${nextVariant}.`}>
        <ThemeIcon size={17} /> <span>{label}</span>
      </button>
      {themeMenuOpen && <div className="theme-menu" role="menu" aria-label="Theme">
        {THEME_OPTIONS.map((theme) => <button key={theme.id} role="menuitemradio" aria-checked={props.themeId === theme.id} onClick={() => { props.onTheme?.(theme.id); setThemeMenuOpen(false) }}><span className={'theme-swatch ' + theme.id} />{theme.label}{props.themeId === theme.id && <span className="theme-selected">✓</span>}</button>)}
        <hr />
        <button role="menuitemradio" aria-checked={!props.themeAuto && props.themeVariant === 'day'} onClick={() => { props.onThemeVariant('day'); setThemeMenuOpen(false) }}><Sun size={14} /> Day</button>
        <button role="menuitemradio" aria-checked={!props.themeAuto && props.themeVariant === 'night'} onClick={() => { props.onThemeVariant('night'); setThemeMenuOpen(false) }}><MoonStar size={14} /> Night</button>
        <button role="menuitemcheckbox" aria-checked={props.themeAuto} onClick={() => { props.onThemeAuto?.(!props.themeAuto); setThemeMenuOpen(false) }}><Laptop size={14} /> Follow local time{props.themeAuto && <span className="theme-selected">✓</span>}</button>
      </div>}
      </div>
      <div className="window-controls">
        <button onClick={() => window.conductor.window.minimize()} aria-label="Minimize"><Minus size={14} /></button>
        <button onClick={() => window.conductor.window.toggleMaximize()} aria-label={maximized ? 'Restore window' : 'Maximize window'} title={maximized ? 'Restore window' : 'Maximize window'}>
          {maximized ? <Minimize2 size={14} /> : <Maximize2 size={13} />}
        </button>
        <button className="window-close" onClick={() => window.conductor.window.close()} aria-label="Close"><X size={15} /></button>
      </div>
    </header>
  )
}
