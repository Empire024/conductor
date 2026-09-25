export const SETTINGS_SECTIONS = [
  { id: 'general', title: 'General', description: 'Choose where you work and how your workspace behaves.', keywords: 'managed projects folder location new files default file extension hidden dotfiles ctrl e search interface zoom reset' },
  { id: 'appearance', title: 'Appearance', description: 'Choose your colors and when day and night versions switch.', keywords: 'color theme palette day night auto automatic' },
  { id: 'sounds', title: 'Sounds', description: 'Choose the cues you hear when an agent needs you.', keywords: 'agent sounds profile soft chimes minimal tones off preview done completion question input' },
  { id: 'usage', title: 'Usage', description: 'Set a default limit for your conversations.', keywords: 'usage cap allowance weekly short rolling window tokens budget account points consumed measured against finished coworkers close tabs idle cli process release memory' },
  { id: 'machines', title: 'Machines', description: 'Connect your computers and control them from here.', keywords: 'remote control account machines github sign in invite device pairing relay tailscale advanced' },
  { id: 'phone', title: 'Phone', description: 'Set up phone access and connect your phone to this PC.', keywords: 'phone access iphone android tailscale qr certificate https notifications pairing devices setup' },
  { id: 'updates', title: 'Updates', description: 'Check for updates and choose which builds you receive.', keywords: 'installed app updates local test builds folder github releases version check now' },
  { id: 'runtimes', title: 'Runtimes', description: 'Check the coding tools available on this PC.', keywords: 'frontier runtimes provider cli path claude codex grok xai gemini deepseek docs install' },
  { id: 'debug', title: 'Debug', description: 'Capture local events to help troubleshoot a problem.', keywords: 'debug tools logging console warnings errors issue reports' }
] as const

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id']

export function matchingSettingsSections(query: string): SettingsSectionId[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return SETTINGS_SECTIONS.filter(section => {
    const text = `${section.title} ${section.description} ${section.keywords}`.toLocaleLowerCase()
    return words.every(word => text.includes(word))
  }).map(section => section.id)
}

export function resolveSettingsSection(initialSection?: string, remembered: SettingsSectionId = 'general'): SettingsSectionId {
  return SETTINGS_SECTIONS.find(section => section.id === initialSection)?.id ?? remembered
}
