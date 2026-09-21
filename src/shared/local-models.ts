/** The locally served models, named once for both processes.
 *
 *  The main process owns the real stack description (ports, GGUF paths, quantization) in
 *  main/local-models/config.ts; none of that may reach the renderer. What the renderer does
 *  need is the canonical id it asks for and the name a person reads, so only those facts
 *  live here. The ids are the contract: they are persisted in tabs, sessions and the local
 *  config alike, and must never be rewritten. */
export const LOCAL_QWEN_9B = 'local/qwen3.5-9b'
export const LOCAL_QWEN_35B = 'local/qwen3.6-35b-a3b'
export const LOCAL_ORNITH_9B = 'local/ornith1.5-9b'
export const LOCAL_MODEL_SETUP_URL = 'https://github.com/Empire024/conductor/blob/main/docs/local-models.md'
export const LOCAL_MODEL_SETUP_ERROR_CODE = 'local-setup-required'

export const LOCAL_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: LOCAL_ORNITH_9B, label: 'Ornith 1.5 9B' },
  { id: LOCAL_QWEN_9B, label: 'Qwen 3.5 9B' },
  { id: LOCAL_QWEN_35B, label: 'Qwen 3.6 35B-A3B' }
]

/** What a tab opens with when no model was chosen, which is also the smaller, faster one. */
export const DEFAULT_LOCAL_MODEL = LOCAL_ORNITH_9B

/** A model the running stack advertises but this build has no name for is shown by its id
 *  rather than hidden: the owner edits that catalog themselves. */
export const localModelLabel = (id?: string): string =>
  LOCAL_MODELS.find(model => model.id === id)?.label ?? (id && id !== 'default' && id !== 'auto' ? id : 'Local model')
