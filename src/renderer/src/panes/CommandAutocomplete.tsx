import { useEffect, useRef } from 'react'
import { Command } from 'lucide-react'
import type { ComposerCommand } from './composer-commands'
import { skillStatusText, type ComposerSkills } from './composer-skills'
/** @browser is the view-driven control: reveal the project's persistent left browser. The
 * composer globe has a deliberately different job and changes model-tool authority only. */
export function activateBrowserMention(): void {
  window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'browser' }))
}
export function CommandAutocomplete({ id, commands, selected, loading, skillStatus, onSelect, onChoose }: { id: string; commands: ComposerCommand[]; selected: number; loading: boolean; skillStatus?: ComposerSkills; onSelect(index: number): void; onChoose(command: ComposerCommand): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => { host.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const status = skillStatus && skillStatusText(skillStatus, commands.some(command => command.kind === 'skill'))
  return <div ref={host} className="sa-command-menu"><header><Command size={13} /> Commands{loading && <small>Loading provider commands...</small>}</header>{status && <p className="sa-command-status" role="status">{status}</p>}<div role="listbox" aria-label="Chat commands" id={id}>{commands.map((command, index) => <button type="button" role="option" data-kind={command.kind} id={id + '-' + index} aria-selected={index === selected} key={command.name} onMouseDown={event => event.preventDefault()} onPointerMove={() => onSelect(index)} onClick={() => onChoose(command)}><strong>{command.trigger ?? '/'}{command.name}</strong><span>{command.description}{command.argumentHint && <em className="sa-command-hint"> {command.argumentHint}</em>}{command.source && <em className="sa-command-hint"> · {command.source}</em>}</span></button>)}</div><small>Arrow keys to choose · Enter runs · Tab adds arguments · Esc dismisses · // sends a slash as text{commands.some(command => command.kind === 'skill') && ' · a skill goes into the draft, to send with your message'}</small></div>
}
