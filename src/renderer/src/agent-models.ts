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

/** Saved provider defaults are not a factual model identity. Prefer a reported ID. */
export function runtimeModelLabel(configuredModel?: string, models: Array<{ id: string; label: string }> = [], reportedModel?: string): string {
  const explicit = (value?: string): value is string => Boolean(value?.trim() && !['default', 'auto'].includes(value.trim().toLowerCase()))
  const model = explicit(reportedModel) ? reportedModel : explicit(configuredModel) ? configuredModel : undefined
  if (!model) return models.find(option => explicit(option.id))?.label ?? 'Choose model'
  return models.find(option => option.id === model)?.label || model
}

/** A process row only ever persists the model it was configured with, which is commonly 'default'
 *  or unset - the concrete model a running turn actually resolved to lives in that session's own
 *  runtime settings instead. A process still waiting for the owner to pick a model has no such
 *  runtime to report, so it correctly keeps showing the 'Choose model' placeholder. */
export function processModelLabel(
  process: { id: string; provider?: string; model?: string },
  providers: ReadonlyArray<{ id: string; models: Array<{ id: string; label: string }> }>,
  reportedModels: ReadonlyMap<string, string>
): string {
  const models = providers.find((provider) => provider.id === process.provider)?.models ?? []
  return runtimeModelLabel(process.model, models, reportedModels.get(process.id))
}
