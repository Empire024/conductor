import { describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AutoModeDenialCard } from './AutoModeDenialCard'

const denial = { tool: 'Edit', reason: 'Security Weaken', toolUseId: 'toolu_denied' }

/** Depth-first search of a rendered element tree for a host element of the given type. */
const findElement = (node: ReactNode, type: string): ReactElement<Record<string, unknown>> | null => {
  if (Array.isArray(node)) { for (const child of node) { const found = findElement(child, type); if (found) return found } return null }
  if (!isValidElement(node)) return null
  const element = node as ReactElement<Record<string, unknown>>
  if (element.type === type) return element
  return findElement(element.props.children as ReactNode, type)
}

describe('auto-mode denial card', () => {
  it('renders as a needs-attention card naming the tool, the reason and the actual decider', () => {
    const html = renderToStaticMarkup(AutoModeDenialCard({ denial, onSwitchToEdit: () => {} }))
    expect(html).toContain('class="sa-interaction needs-attention sa-auto-denial"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('<strong>Auto mode refused Edit</strong>')
    expect(html).toContain('Security Weaken')
    expect(html).toContain('claude CLI&#x27;s own classifier decided this, so Conductor could not show you a card')
    expect(html).toContain('>Switch to Edit mode</button>')
    expect(html).toContain('send <code>continue</code>')
    expect(html).toContain('data-tool-use-id="toolu_denied"')
  })

  it('applies the composer mode change through its button, and disables it when the conversation is no longer live', () => {
    const onSwitchToEdit = vi.fn()
    const button = findElement(AutoModeDenialCard({ denial, onSwitchToEdit }), 'button')
    expect(button?.props.disabled).toBe(false)
    ;(button?.props.onClick as () => void)()
    expect(onSwitchToEdit).toHaveBeenCalledTimes(1)
    const historical = findElement(AutoModeDenialCard({ denial }), 'button')
    expect(historical?.props.disabled).toBe(true)
    expect(renderToStaticMarkup(AutoModeDenialCard({ denial }))).toContain('disabled=""')
  })
})
