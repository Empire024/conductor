import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** Separate from the immutable artifact descriptor: a build is not an invitation to restart. */
export interface LocalUpdateOffer {
  version: string
  builder: string
  verified: boolean
  offered: boolean
  commit?: string | null
}
const name = 'conductor-local-offer.json'
export function readLocalUpdateOffer(directory: string, version: string): LocalUpdateOffer | null {
  try {
    const value = JSON.parse(readFileSync(join(directory, name), 'utf8')) as LocalUpdateOffer
    return value.version === version && typeof value.builder === 'string' && typeof value.verified === 'boolean' && typeof value.offered === 'boolean' ? value : null
  } catch { return null }
}
export function writeLocalUpdateOffer(directory: string, offer: LocalUpdateOffer): void {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name), temporary = path + '.tmp'
  writeFileSync(temporary, JSON.stringify(offer))
  renameSync(temporary, path)
}
export function localUpdateGate(offer: LocalUpdateOffer | null, busyCount: number): { promptAllowed: boolean; quietReason?: string } {
  const quietReason = !offer?.verified ? 'This local build has not been verified.'
    : !offer.offered ? 'The builder has not offered this update to the owner.'
      : busyCount ? `${busyCount} tab${busyCount === 1 ? ' is' : 's are'} working. The update will appear when idle.` : undefined
  return { promptAllowed: !quietReason, ...(quietReason ? { quietReason } : {}) }
}
