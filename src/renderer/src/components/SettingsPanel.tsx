import { useEffect, useRef, useState } from 'react'
import { BellRing, Bot, Bug, Check, ExternalLink, EyeOff, FolderCog, MessageCircleQuestion, Minus, MoonStar, Palette, Plus, RefreshCw, RotateCcw, Search, Settings2, Gauge, Monitor, Smartphone, Sun, Volume2, X, ZoomIn } from 'lucide-react'
import type { AgentProviderInfo, AgentSoundCue, AgentSoundProfile, AppSettings, AppUpdateState, ThemeId, ThemeVariant } from '../../../shared/models'
import { THEME_OPTIONS } from '../../../shared/models'
import { playAgentSound } from '../agent-sounds'
import { UsageCapDefaultSetting } from './UsageCapDefaultSetting'
import { CoworkerAutoCloseSetting } from './CoworkerAutoCloseSetting'
import { RemoteControlSettings } from './RemoteControlSettings'
import { AlwaysOnSettings } from './AlwaysOnSettings'
import { PhoneAccessSettings } from './PhoneAccessSettings'
import { matchingSettingsSections, resolveSettingsSection, SETTINGS_SECTIONS, type SettingsSectionId } from './settings-navigation'
import './SettingsPanel.css'

let rememberedSection: SettingsSectionId = 'general'
const sectionIcons = { general: Settings2, appearance: Palette, sounds: Volume2, usage: Gauge, machines: Monitor, phone: Smartphone, updates: RefreshCw, runtimes: Bot, debug: Bug }

