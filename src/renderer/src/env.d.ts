import type { ConductorBridge } from '../../shared/ipc'

declare global {
  interface Window {
    conductor: ConductorBridge
  }
}

export {}
