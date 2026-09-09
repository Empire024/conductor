export type RuntimeBanner = { title: string; detail: string; resume: boolean; disabled: boolean }
/** A stopped conversation is exactly where people look for the way back, so the notice carries
 *  the resume action itself instead of leaving it buried in Conversation settings. */
export function runtimeBanner(input: { phase: string; historical: boolean; unstarted: boolean; archived: boolean; ready: boolean; resuming: boolean; canResume: boolean }): RuntimeBanner | null {
  const stopped = input.phase === 'disconnected' && !input.unstarted
  if (input.historical || !stopped && input.phase !== 'interrupted') return null
  const cause = stopped ? 'The last operation may be incomplete.' : 'The turn stopped part way through.'
  return {
    title: stopped ? 'Runtime disconnected' : 'Runtime interrupted',
    detail: cause + (input.canResume ? ' Resume to continue this same conversation.' : ' This conversation cannot be reconnected.'),
    resume: input.canResume,
    disabled: !input.ready || input.resuming || input.archived
  }
}
/** The provider rejects a new turn on a stopped runtime by telling you to resume it — which is
 *  what the banner underneath already says, with a button. Two bars for one fact reads as broken. */
export const bannerAbsorbsError = (banner: RuntimeBanner | null, error: string): boolean =>
  Boolean(banner?.resume) && /resume the native conversation/i.test(error)
