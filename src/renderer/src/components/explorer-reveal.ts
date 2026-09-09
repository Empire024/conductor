/** Every ancestor directory of a relative path, root-most first, e.g. 'a/b/c.ts' -> ['a', 'a/b']. */
export function ancestorDirectories(relativePath: string): string[] {
  const parts = relativePath.split('/').filter(Boolean)
  parts.pop()
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

export interface RevealPlan { parentsToExpand: string[]; alreadyVisible: boolean }

/** Decides which directories a "Reveal in Conductor Explorer" action must expand, and whether
 * the target was already visible in the tree — the checklist asks for a stronger highlight in
 * that case, since the user could already see it without this action doing anything for them. */
export function planReveal(expanded: ReadonlySet<string>, relativePath: string): RevealPlan {
  const ancestors = ancestorDirectories(relativePath)
  return { parentsToExpand: ancestors.filter((dir) => !expanded.has(dir)), alreadyVisible: ancestors.every((dir) => expanded.has(dir)) }
}
