import { useEffect, useRef } from 'react'
import { Command } from 'lucide-react'
import type { ComposerCommand } from './composer-commands'
/** The browser preview has no turn-scoped tool protocol yet, so choosing this mention just
 *  reveals the pane the user (and, once attached as context, the agent) can rely on. Kept
 *  here rather than inside chooseCommand so both this click path and any future keyboard
 *  path can call the same activation. */
export function activateBrowserMention(): void {
  window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'browser' }))
}
export function CommandAutocomplete({ id, commands, selected, loading, onSelect, onChoose }: { id: string; commands: ComposerCommand[]; selected: number; loading: boolean; onSelect(index: number): void; onChoose(command: ComposerCommand): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => { host.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const choose = (command: ComposerCommand): void => {
    if (command.trigger === '@' && command.name === 'browser') activateBrowserMention()
    onChoose(command)
  }
  return <div ref={host} className="sa-command-menu"><header><Command size={13} /> Commands{loading && <small>Loading provider commands...</small>}</header><div role="listbox" aria-label="Chat commands" id={id}>{commands.map((command, index) => <button type="button" role="option" id={id + '-' + index} aria-selected={index === selected} key={command.name} onMouseDown={event => event.preventDefault()} onPointerMove={() => onSelect(index)} onClick={() => choose(command)}><strong>{command.trigger ?? '/'}{command.name}</strong><span>{command.description}</span></button>)}</div><small>Arrow keys to choose ? Enter / Tab to select ? Esc to dismiss</small></div>
}
