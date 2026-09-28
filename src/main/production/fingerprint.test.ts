import { describe, expect, it } from 'vitest'
import { CHANGE_CLASSES } from '../../shared/production'
import { classifyChange, computeFingerprint, findingId, hashFiles, normalisePolicyText, sameTarget, type FingerprintInputs } from './fingerprint'

const inputs = (patch: Partial<FingerprintInputs> = {}): FingerprintInputs => ({
  environmentId: 'prod', commit: 'a'.repeat(40), build: 'build-1',
  configFiles: [{ path: '.htaccess', content: 'RewriteEngine On\n' }, { path: 'wp-config.php', content: 'define("WP_DEBUG", false);\n' }],
  policyPages: [{ path: 'https://shop.example/privacy', content: '<h1>Privacy</h1> We process   orders.' }],
  dependencyFiles: [{ path: 'composer.lock', content: '{"packages":[]}' }],
  routes: ['/', '/shop', '/privacy'],
  profileVersion: 3, registryVersion: 1,
  now: () => new Date('2026-09-28T12:00:00.000Z'),
  ...patch
})

describe('computeFingerprint', () => {
  it('is deterministic and independent of file and route order', () => {
    const a = computeFingerprint(inputs())
    const b = computeFingerprint(inputs({ configFiles: [...inputs().configFiles].reverse(), routes: ['/privacy', '/', '/shop', '/shop'] }))
    expect(b).toEqual(a)
    expect(a.configHash).toMatch(/^[a-f0-9]{64}$/)
    expect(a).toMatchObject({ environmentId: 'prod', commit: 'a'.repeat(40), build: 'build-1', profileVersion: 3, registryVersion: 1, computedAt: '2026-09-28T12:00:00.000Z' })
  })

  it('ignores policy whitespace reflow and CRLF line endings, but not a content change', () => {
    const base = computeFingerprint(inputs())
    expect(computeFingerprint(inputs({ policyPages: [{ path: 'https://shop.example/privacy', content: '<h1>Privacy</h1>\n\n We process orders.  ' }] })).policyHash).toBe(base.policyHash)
    expect(computeFingerprint(inputs({ configFiles: [{ path: '.htaccess', content: 'RewriteEngine On\r\n' }, inputs().configFiles[1]!] })).configHash).toBe(base.configHash)
    expect(computeFingerprint(inputs({ policyPages: [{ path: 'https://shop.example/privacy', content: '<h1>Privacy</h1> We sell data.' }] })).policyHash).not.toBe(base.policyHash)
    expect(normalisePolicyText('  a \n\t b  ')).toBe('a b')
  })

  it('treats a renamed or added empty file as a change', () => {
    expect(hashFiles([{ path: 'a', content: 'x' }])).not.toBe(hashFiles([{ path: 'b', content: 'x' }]))
    expect(hashFiles([{ path: 'a', content: 'x' }])).not.toBe(hashFiles([{ path: 'a', content: 'x' }, { path: 'b', content: '' }]))
  })

  it('refuses a fingerprint without an environment', () => {
    expect(() => computeFingerprint(inputs({ environmentId: '' }))).toThrow(/environment/)
  })
})

describe('classifyChange', () => {
  const before = computeFingerprint(inputs())

  it('returns nothing when only computedAt moved', () => {
    const after = computeFingerprint(inputs({ now: () => new Date('2026-10-01T00:00:00.000Z') }))
    expect(classifyChange(before, after)).toEqual([])
    expect(sameTarget(before, after)).toBe(true)
  })

  it('maps each fingerprint component to its change class', () => {
    const cases: Array<[Partial<FingerprintInputs>, string]> = [
      [{ commit: 'b'.repeat(40) }, 'code'],
      [{ build: 'build-2' }, 'deployment'],
      [{ configFiles: [{ path: '.htaccess', content: 'RewriteEngine Off\n' }] }, 'configuration'],
      [{ policyPages: [{ path: 'https://shop.example/privacy', content: 'changed' }] }, 'policy'],
      [{ dependencyFiles: [{ path: 'composer.lock', content: '{"packages":[1]}' }] }, 'dependency'],
      [{ routes: ['/', '/shop'] }, 'content'],
      [{ profileVersion: 4 }, 'profile'],
      [{ registryVersion: 2 }, 'registry'],
    ]
    for (const [patch, change] of cases) expect(classifyChange(before, computeFingerprint(inputs(patch)))).toEqual([change])
    expect(classifyChange(before, computeFingerprint(inputs({ registryVersion: 2, commit: null })))).toEqual(['code', 'registry'])
  })

  it('never compares across environments or against no previous run', () => {
    expect(classifyChange(before, computeFingerprint(inputs({ environmentId: 'staging' })))).toEqual([...CHANGE_CLASSES])
    expect(classifyChange(null, before)).toEqual([...CHANGE_CLASSES])
    expect(sameTarget(before, computeFingerprint(inputs({ environmentId: 'staging' })))).toBe(false)
    expect(sameTarget(null, before)).toBe(false)
  })
})

describe('findingId', () => {
  const parts = { projectId: 'p1', environmentId: 'prod', controlId: 'C03' as const, checkId: 'consent', key: 'tracker-before-consent:ga4', route: '/' }

  it('is stable for the same defect at the same place and differs for any other field', () => {
    expect(findingId(parts)).toBe(findingId({ ...parts }))
    expect(findingId(parts)).toMatch(/^pf_[a-f0-9]{32}$/)
    const others = [{ projectId: 'p2' }, { environmentId: 'staging' }, { controlId: 'C05' as const }, { checkId: 'vendors' }, { key: 'tracker-before-consent:meta' }, { route: '/shop' }, { route: null }]
    const ids = new Set([findingId(parts), ...others.map(patch => findingId({ ...parts, ...patch }))])
    expect(ids.size).toBe(others.length + 1)
  })

  it('cannot be forged by shifting a separator between fields', () => {
    expect(findingId({ ...parts, checkId: 'a|b', key: 'c' })).not.toBe(findingId({ ...parts, checkId: 'a', key: 'b|c' }))
  })
})
