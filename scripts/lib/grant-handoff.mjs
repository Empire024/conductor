// Helpers for permission-grant handoff smokes (VR8f, FX41 and VR9b wrote these inline; new smokes import
// them). A parked instance's renderer is the owner's view; every tab's own control credential is read
// from the briefing its prompt carried (CONDUCTOR_TEST_CONTROL_CAPTURE with _APPEND). Only the Claude
// process is scripts/fixtures/fake-claude.mjs (SYNTHETIC CLASSIFIER: nothing executes).
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, openTab, poll } from '../verify-kit.mjs'

export const B5_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=3 root@192.0.2.10 'lswsctrl restart'"
// As smoke-fx38: the offline models.list offers the wizard's model with CONDUCTOR_TEST_CLAUDE_QUOTA=fable.
export const WIZARD_MODEL = 'claude-fable-5-1'
export const errorText = error => (error instanceof Error ? error.message : String(error)).slice(0, 400)

/** The side files and env a handoff smoke launches with. */
export async function handoffEnv(prefix, extra = {}) {
  const side = await mkdtemp(join(tmpdir(), `conductor-${prefix}-side-`))
  const capture = join(side, 'provider-input.txt'), flagLog = join(side, 'flag-settings.log')
  const env = { CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_CONTROL_CAPTURE_APPEND: '1', CONDUCTOR_TEST_FLAG_SETTINGS_LOG: flagLog, ...extra }
  return { side, capture, flagLog, env }
}

