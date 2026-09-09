import { describe, expect, it } from 'vitest'
import { ancestorDirectories, planReveal } from './explorer-reveal'

describe('ancestorDirectories', () => {
  it('returns nothing for a root-level file', () => {
    expect(ancestorDirectories('readme.md')).toEqual([])
  })

  it('returns every parent, root-most first', () => {
    expect(ancestorDirectories('a/b/c/file.ts')).toEqual(['a', 'a/b', 'a/b/c'])
  })
})

describe('planReveal', () => {
  it('needs nothing expanded and is already visible for a root-level file', () => {
    const plan = planReveal(new Set(), 'readme.md')
    expect(plan.parentsToExpand).toEqual([])
    expect(plan.alreadyVisible).toBe(true)
  })

  it('reports every missing ancestor and treats the file as not yet visible', () => {
    const plan = planReveal(new Set(), 'a/b/c/file.ts')
    expect(plan.parentsToExpand).toEqual(['a', 'a/b', 'a/b/c'])
    expect(plan.alreadyVisible).toBe(false)
  })

  it('only expands the ancestors that are not already expanded', () => {
    const plan = planReveal(new Set(['a']), 'a/b/c/file.ts')
    expect(plan.parentsToExpand).toEqual(['a/b', 'a/b/c'])
    expect(plan.alreadyVisible).toBe(false)
  })

  it('is already visible once every ancestor is expanded, and asks for a stronger highlight', () => {
    const plan = planReveal(new Set(['a', 'a/b', 'a/b/c']), 'a/b/c/file.ts')
    expect(plan.parentsToExpand).toEqual([])
    expect(plan.alreadyVisible).toBe(true)
  })
})
