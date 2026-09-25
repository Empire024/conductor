/** How a new local terminal tab is labelled. The shell itself is chosen by the main process
 *  (terminal-manager defaultShell): PowerShell on Windows, the owner's $SHELL elsewhere, and zsh,
 *  the macOS default, on a Mac without one. */
export function defaultTerminal(platform: string | undefined): { title: string; shell: string } {
  return platform === 'darwin' ? { title: 'zsh', shell: 'zsh' } : { title: 'PowerShell', shell: 'powershell' }
}

/** The platform the preload reports, or undefined outside a renderer (tests, main). */
export const rendererPlatform = (): string | undefined =>
  (globalThis as { window?: { conductor?: { platform?: string } } }).window?.conductor?.platform