/** Everything bound to one window (`view`, the kit's page()) and the side files of handoffEnv. */
export function grantHandoff(view, { capture, flagLog, model = WIZARD_MODEL, artifacts = 'artifacts/verification' }) {
  const snap = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
  const items = async id => (await snap(id))?.items ?? []
  const grantsState = () => view.evaluate(() => window.conductor.permissionGrants.state())
  const submit = (id, prompt, wizard) => view.evaluate(async ([value, text, wand, chosen]) => {
    await window.conductor.structured.connect(value)
    const state = await window.conductor.structured.snapshot(value)
    const settings = { ...state.settings, ...(wand ? { wizard: true, model: chosen, effort: 'high' } : {}) }
    await window.conductor.structured.saveSettings(value, settings)
    await window.conductor.structured.submit(value, text, settings, [])
  }, [id, prompt, wizard, model])
  // The fixture's init reports model synthetic-claude; the wand needs a frontier model, so set it again.
  const rewizard = id => view.evaluate(async ([value, chosen]) => { const state = await window.conductor.structured.snapshot(value); await window.conductor.structured.saveSettings(value, { ...state.settings, wizard: true, model: chosen, effort: 'high' }) }, [id, model])
  const settled = (id, what, timeoutMs = 30_000) => poll(async () => /^(completed|idle)$/.test((await snap(id))?.phase ?? ''), { timeoutMs, label: what })
  const texts = async (id, role) => (await items(id)).filter(item => item.data.type === 'text' && item.data.role === role).map(item => item.data.text)
  const ran = async (id, rule) => (await texts(id, 'assistant')).filter(text => rule ? text === 'SYNTHETIC classified call ran: ' + rule : text.startsWith('SYNTHETIC classified call ran:')).length
  const told = async (id, prefix = '[Conductor] approved:') => (await texts(id, 'user')).filter(text => text.startsWith(prefix)).length
  /** The last timeline notice for an item id (a denial card's id is auto-denial:<tool use id>). */
  const notice = async (id, itemId) => (await items(id)).filter(item => item.data.type === 'notice' && (item.nativeItemId === itemId || item.id === itemId || item.data.payload?.permissionGrant?.id === itemId)).at(-1)?.data
  /** Every denial card item id in a tab, in order (its own, moved in, or restated as a view of another). */
  const denialCards = async id => [...new Set((await items(id)).filter(item => item.data.type === 'notice' && String(item.nativeItemId ?? '').startsWith('auto-denial:')).map(item => item.nativeItemId))]
  const flags = async () => (await readFile(flagLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const credentialOf = async (marker, intervalMs = 250) => {
    const briefing = await poll(async () => (await readFile(capture, 'utf8').catch(() => '')).split('\u0000').find(text => text.includes(marker) && text.includes('Conductor app control:')) ?? null, { timeoutMs: 30_000, intervalMs, label: `control briefing (${marker})` })
    const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
    return async (method, args = {}) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
      const body = await response.json()
      if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 400)}`)
      return body.result
    }
  }
  const tabRow = title => view.locator('.workspace-tab-row').filter({ has: view.getByText(title, { exact: true }) }).first()
  const article = itemId => view.locator(`article[data-native-item-id="${itemId}"]`)
  /** Brings a tab forward by its id: a handoff chain's successors all share one title ("X (continued)"). */
  const show = async (tab, settleMs = 700) => {
    await call('tabs.focus', { tabId: tab.tabId })
    await new Promise(done => setTimeout(done, settleMs))
  }
  /** How a card names a holder (grantHolderLabel): "<title> · <first 8 of the id's last part>". */
  const holderLabel = tab => `${tab.title} · ${tab.id.split(/[_-]/).filter(Boolean).at(-1).slice(0, 8)}`
  /** What the owner sees of one card in one tab ({tabId, title}): its live answer buttons and its text. */
  const cardView = async (tab, itemId) => {
    await show(tab)
    const card = article(itemId)
    await card.waitFor({ timeout: 5000 }).catch(() => undefined)
    return { buttons: await card.getByRole('button', { name: /^(Approve once|Approve for this session|Deny)$/ }).count(), text: (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300) }
  }
  /** The owner's click: select the tab, then the button in the card. */
  const click = async (tab, itemId, name) => {
    await show(tab)
    const button = article(itemId).getByRole('button', { name, exact: true })
    await button.waitFor({ timeout: 15_000 })
    await button.click()
  }
  const handoffText = first => first + '\n\n' + [['Objective', 'Continue as the wizard; the pool fix waits on the owner.'], ['Constraints', 'Local commits only.'], ['Owned files', 'None.'], ['Verified findings', 'A permission request for the B5 pool fix is waiting on the owner.'], ['Remaining work', 'Run the pool fix once it is approved.'], ['Artifact references', artifacts]].map(([h, l]) => h + '\n- ' + l).join('\n\n')
  /** A wizard tab that has run one first turn (its last word is the capture marker). */
  const wizard = async (title, first) => {
    const tab = await openTab({ provider: 'claude', model, title })
    await rm(capture, { force: true })
    await submit(tab.resourceId, first, true)
    const as = await credentialOf(first.split(' ').at(-1))
    await settled(tab.resourceId, `${title} settles`)
    await rewizard(tab.resourceId)
    await poll(async () => (await as('app.state').catch(() => null))?.wizard === true, { timeoutMs: 15_000, label: `${title} is the wizard` })
    return { id: tab.resourceId, tab, tabId: tab.id, title, as }
  }
  /** agents.handoff({successor:true}) from a wizard; `onPrompt(as)` runs the moment the successor's CLI has its prompt. */
  const handOff = async (from, first, { onPrompt } = {}) => {
    await rm(capture, { force: true })
    const handing = from.as('agents.handoff', { handoff: handoffText(first), successor: true })
    const as = await Promise.race([credentialOf(first.split(' ').at(-1), onPrompt ? 20 : 250), handing.then(() => new Promise(() => {}))])
    const atPrompt = onPrompt ? await onPrompt(as).catch(error => ({ error: errorText(error) })) : undefined
    const result = await handing
    await settled(result.agentSessionId, `${result.title} settles`)
    return { id: result.agentSessionId, title: result.title, tabId: result.tabId, as, result, atPrompt }
  }
  /** Makes a successor the wizard again so it can hand off in turn. */
  const wizardAgain = async tab => {
    await rewizard(tab.id)
    await poll(async () => (await tab.as('app.state').catch(() => null))?.wizard === true, { timeoutMs: 15_000, label: `${tab.title} is the wizard` })
  }
  return { snap, items, grantsState, submit, rewizard, settled, texts, ran, told, notice, denialCards, flags, credentialOf, tabRow, article, show, holderLabel, cardView, click, handoffText, wizard, handOff, wizardAgain }
}
