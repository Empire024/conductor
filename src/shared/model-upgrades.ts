/** Auto model upgrade (docs/model-upgrades.md): Conductor notices a better model, prepares
 *  everything it needs, and asks the owner one OK. Shared by main, app control and the renderer. */

export type UpgradeProvider = 'claude' | 'codex'

/** One entry of a CLI's model catalog, as the catalog probe normalizes it. */
export interface CatalogModel {
  id: string
  displayName: string | null
  description?: string | null
  hidden: boolean
  isDefault: boolean
  /** Codex `model/list` names the model an entry upgrades to. */
  upgrade?: string | null
  efforts?: string[]
}

export interface UpgradeReason { kind: 'catalog-upgrade' | 'newer-version' | 'new-generation' | 'catalog-default' | 'previous-generation'; text: string }

/**
 * - `preparing`: the newer CLI is being installed into a scratch prefix, probed, or its protocol
 *   bump is being built and verified.
 * - `blocked`: preparing stopped; `reason` says why and nothing half-done is left behind.
 * - `ready`: everything is verified; the owner's one OK is awaited.
 * - `applying`: the owner said OK; the CLI, app update and defaults are being switched.
 * - `applied`, `declined`: final for this model.
 */
export type UpgradeState = 'preparing' | 'blocked' | 'ready' | 'applying' | 'applied' | 'declined'

export interface ModelUpgradeOffer {
  /** `<provider>:<model>`; stable, so a decline is remembered per model. */
  id: string
  provider: UpgradeProvider
  model: string
  label: string
  replaces: { model: string; label: string }
  reasons: UpgradeReason[]
  /** One line for the card: "GPT-6.1-Sol is available (better than GPT-6-Astra: …). Switch?" */
  summary: string
  state: UpgradeState
  /** What the upgrade needs: a newer CLI (null when the current CLI already offers the model) and
   *  whether this Conductor must be rebuilt to speak that CLI's protocol. */
  cli: { from: string | null; to: string | null; executable: string | null } | null
  protocolBump: boolean
  /** The verified app build that speaks the new CLI, when one was needed. */
  candidate: { commit: string; verified: boolean } | null
  /** The coworker preparing the protocol bump, while there is one. */
  fixer: { agentId: string; startedAt: string } | null
  reason: string | null
  /** Steps done so far while applying, for the UI and app control. */
  steps: string[]
  createdAt: string
  updatedAt: string
}

export interface ProviderUpgradeWatch {
  provider: UpgradeProvider
  package: string
  /** The owner's own installed CLI. */
  installed: string | null
  /** What new tabs launch: the installed CLI, or the copy an accepted upgrade pinned. */
  launches: string | null
  latest: string | null
  checkedAt: string | null
  error: string | null
}

export interface ModelUpgradesStatus {
  enabled: boolean
  checking: boolean
  lastCheckAt: string | null
  nextCheckAt: string | null
  /** Owner opt-in: a wizard tab may answer the OK for the owner. Off by default. */
  wizardMayAccept: boolean
  providers: ProviderUpgradeWatch[]
  offers: ModelUpgradeOffer[]
  /** Model ids the owner declined, per `<provider>:<model>`, with when. */
  declined: Record<string, string>
}

export const upgradeOfferId = (provider: UpgradeProvider, model: string): string => `${provider}:${model}`
/** An offer the owner can answer right now. */
export const offerAwaitsOwner = (offer: Pick<ModelUpgradeOffer, 'state'>): boolean => offer.state === 'ready'
