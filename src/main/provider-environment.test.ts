import { describe, expect, it } from 'vitest'
import { providerEnvironment } from './provider-environment'

describe('provider launch environment', () => {
  it('removes packaged acceptance controls and profile paths without modifying the host or provider credentials', () => {
    const source = { CONDUCTOR_PACKAGED_ACCEPTANCE: '1', CONDUCTOR_PACKAGED_ACCEPTANCE_EXE: 'fixture.exe', CONDUCTOR_PACKAGED_ACCEPTANCE_SHA256: 'hash', CONDUCTOR_PACKAGED_ACCEPTANCE_VERSION: 'version', CONDUCTOR_TEST_USER_DATA: 'profile', CONDUCTOR_TEST_PARENT_PID: '123', CONDUCTOR_PROJECTS_ROOT: 'projects', PATH: 'bin', ANTHROPIC_API_KEY: 'test-only' }
    expect(providerEnvironment(source)).toEqual({ PATH: 'bin', ANTHROPIC_API_KEY: 'test-only' })
    expect(source.CONDUCTOR_TEST_USER_DATA).toBe('profile')
  })
  it('preserves normal and unpackaged fixture environments', () => {
    const source = { CONDUCTOR_TEST_USER_DATA: 'unpackaged-fixture', PATH: 'bin' }
    expect(providerEnvironment(source)).toBe(source)
  })
})
