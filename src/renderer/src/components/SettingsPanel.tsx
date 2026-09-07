import { useEffect, useState } from 'react'
import { BellRing, Bot, Bug, Check, ExternalLink, FolderCog, MessageCircleQuestion, Minus, MoonStar, Palette, Plus, RefreshCw, RotateCcw, Sun, Volume2, X, ZoomIn } from 'lucide-react'
import type { AgentProviderInfo, AgentSoundCue, AgentSoundProfile, AppSettings, AppUpdateState, ThemeId, ThemeVariant } from '../../../shared/models'
import { THEME_OPTIONS } from '../../../shared/models'
import { playAgentSound } from '../agent-sounds'

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
  onOpenDebugConsole,
  updateState,
  onSetLocalUpdates,
  onCheckForUpdates
}: {
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
  onOpenDebugConsole(): void
  updateState: AppUpdateState
  onSetLocalUpdates(enabled: boolean): void
  onCheckForUpdates(): void
}): React.JSX.Element {
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
      <aside className="settings-panel" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><strong>Settings</strong><span>Saved automatically on this PC</span></div><button onClick={onClose}><X size={15} /></button></header>

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
          <div className="settings-section-title"><ZoomIn size={14} /><div><strong>Interface zoom</strong><span>Applies to the entire workspace.</span></div></div>
          <div className="zoom-setting">
            <button onClick={() => onSetZoom(settings.zoomFactor - 0.05)}><Minus size={14} /></button>
            <input
              type="range"
              min="80"
              max="150"
              step="5"
              value={percent}
              onChange={(event) => onSetZoom(Number(event.target.value) / 100)}
            />
            <button onClick={() => onSetZoom(settings.zoomFactor + 0.05)}><Plus size={14} /></button>
            <output>{percent}%</output>
            <button className="zoom-reset" onClick={() => onSetZoom(1.1)} title="Reset to default"><RotateCcw size={13} /></button>
          </div>
          <div className="shortcut-hints"><span><kbd>Ctrl</kbd><kbd>+</kbd> zoom in</span><span><kbd>Ctrl</kbd><kbd>−</kbd> zoom out</span><span><kbd>Ctrl</kbd><kbd>0</kbd> reset</span></div>
        </section>

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
      </aside>
    </div>
  )
}
