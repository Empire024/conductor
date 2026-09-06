import type { LayoutNode, PaneTab, WorkspaceLayout } from '../../shared/models'

const RETIRED_CODEX_MODELS = new Set(['gpt-5.3-codex', 'gpt-5.2-codex'])

export const migrateLegacyCodexTab = (tab: PaneTab): PaneTab => {
  if (tab.kind !== 'agent' || tab.state?.provider !== 'codex') return tab
  const model = tab.state.model
  if (typeof model !== 'string' || !RETIRED_CODEX_MODELS.has(model)) return tab
  return { ...tab, state: { ...tab.state, model: 'gpt-6-astra' } }
}

export const migrateLegacyCodexModels = (layout: WorkspaceLayout): WorkspaceLayout => {
  let changed = false
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.type === 'split') {
      const first = visit(node.children[0])
      const second = visit(node.children[1])
      if (first === node.children[0] && second === node.children[1]) return node
      return { ...node, children: [first, second] }
    }
    const tabs = node.tabs.map((tab) => {
      const migrated = migrateLegacyCodexTab(tab)
      if (migrated !== tab) changed = true
      return migrated
    })
    return tabs.some((tab, index) => tab !== node.tabs[index]) ? { ...node, tabs } : node
  }
  const root = visit(layout.root)
  return changed ? { ...layout, root } : layout
}
