import { IDEA_ACTION_TYPES, type IdeaActionType, type IdeaRunAction, type IdeaRunRule } from '../../shared/idea-runs'

/**
 * The rules an idea run cannot be talked out of (docs/idea-autopilot.md). They are enforced here,
 * in code, and repeated in every brief so the agents know them; a plan or a report that disagrees
 * is corrected, never obeyed.
 */

export const PROVENANCE_RULE = 'Provenance: generated or AI-edited images, video and audio keep their AI labels, C2PA/content credentials and metadata, and are published with the platform\'s AI-content label (EU AI Act Art. 50, Instagram/Meta and TikTok policies). Never strip, hide or forge AI disclosure; Conductor refuses any action that does.'
export const BRAND_CHECK_RULE = 'Brand and copyright: a brand/copyright check stage runs before anything public. Inspiration is fine; copying another brand\'s name, logo, characters, trade dress, music or footage is not. Name the risks and how the plan avoids them.'
export const CHECKPOINT_RULE = 'Checkpoints: you never create accounts, publish, message people, buy, order or spend yourself without an approved checkpoint. Propose each such step as an action in your report with the exact content; Conductor pauses and asks the owner, then tells you what was approved.'

/** Words that ask for AI disclosure to go away: "strip ... AI", "remove the watermark", "hide that it's AI". */
const STRIP = /\b(strip|remove|delete|hide|erase|scrub|wipe|clean|get rid of|disguise|conceal)\b[^.\n]{0,60}\b(ai|a\.i\.|artificial|generated|watermark|c2pa|content credentials?|provenance|metadata|synthid|label|disclosure)\b/i
const NO_LABEL = /\b(without|no|skip|avoid)\b[^.\n]{0,20}\b(ai[- ]?(label|disclosure|tag)|made with ai|ai[- ]generated label)\b/i
const NOT_AI = /\b(can'?t|cannot|won'?t|nobody can|no one can|not)\b[^.\n]{0,30}\b(tell|detect|see|know)\b[^.\n]{0,30}\b(it'?s|it is|was)\b[^.\n]{0,10}\bai\b/i

/** True when the text asks to remove or hide AI provenance. */
export function asksToStripProvenance(text: string): boolean {
  return STRIP.test(text) || NO_LABEL.test(text) || NOT_AI.test(text)
}

export const isActionType = (value: unknown): value is IdeaActionType => typeof value === 'string' && (IDEA_ACTION_TYPES as readonly string[]).includes(value)

/** Action types that make something public or reach people; a brand check must come first. */
export const PUBLIC_ACTIONS: ReadonlySet<IdeaActionType> = new Set(['publish', 'message', 'create-account'])
/** Action types that move money. */
export const MONEY_ACTIONS: ReadonlySet<IdeaActionType> = new Set(['purchase', 'order', 'spend'])

export type CheckpointVerdict =
  | { status: 'pending' }
  | { status: 'approved' | 'denied'; by: string; note: string }

/**
 * What happens to one proposed action before the owner sees it: the provenance rule refuses
 * stripping AI disclosure outright; a standing rule the owner set for this type on this run
 * answers for them; everything else waits.
 */
export function screenAction(action: IdeaRunAction, rules: readonly IdeaRunRule[]): CheckpointVerdict {
  if (asksToStripProvenance(`${action.summary}\n${action.detail}`)) {
    return { status: 'denied', by: 'Conductor (provenance rule)', note: 'Refused: this action would remove or hide AI disclosure. Publish the media with its AI labels and metadata intact.' }
  }
  const rule = rules.find(entry => entry.actionType === action.type)
  if (rule) return { status: rule.decision === 'approve' ? 'approved' : 'denied', by: 'standing rule', note: `Standing rule for ${action.type} on this run (set by ${rule.createdBy}).` }
  return { status: 'pending' }
}
