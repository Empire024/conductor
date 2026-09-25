/**
 * Always-on machines (feature always-on-machines): whether this computer comes back by itself after
 * a reboot or a power cut, with no one at it, and whether Conductor opens at login.
 */

export type LocalReadinessCheckId = 'sleep' | 'boot-unlock' | 'tailscale' | 'conductor' | 'failsafe'

export interface LocalReadinessCheck {
  id: LocalReadinessCheckId
  label: string
  /** null: Conductor could not tell. */
  ok: boolean | null
  detail: string
}

/** Same shape as a node's readiness (src/main/remote-jobs/types.ts NodeReadiness), plus notes. */
export interface LocalMachineReadiness {
  platform: string
  ready: boolean
  checks: LocalReadinessCheck[]
  /** The physical or owner steps still needed, in words. */
  missing: string[]
  /** Things that matter but Conductor cannot read, such as the BIOS power-loss setting. */
  notes: string[]
  checkedAt: string
}

export interface LoginItemState {
  /** Conductor opens when the owner logs in. */
  enabled: boolean
  /** 'system': registered with the OS. 'simulated': a development or test build, which never touches the OS login items. */
  backend: 'system' | 'simulated'
  /** This run was started by the login item, so its window opened minimized without focus. */
  startedAtLogin: boolean
}

export interface AlwaysOnState {
  loginItem: LoginItemState
  readiness: LocalMachineReadiness | null
}
