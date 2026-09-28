/** Acceptance-only Conductor launch controls never become provider or tool environment. */
export function providerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (source.CONDUCTOR_PACKAGED_ACCEPTANCE !== '1') return source
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith('CONDUCTOR_PACKAGED_ACCEPTANCE') &&
    !['CONDUCTOR_TEST_USER_DATA', 'CONDUCTOR_TEST_PARENT_PID', 'CONDUCTOR_PROJECTS_ROOT'].includes(key)))
}
