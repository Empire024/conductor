import type { AgentSoundCue, AgentSoundProfile } from '../../shared/models'

export interface AgentSoundTone {
  frequency: number
  offset: number
  duration: number
  gain: number
  waveform: OscillatorType
}

const softPlans: Record<AgentSoundCue, AgentSoundTone[]> = {
  complete: [
    { frequency: 392, offset: 0, duration: 0.34, gain: 0.018, waveform: 'sine' },
    { frequency: 493.88, offset: 0.09, duration: 0.38, gain: 0.016, waveform: 'sine' },
    { frequency: 587.33, offset: 0.2, duration: 0.48, gain: 0.014, waveform: 'sine' }
  ],
  question: [
    { frequency: 440, offset: 0, duration: 0.2, gain: 0.014, waveform: 'sine' },
    { frequency: 554.37, offset: 0.12, duration: 0.28, gain: 0.016, waveform: 'sine' }
  ],
  input: [
    { frequency: 659.25, offset: 0, duration: 0.12, gain: 0.013, waveform: 'triangle' },
    { frequency: 659.25, offset: 0.2, duration: 0.15, gain: 0.014, waveform: 'triangle' }
  ]
}

const minimalPlans: Record<AgentSoundCue, AgentSoundTone[]> = {
  complete: [{ frequency: 523.25, offset: 0, duration: 0.28, gain: 0.012, waveform: 'sine' }],
  question: [{ frequency: 493.88, offset: 0, duration: 0.18, gain: 0.011, waveform: 'sine' }],
  input: [{ frequency: 659.25, offset: 0, duration: 0.12, gain: 0.01, waveform: 'triangle' }]
}

let audioContext: AudioContext | null = null

export const getAgentSoundPlan = (profile: AgentSoundProfile, cue: AgentSoundCue): AgentSoundTone[] => {
  if (profile === 'off') return []
  return profile === 'minimal' ? minimalPlans[cue] : softPlans[cue]
}

export const playAgentSound = (profile: AgentSoundProfile, cue: AgentSoundCue): void => {
  const plan = getAgentSoundPlan(profile, cue)
  if (plan.length === 0 || typeof AudioContext === 'undefined') return
  audioContext ??= new AudioContext()
  const context = audioContext
  const schedule = (): void => {
    const base = context.currentTime + 0.015
    for (const tone of plan) {
      const oscillator = context.createOscillator()
      const envelope = context.createGain()
      const startsAt = base + tone.offset
      const endsAt = startsAt + tone.duration
      oscillator.type = tone.waveform
      oscillator.frequency.setValueAtTime(tone.frequency, startsAt)
      envelope.gain.setValueAtTime(0.0001, startsAt)
      envelope.gain.exponentialRampToValueAtTime(tone.gain, startsAt + Math.min(0.035, tone.duration / 3))
      envelope.gain.exponentialRampToValueAtTime(0.0001, endsAt)
      oscillator.connect(envelope)
      envelope.connect(context.destination)
      oscillator.start(startsAt)
      oscillator.stop(endsAt + 0.01)
    }
  }
  if (context.state === 'suspended') void context.resume().then(schedule).catch(() => undefined)
  else schedule()
}
