/** A preview, subframe, or navigated window is never a structured-control authority. */
export function isStructuredRendererUrl(candidate: string, expected: string): boolean {
  try {
    const actual = new URL(candidate), trusted = new URL(expected)
    if (!['file:', 'http:', 'https:'].includes(trusted.protocol) || actual.protocol !== trusted.protocol || actual.origin !== trusted.origin || actual.username || actual.password) return false
    return trusted.protocol === 'file:' && process.platform === 'win32'
      ? actual.pathname.toLocaleLowerCase() === trusted.pathname.toLocaleLowerCase()
      : actual.pathname === trusted.pathname
  } catch { return false }
}