export function SettingsPanel({
  settings,
  onClose,
  onChooseProjectsRoot,
  onSetZoom,
  onSetTheme,
  onSetThemeVariant,
  onSetThemeAuto,
  onSetAgentSoundProfile,
  onSetDefaultNewFileExtension,
  onSetDebugLogging,
  onSetShowHiddenFiles,
  onOpenDebugConsole,
  updateState,
  onSetLocalUpdates,
  onCheckForUpdates,
  initialSection
}: {
  initialSection?: SettingsSectionId
  settings: AppSettings
  onClose(): void
  onChooseProjectsRoot(): void
  onSetZoom(value: number): void
  onSetTheme(value: ThemeId): void
  onSetThemeVariant(value: ThemeVariant): void
  onSetThemeAuto(enabled: boolean): void
  onSetAgentSoundProfile(profile: AgentSoundProfile): void
  onSetDefaultNewFileExtension(extension: string): Promise<AppSettings>
  onSetDebugLogging(enabled: boolean): void
  onSetShowHiddenFiles(enabled: boolean): void
  onOpenDebugConsole(): void
  updateState: AppUpdateState
  onSetLocalUpdates(enabled: boolean): void
  onCheckForUpdates(): void
}): React.JSX.Element {
  const [activeSection, setActiveSection] = useState(() => resolveSettingsSection(initialSection, rememberedSection))
  const [query, setQuery] = useState('')
  const panelRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const matches = matchingSettingsSections(query)
  const currentSection = SETTINGS_SECTIONS.find(section => section.id === activeSection)!
  useEffect(() => {
    if (initialSection) setActiveSection(resolveSettingsSection(initialSection, rememberedSection))
  }, [initialSection])
  useEffect(() => { rememberedSection = activeSection }, [activeSection])
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    searchRef.current?.focus()
    return () => { previousFocus?.focus() }
  }, [])
  const percent = Math.round(settings.zoomFactor * 100)
  const [fileExtension, setFileExtension] = useState(settings.defaultNewFileExtension)
  const [extensionError, setExtensionError] = useState('')
  const saveExtension = async (): Promise<void> => {
    try { const saved = await onSetDefaultNewFileExtension(fileExtension); setFileExtension(saved.defaultNewFileExtension); setExtensionError('') }
    catch (reason) { setExtensionError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const [providers, setProviders] = useState<AgentProviderInfo[]>([])
  useEffect(() => { void window.conductor.agents.listProviders().then(setProviders) }, [])
  const previewSound = (cue: AgentSoundCue): void => playAgentSound(settings.agentSoundProfile, cue)
  return (
    <div className="settings-scrim" onMouseDown={onClose}>
      <aside ref={panelRef} className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()} onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (query) { setQuery(''); searchRef.current?.focus() } else onClose()
          }
          if (event.key === 'Tab') {
            const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0)
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
          }
        }}>
        <header><div><strong id="settings-title">Settings</strong><span>Saved automatically on this PC</span></div><button aria-label="Close settings" onClick={onClose}><X size={15} /></button></header>

        <div className="settings-layout">
          <div className="settings-sidebar">
            <label className="settings-search">
              <Search size={14} aria-hidden="true" />
              <input ref={searchRef} aria-label="Search settings" placeholder="Search settings" value={query} onChange={event => setQuery(event.target.value)} />
              {query && <button aria-label="Clear settings search" onClick={() => { setQuery(''); searchRef.current?.focus() }}><X size={12} /></button>}
            </label>
            <nav className="settings-nav" aria-label="Settings sections" onKeyDown={event => {
              if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
              event.preventDefault()
              buttons[next]?.focus()
              buttons[next]?.click()
            }}>
              {SETTINGS_SECTIONS.map(section => {
                const Icon = sectionIcons[section.id]
                const matched = matches.includes(section.id)
                return <button key={section.id} type="button" aria-current={activeSection === section.id ? 'page' : undefined}
                  data-search-match={matched} className={activeSection === section.id ? 'active' : ''}
                  onClick={() => setActiveSection(section.id)}>
                  <Icon size={16} aria-hidden="true" /><span>{section.title}</span>
                  {query.trim() && matched && <i aria-hidden="true" />}
                </button>
              })}
            </nav>
            <p className="settings-search-status" role="status">{query.trim() ? matches.length ? matches.length + ' matching ' + (matches.length === 1 ? 'section' : 'sections') : 'No matching sections. Try another word.' : 'Your settings stay on this PC.'}</p>
          </div>
          <div className="settings-page" key={activeSection} role="region" aria-labelledby="settings-page-title" tabIndex={0}>
            <div className="settings-page-heading"><h2 id="settings-page-title">{currentSection.title}</h2><p>{currentSection.description}</p></div>
            {activeSection === 'general' && <>
              <section>
                <div className="settings-section-title"><FolderCog size={14} /><div><strong>Managed projects</strong><span>New projects are created in this folder.</span></div></div>
                <div className="folder-setting"><code title={settings.projectsRoot}>{settings.projectsRoot}</code><button onClick={onChooseProjectsRoot}>Change…</button></div>
                <p>Moving this location does not move existing projects. Use a project's context menu for that.</p>
              </section>

              <section>
                <div className="settings-section-title"><FolderCog size={14} /><div><strong>New files</strong><span>Choose the extension used when you add a file tab.</span></div></div>
                <label className="default-file-extension"><span>Default file extension</span><input aria-label="Default file extension" value={fileExtension} placeholder="md" maxLength={33} onChange={(event) => setFileExtension(event.target.value)} onBlur={() => void saveExtension()} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} /><small>New files start as untitled.{settings.defaultNewFileExtension}.</small></label>
                {extensionError && <p role="alert">{extensionError}</p>}
              </section>

              <section>
                <div className="settings-section-title"><EyeOff size={14} /><div><strong>Ctrl+E file search</strong><span>Dotfiles and folders such as .git are hidden by default.</span></div></div>
                <label className="theme-auto-setting">
                  <span><strong>Show hidden files</strong><small>Also toggle per search from the picker itself</small></span>
                  <input
                    type="checkbox"
                    checked={settings.showHiddenFiles}
                    onChange={(event) => onSetShowHiddenFiles(event.target.checked)}
                  />
                  <i aria-hidden="true" />
                </label>
              </section>

              <section>
                <div className="settings-section-title"><ZoomIn size={14} /><div><strong>Interface zoom</strong><span>Applies to the entire workspace.</span></div></div>
                <div className="zoom-setting">
                  <button aria-label="Zoom out" onClick={() => onSetZoom(settings.zoomFactor - 0.05)}><Minus size={14} /></button>
                  <input
                    type="range"
                    aria-label="Interface zoom"
                    min="80"
                    max="150"
                    step="5"
                    value={percent}
                    onChange={(event) => onSetZoom(Number(event.target.value) / 100)}
                  />
                  <button aria-label="Zoom in" onClick={() => onSetZoom(settings.zoomFactor + 0.05)}><Plus size={14} /></button>
                  <output>{percent}%</output>
                  <button className="zoom-reset" onClick={() => onSetZoom(1.1)} title="Reset to default"><RotateCcw size={13} /></button>
                </div>
                <div className="shortcut-hints"><span><kbd>Ctrl</kbd><kbd>+</kbd> zoom in</span><span><kbd>Ctrl</kbd><kbd>−</kbd> zoom out</span><span><kbd>Ctrl</kbd><kbd>0</kbd> reset</span></div>
              </section>
            </>}
            {activeSection === 'appearance' && <>
              <section>
                <div className="settings-section-title"><Palette size={14} /><div><strong>Appearance</strong><span>Pick a palette, then choose how its day and night versions switch.</span></div></div>
                <div className="theme-controls">
                  <label className="theme-family-select">
                    <span>Color theme</span>
                    <select value={settings.themeId} onChange={(event) => onSetTheme(event.target.value as ThemeId)}>
                      {THEME_OPTIONS.map((theme) => (
                        <option key={theme.id} value={theme.id}>{theme.label} — {theme.description}</option>
                      ))}
                    </select>
                  </label>
                  <div className="theme-variant-setting" role="group" aria-label="Theme version">
                    <button
                      className={!settings.themeAuto && settings.themeVariant === 'day' ? 'active' : ''}
                      disabled={settings.themeAuto}
                      onClick={() => onSetThemeVariant('day')}
                    ><Sun size={16} /> Day</button>
                    <button
                      className={!settings.themeAuto && settings.themeVariant === 'night' ? 'active' : ''}
                      disabled={settings.themeAuto}
                      onClick={() => onSetThemeVariant('night')}
                    ><MoonStar size={16} /> Night</button>
                  </div>
                  <label className="theme-auto-setting">
                    <span><strong>Auto</strong><small>Day from 07:00 to 19:00, night otherwise</small></span>
                    <input
                      type="checkbox"
                      checked={settings.themeAuto}
                      onChange={(event) => onSetThemeAuto(event.target.checked)}
                    />
                    <i aria-hidden="true" />
                  </label>
                </div>
              </section>
            </>}
            {activeSection === 'sounds' && <>
              <section>
                <div className="settings-section-title"><Volume2 size={14} /><div><strong>Agent sounds</strong><span>Quiet cues for completion and input.</span></div></div>
                <div className="agent-sound-setting">
                  <label>
                    <span>Profile</span>
                    <select value={settings.agentSoundProfile} onChange={(event) => onSetAgentSoundProfile(event.target.value as AgentSoundProfile)}>
                      <option value="soft">Soft chimes</option>
                      <option value="minimal">Minimal tones</option>
                      <option value="off">Off</option>
                    </select>
                  </label>
                  <div role="group" aria-label="Preview agent sounds">
                    <button disabled={settings.agentSoundProfile === 'off'} onClick={() => previewSound('complete')} title="Preview completion"><Check size={12} /> Done</button>
                    <button disabled={settings.agentSoundProfile === 'off'} onClick={() => previewSound('question')} title="Preview question"><MessageCircleQuestion size={12} /> Question</button>
                    <button disabled={settings.agentSoundProfile === 'off'} onClick={() => previewSound('input')} title="Preview needs input"><BellRing size={12} /> Input</button>
                  </div>
                </div>
                <p>Final completion uses the warm rising cue.</p>
              </section>
            </>}
            {activeSection === 'usage' && <>
              <UsageCapDefaultSetting />
              <CoworkerAutoCloseSetting />
            </>}
            {activeSection === 'machines' && <>
              <AlwaysOnSettings />
              <RemoteControlSettings />
            </>}
            {activeSection === 'phone' && <>
              <PhoneAccessSettings />
            </>}
            {activeSection === 'updates' && <>
              <section>
                <div className="settings-section-title"><RefreshCw size={14} /><div><strong>Updates</strong><span>GitHub Releases and local test builds</span></div></div>
                <div className="update-source-setting"><strong>Installed-app updates</strong><small>Automatic checks at startup and every 2 minutes</small></div>
                <label className="theme-auto-setting">
                  <span><strong>Include local test builds</strong><small>Offer builds published on this PC through the normal updater.</small></span>
                  <input type="checkbox" checked={settings.includeLocalUpdates !== false} disabled={['downloading', 'ready', 'installing'].includes(updateState.phase)} onChange={(event) => onSetLocalUpdates(event.target.checked)} />
                  <i aria-hidden="true" />
                </label>
                <div className="folder-setting"><code title={settings.localUpdateDirectory}>{settings.localUpdateDirectory}</code><button onClick={() => void window.conductor.updates.openLocalFolder()}>Open local builds folder</button></div>
                <p>Local builds are testing versions, not claims of completed provider parity. Newer published releases remain available automatically.</p>
                {updateState.localBuildWarning && <p role="alert">{updateState.localBuildWarning}</p>}
                <div className="update-status-setting">
                  <span>
                    <strong>Conductor {updateState.currentVersion || '—'}</strong>
                    <small>{updateState.message ?? 'Update status unavailable.'}</small>
                  </span>
                  <button
                    disabled={!updateState.configured || ['checking', 'downloading', 'installing'].includes(updateState.phase)}
                    onClick={onCheckForUpdates}
                  ><RefreshCw className={updateState.phase === 'checking' ? 'spin' : ''} size={12} /> Check now</button>
                </div>
              </section>
            </>}
            {activeSection === 'runtimes' && <>
              <section>
                <div className="settings-section-title"><Bot size={14} /><div><strong>Frontier runtimes</strong><span>Conductor uses each provider's real local CLI.</span></div></div>
                <div className="provider-settings">
                  {providers.map((provider) => (
                    <article key={provider.id}>
                      <span className={provider.available ? 'available' : ''}>{provider.available ? <Check size={13} /> : <Bot size={13} />}</span>
                      <div><strong>{provider.displayName}</strong><small>{provider.available ? 'Ready on this PC' : 'Not found on PATH'}</small></div>
                      <button onClick={() => void window.conductor.system.openExternal(provider.installUrl)}>{provider.available ? 'Docs' : 'Get'} <ExternalLink size={12} /></button>
                    </article>
                  ))}
                  <article>
                    <span><Bot size={13} /></span>
                    <div><strong>DeepSeek</strong><small>Frontier API setup · no native coding CLI adapter</small></div>
                    <button onClick={() => void window.conductor.system.openExternal('https://api-docs.deepseek.com/')}>Get <ExternalLink size={12} /></button>
                  </article>
                </div>
              </section>
            </>}
            {activeSection === 'debug' && <>
              <section>
                <div className="settings-section-title"><Bug size={14} /><div><strong>Debug tools</strong><span>Capture local UI events, warnings, and errors for troubleshooting.</span></div></div>
                <div className="debug-setting">
                  <label>
                    <span><strong>Debug logging</strong><small>Kept in memory and cleared when Conductor exits</small></span>
                    <input
                      type="checkbox"
                      checked={settings.debugLogging}
                      onChange={(event) => onSetDebugLogging(event.target.checked)}
                    />
                    <i aria-hidden="true" />
                  </label>
                  <button disabled={!settings.debugLogging} onClick={onOpenDebugConsole}>Open console</button>
                </div>
                <p>Issue reports are never sent automatically. Copy one from the console when you are ready to share it.</p>
              </section>
            </>}
          </div>
        </div>
      </aside>
    </div>
  )
}
