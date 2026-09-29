import type { AuditPage, AxeResult, CheckContext, ConsentState, ControlCheck, HumanReviewItem, Severity } from '../../../shared/production'
import {
  FindingSet, applicabilityGuard, browserProblem, budgetProblem, consentKeyboardReach, consentUi, draft, emptyCoverage, markTested, mergeCoverage, notRun,
  outcome, planRoutes, review, scopeDevices, throwIfAborted, visit, withPage,
  type KeyboardReach,
} from './technical-support'

/**
 * C13 Accessibility (docs/production-agent.md module M4). Per tested route, on the desktop device:
 *
 * - axe-core (WCAG 2.x A/AA tags) in the `clean` state and, when a cookie banner shows, in the
 *   `accepted` state reached through the audit browser's consent; each violated rule is a finding,
 *   each `incomplete` rule a human-review item;
 * - a bounded keyboard traversal in the clean state: focus stops without a visible indicator, a
 *   keyboard trap, focus escaping an open modal dialog (dialogs a `aria-haspopup="dialog"` button
 *   opens are exercised with Enter), and whether the cookie choices are reachable by Tab;
 * - 200 % zoom (the CSS viewport halves) and the mobile viewport must not scroll horizontally
 *   (WCAG 1.4.10 reflow), with a screenshot of each.
 *
 * A clean run is PASS for the automated portion only: the manual checks automation cannot conclude
 * are always listed for human review, once per control.
 */

export interface AccessibilityCheckOptions {
  /** Routes opened (default 6). */
  maxRoutes?: number
  /** Tab presses per traversal (default 60). */
  maxTabs?: number
  /** How long a page is held after load before it is scanned (default 500 ms). */
  settleMs?: number
}

const CHECK_ID = 'accessibility'
const MAX_INCOMPLETE = 25
const MAX_TARGETS = 10
const DESKTOP = { width: 1366, height: 768 }
const ZOOM = { width: 1280, height: 800, percent: 200 }
const DIALOG_TABS = 12
const MAX_DIALOG_OPENERS = 2

const IMPACT_SEVERITY: Readonly<Record<string, Severity>> = { critical: 'high', serious: 'high', moderate: 'medium', minor: 'low' }
export const severityOfImpact = (impact: string | null): Severity => (impact && IMPACT_SEVERITY[impact]) || 'medium'

// ---------------------------------------------------------------------------------------------
// Keyboard traversal analysis (pure, unit-tested)
// ---------------------------------------------------------------------------------------------

export interface FocusStep {
  key: string
  focusedSelector: string | null
  focusVisible: boolean
  /** Tag name of the focused element (null on the body or outside the document). */
  tag: string | null
  /** A visible modal dialog was open after this key. */
  dialogOpen: boolean
  /** Focus was inside that open modal dialog. */
  inDialog: boolean
}

export interface TraversalAnalysis {
  /** Distinct focus stops without a visible indicator (outline or box-shadow). */
  invisible: string[]
  /** Why focus looks trapped, or null. */
  trap: string | null
  /** Distinct elements outside an open modal dialog that focus reached while it was open. */
  escapes: string[]
}

/** Focus inside an iframe leaves the iframe element as activeElement for every step inside it: never a stop of its own. */
const counts = (step: FocusStep): boolean => !!step.focusedSelector && step.tag !== 'IFRAME'

/**
 * Reads a Tab trace. A trap is the same element keeping focus for 3+ consecutive Tabs, or focus
 * cycling among at most two elements for 6 Tabs while the page has more than two tabbable elements;
 * either only while no modal dialog is open (a modal dialog is supposed to hold focus).
 */
export function analyseTraversal(steps: readonly FocusStep[], tabbable: number): TraversalAnalysis {
  const invisible: string[] = []
  const escapes: string[] = []
  for (const step of steps) {
    if (!counts(step)) continue
    if (!step.focusVisible && !invisible.includes(step.focusedSelector!)) invisible.push(step.focusedSelector!)
    if (step.dialogOpen && !step.inDialog && !escapes.includes(step.focusedSelector!)) escapes.push(step.focusedSelector!)
  }
  let trap: string | null = null
  if (tabbable > 1) {
    let run = 0
    for (const [index, step] of steps.entries()) {
      const same = index > 0 && counts(step) && !step.dialogOpen && step.focusedSelector === steps[index - 1]!.focusedSelector
      run = same ? run + 1 : counts(step) && !step.dialogOpen ? 1 : 0
      if (run >= 3) { trap = `${step.focusedSelector} kept focus for ${run} consecutive Tab presses`; break }
    }
  }
  if (!trap && tabbable > 2) {
    for (let end = 6; end <= steps.length; end++) {
      const window = steps.slice(end - 6, end)
      if (!window.every(step => counts(step) && !step.dialogOpen)) continue
      const distinct = [...new Set(window.map(step => step.focusedSelector!))]
      if (distinct.length <= 2) { trap = `focus cycled among ${distinct.join(' and ')} for 6 Tab presses while the page has ${tabbable} tabbable elements`; break }
    }
  }
  return { invisible, trap, escapes }
}

// ---------------------------------------------------------------------------------------------
// Page scripts
// ---------------------------------------------------------------------------------------------

const VISIBLE_FN = `const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }`

/** Focus position relative to open modal dialogs: `role=dialog|alertdialog` with `aria-modal=true`, or a `<dialog>` shown modally. */
const FOCUS_STATE_SCRIPT = `(() => {
  ${VISIBLE_FN}
  const modal = element => { if (element.tagName === 'DIALOG') { try { return element.matches(':modal') } catch (error) { return element.open } } return element.getAttribute('aria-modal') === 'true' }
  const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')].filter(element => modal(element) && visible(element))
  const active = document.activeElement
  const focused = active && active !== document.body && active !== document.documentElement ? active : null
  return { tag: focused ? focused.tagName : null, dialogOpen: dialogs.length > 0, inDialog: !!focused && dialogs.some(dialog => dialog.contains(focused)) }
})()`

const TABBABLE_SCRIPT = `(() => {
  ${VISIBLE_FN}
  const candidates = document.querySelectorAll('a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, summary, [tabindex], [contenteditable="true"]')
  let count = 0
  for (const element of candidates) { if (element.tabIndex >= 0 && !element.disabled && !element.closest('[inert]') && visible(element)) count++ }
  return count
})()`

/** Marks up to N visible buttons that say they open a dialog; returns how many. */
const MARK_OPENERS_SCRIPT = (max: number) => `(() => {
  ${VISIBLE_FN}
  const found = []
  for (const element of document.querySelectorAll('button[aria-haspopup], [role="button"][aria-haspopup], button[aria-controls]')) {
    if (element.tagName === 'A' || (element.tagName === 'BUTTON' && (element.getAttribute('type') || 'submit').toLowerCase() !== 'button')) continue
    const popup = (element.getAttribute('aria-haspopup') || '').toLowerCase()
    const controlled = element.getAttribute('aria-controls') ? document.getElementById(element.getAttribute('aria-controls')) : null
    const opensDialog = popup === 'dialog' || (controlled && (controlled.tagName === 'DIALOG' || ['dialog', 'alertdialog'].includes(controlled.getAttribute('role'))))
    if (!opensDialog || !visible(element) || element.disabled) continue
    element.setAttribute('data-conductor-a11y-opener', String(found.length))
    found.push(element)
    if (found.length >= ${max}) break
  }
  return found.length
})()`

/**
 * `document.documentElement.scrollWidth > viewport + 1`. The viewport is the layout viewport
 * (`clientWidth`), not `innerWidth`: mobile emulation zooms out to fit over-wide content, and then
 * `innerWidth` grows to the content width and would hide the overflow.
 */
const OVERFLOW_SCRIPT = `(() => {
  const width = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth)
  const scrollWidth = document.documentElement.scrollWidth
  const overflow = scrollWidth > width + 1
  const offenders = []
  const name = element => element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + (typeof element.className === 'string' && element.className.trim() ? '.' + element.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
  if (overflow && document.body) {
    for (const element of document.body.querySelectorAll('*')) {
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) { offenders.push(name(element) + ' (' + Math.round(box.width) + 'px wide)'); if (offenders.length >= 5) break }
    }
  }
  return { overflow, scrollWidth, innerWidth: width, offenders }
})()`

interface Overflow { overflow: boolean; scrollWidth: number; innerWidth: number; offenders: string[] }

async function stepWith(page: AuditPage, key: string): Promise<FocusStep | null> {
  const [step] = await page.keyboard([key])
  if (!step) return null
  const state = await page.evaluate<{ tag: string | null; dialogOpen: boolean; inDialog: boolean }>(FOCUS_STATE_SCRIPT).catch(() => ({ tag: null, dialogOpen: false, inDialog: false }))
  return { ...step, ...state }
}

/** Tabs from the start of a freshly loaded page until focus comes back to its first stop, a trap shows, or `maxTabs`. */
async function traverse(page: AuditPage, maxTabs: number, tabbable: number): Promise<FocusStep[]> {
  const steps: FocusStep[] = []
  let first: string | null = null
  for (let index = 0; index < maxTabs; index++) {
    const step = await stepWith(page, 'Tab')
    if (!step) break
    steps.push(step)
    if (counts(step)) {
      if (first === null) first = step.focusedSelector
      else if (step.focusedSelector === first) break
    }
    if (analyseTraversal(steps, tabbable).trap) break
  }
  return steps
}

interface DialogProbe { opener: string; opened: boolean; steps: FocusStep[] }

/** Opens each dialog opener with the keyboard (focus, Enter), Tabs inside, then Escape. */
async function probeDialogs(page: AuditPage, maxTabs: number): Promise<DialogProbe[]> {
  const found = await page.evaluate<number>(MARK_OPENERS_SCRIPT(MAX_DIALOG_OPENERS)).catch(() => 0)
  const probes: DialogProbe[] = []
  for (let index = 0; index < found; index++) {
    const opener = await page.evaluate<string | null>(`(() => { const element = document.querySelector('[data-conductor-a11y-opener="${index}"]'); if (!element) return null; element.focus(); return element.id ? '#' + element.id : (element.innerText || element.tagName).trim().slice(0, 60) })()`).catch(() => null)
    if (!opener) continue
    await page.keyboard(['Enter'])
    await page.waitFor(150)
    const state = await page.evaluate<{ dialogOpen: boolean }>(FOCUS_STATE_SCRIPT).catch(() => ({ dialogOpen: false }))
    const probe: DialogProbe = { opener, opened: state.dialogOpen, steps: [] }
    if (state.dialogOpen) {
      for (let tab = 0; tab < Math.min(maxTabs, DIALOG_TABS); tab++) {
        const step = await stepWith(page, 'Tab')
        if (!step) break
        probe.steps.push(step)
        if (!step.dialogOpen) break
      }
      await page.keyboard(['Escape']).catch(() => [])
      await page.waitFor(100)
    }
    probes.push(probe)
  }
  await page.evaluate(`document.querySelectorAll('[data-conductor-a11y-opener]').forEach(element => element.removeAttribute('data-conductor-a11y-opener'))`).catch(() => undefined)
  return probes
}

// ---------------------------------------------------------------------------------------------
// Manual checks
// ---------------------------------------------------------------------------------------------

const MANUAL_CHECKS: ReadonlyArray<{ key: string; question: string; why: string }> = [
  {
    key: 'manual:focus-order',
    question: 'Does keyboard focus move in a logical order that follows the visual and reading order on every tested route?',
    why: 'The traversal records the order focus moves in (see the keyboard trace), but whether that order makes sense to a person is a judgement automation cannot make (WCAG 2.4.3).',
  },
  {
    key: 'manual:media-alternatives',
    question: 'Do prerecorded video and audio have accurate captions and transcripts, and audio description where the picture carries information?',
    why: 'axe can see whether a caption track exists, not whether captions are accurate and complete or whether audio description is needed (WCAG 1.2.1-1.2.5).',
  },
  {
    key: 'manual:form-errors',
    question: 'When a form is submitted with mistakes, is each error identified in text, tied to its field, and followed by a suggestion for fixing it?',
    why: 'Error messages appear only after a submission, which the audit does not make on production, and their helpfulness is a judgement (WCAG 3.3.1, 3.3.3).',
  },
  {
    key: 'manual:text-alternatives',
    question: 'Are text alternatives meaningful for the purpose of each image and control (not file names or "image"), and are decorative images marked decorative?',
    why: 'axe checks that an alternative is present, not that it conveys the same information or function as the image (WCAG 1.1.1).',
  },
  {
    key: 'manual:consistency',
    question: 'Are navigation and repeated components in the same order, and identified the same way, across pages?',
    why: 'Consistency needs a person comparing pages side by side; the check scans a bounded sample of routes one at a time (WCAG 3.2.3, 3.2.4).',
  },
  {
    key: 'manual:motion-timing',
    question: 'Is nothing flashing more than three times a second, can moving or auto-updating content be paused, and can time limits be turned off or extended?',
    why: 'Flashing, motion and time limits are behaviour over time that a static scan and a short page visit do not observe (WCAG 2.2.1, 2.2.2, 2.3.1).',
  },
]

export const manualReview = (context: CheckContext): HumanReviewItem[] => MANUAL_CHECKS.map(item => review(context, item.key, item.question, item.why))

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300)

export function createAccessibilityCheck(options: AccessibilityCheckOptions = {}): ControlCheck {
  const maxRoutes = options.maxRoutes ?? 6
  const maxTabs = options.maxTabs ?? 60
  const settleMs = options.settleMs ?? 500
  return {
    controlId: 'C13',
    checkId: CHECK_ID,
    title: 'Accessibility: axe per route and consent state, keyboard traversal, 200 % zoom and mobile reflow',
    requires: ['browser', 'axe'],
    async run(context) {
      const guard = applicabilityGuard(context, CHECK_ID)
      if (guard) return guard
      const missingBrowser = await browserProblem(context)
      if (missingBrowser) return { ...notRun(CHECK_ID, 'UNVERIFIED', missingBrowser), humanReview: manualReview(context) }

      const plan = planRoutes(context, undefined, maxRoutes)
      const coverage = mergeCoverage(emptyCoverage(), plan.coverage)
      const findings = new FindingSet()
      const unconcluded: string[] = []
      const evidence: string[] = []
      const incomplete: HumanReviewItem[] = []
      const observations: string[] = []
      const mobile = scopeDevices(context).includes('mobile')
      if (!mobile) coverage.unobservable.push('Mobile layout not tested: the profile scope lists no mobile device.')
      let acceptedUnavailable = false
      let incompleteDropped = 0

      const scan = async (page: AuditPage, path: string, state: ConsentState): Promise<void> => {
        let result: AxeResult
        try { result = await page.axe() } catch (error) { unconcluded.push(`axe failed on ${path} (${state}): ${message(error)}`); return }
        const ref = await context.evidence.writeJson('axe', `axe results for ${path} (desktop, ${state})`, { route: path, device: 'desktop', consent: state, ...result })
        evidence.push(ref.id)
        observations.push(`${path} (${state}): ${result.engine}, ${result.violations.length} violated rule(s), ${result.incomplete.length} needing review, ${result.passes} passed`)
        for (const violation of result.violations) {
          const targets = violation.nodes.slice(0, MAX_TARGETS).map(node => node.target)
          const more = violation.nodes.length > targets.length ? ` and ${violation.nodes.length - targets.length} more` : ''
          findings.add(draft(context, CHECK_ID, {
            key: `axe:${violation.id}`, route: path, severity: severityOfImpact(violation.impact), confidence: 'confirmed',
            title: `${violation.help} (axe ${violation.id})`,
            expected: `No element violates the axe-core rule ${violation.id} (WCAG 2.x A/AA).`,
            observed: `${violation.nodes.length} element(s) on ${path} in the ${state} state, impact ${violation.impact ?? 'unknown'}: ${targets.join(', ')}${more}`,
            reproduction: [`Open ${path} on desktop in the ${state} consent state`, `Run axe-core with the WCAG 2.x A/AA tags; rule ${violation.id} fails`],
            evidence: [ref.id],
            proposedFix: `Fix each listed element so it satisfies "${violation.help}".`,
          }))
        }
        for (const item of result.incomplete) {
          const key = `axe-incomplete:${item.id}:${path}`
          if (incomplete.some(entry => entry.id === `${context.control.id}:${key}`)) continue
          if (incomplete.length >= MAX_INCOMPLETE) { incompleteDropped++; continue }
          incomplete.push(review(context, key, `${item.help} (axe ${item.id}, ${item.count} element(s) on ${path}): does this pass?`,
            'axe-core could not decide this rule automatically (for example text over an image or a gradient) and marked it incomplete; a person has to judge it.', path, [ref.id]))
        }
      }

      const overflowOf = async (page: AuditPage): Promise<Overflow | null> => {
        await page.waitFor(100)
        return page.evaluate<Overflow>(OVERFLOW_SCRIPT).catch(() => null)
      }

      const shot = async (page: AuditPage, description: string): Promise<string | null> => {
        try { const ref = await page.screenshot(description); evidence.push(ref.id); return ref.id } catch (error) { observations.push(`screenshot failed (${description}): ${message(error)}`); return null }
      }

      for (const route of plan.routes) {
        throwIfAborted(context)
        const path = route.path
        const url = context.url(path)
        let bannerShown = false
        try {
          // Desktop, clean: axe, keyboard traversal, cookie choice reach, 200 % zoom, dialogs.
          await withPage(context, 'desktop', 'clean', async page => {
            const visited = await visit(page, url, settleMs)
            if (!visited.ok) { unconcluded.push(`navigation failed: ${visited.problem}`); return }
            markTested(coverage, path, 'desktop', 'clean')
            await scan(page, path, 'clean')

            const ui = await consentUi(page)
            bannerShown = ui.visible
            const tabbable = await page.evaluate<number>(TABBABLE_SCRIPT).catch(() => 0)
            const steps = await traverse(page, maxTabs, tabbable)
            const reach: KeyboardReach | null = ui.visible ? await consentKeyboardReach(page, maxTabs) : null
            const zoomed = await (async () => {
              await page.setViewport(ZOOM.width, ZOOM.height, ZOOM.percent)
              const overflow = await overflowOf(page)
              const screenshot = await shot(page, `${path} at ${ZOOM.percent} % zoom (desktop ${ZOOM.width}x${ZOOM.height})`)
              await page.setViewport(DESKTOP.width, DESKTOP.height)
              return { overflow, screenshot }
            })()
            const dialogs = await probeDialogs(page, maxTabs)

            const traversal = analyseTraversal(steps, tabbable)
            const dialogEscapes = dialogs.flatMap(probe => analyseTraversal(probe.steps, tabbable).escapes.map(selector => `${selector} (after opening ${probe.opener})`))
            const trace = await context.evidence.writeJson('log', `keyboard traversal of ${path} (desktop, clean)`, {
              route: path, tabbable, maxTabs, steps, consentUi: ui, consentReach: reach, dialogs, analysis: { ...traversal, dialogEscapes },
            })
            evidence.push(trace.id)
            observations.push(`${path}: ${steps.length} Tab press(es) over ${tabbable} tabbable element(s); ${dialogs.length} dialog opener(s) exercised, ${dialogs.filter(probe => probe.opened).length} opened a modal dialog${reach ? `; cookie choices reached by Tab: ${(['accept', 'reject'] as const).filter(choice => reach.reached[choice]).join(', ') || 'none'}` : ''}`)

            if (traversal.invisible.length) {
              findings.add(draft(context, CHECK_ID, {
                key: 'focus-not-visible', route: path, severity: 'medium', confidence: 'likely',
                title: 'Keyboard focus is not visible',
                expected: 'Every element that receives keyboard focus shows a visible focus indicator (WCAG 2.4.7).',
                observed: `${traversal.invisible.length} focus stop(s) on ${path} had no outline or box-shadow while :focus-visible: ${traversal.invisible.slice(0, MAX_TARGETS).join(', ')}. The detector checks outline and box-shadow only; an indicator drawn another way (border, background, underline) is not seen.`,
                reproduction: [`Open ${path} on desktop`, 'Press Tab repeatedly and watch where focus goes'],
                evidence: [trace.id],
                proposedFix: 'Give :focus-visible a clear outline (for example `outline: 3px solid` with enough contrast); never remove the outline without a replacement.',
              }))
            }
            if (traversal.trap) {
              findings.add(draft(context, CHECK_ID, {
                key: 'keyboard-trap', route: path, severity: 'high', confidence: 'likely',
                title: 'Keyboard focus is trapped',
                expected: 'Tab moves focus through the page and back out of every component (WCAG 2.1.2); only an open modal dialog may hold focus.',
                observed: `On ${path} ${traversal.trap}, with no modal dialog open.`,
                reproduction: [`Open ${path} on desktop`, 'Press Tab repeatedly'],
                evidence: [trace.id],
                proposedFix: 'Remove the key handler that stops Tab (or the focus() loop) so focus can leave the component.',
              }))
            }
            const escapes = [...traversal.escapes.map(selector => `${selector} (during the page traversal)`), ...dialogEscapes]
            if (escapes.length) {
              findings.add(draft(context, CHECK_ID, {
                key: 'dialog-focus-escapes', route: path, severity: 'medium', confidence: 'confirmed',
                title: 'Focus leaves an open modal dialog',
                expected: 'While a modal dialog is open, Tab keeps focus inside it until it is closed.',
                observed: `On ${path} focus reached ${escapes.slice(0, MAX_TARGETS).join(', ')} outside the open modal dialog.`,
                reproduction: [`Open ${path} on desktop`, 'Open the dialog with the keyboard (Enter)', 'Press Tab until focus leaves the dialog'],
                evidence: [trace.id],
                proposedFix: 'Use <dialog> with showModal(), or keep focus inside the dialog (and make the rest of the page inert) while it is open.',
              }))
            }
            if (reach && ui.visible) {
              const missing = (['accept', 'reject'] as const).filter(choice => !reach.reached[choice])
              if (missing.length) {
                const detail = missing.map(choice => ui[choice] ? `${choice} is shown but never received focus` : `no ${choice} control was recognised`).join('; ')
                findings.add(draft(context, CHECK_ID, {
                  key: 'cookie-choice-not-keyboard-reachable', route: path, severity: 'high', confidence: 'confirmed',
                  title: 'Cookie choices are not reachable by keyboard',
                  expected: 'Both accepting and rejecting cookies can be done with the keyboard alone (WCAG 2.1.1).',
                  observed: `On ${path} within ${maxTabs} Tab presses: ${detail}.`,
                  reproduction: [`Open ${path} on desktop in a fresh browser profile`, 'Press Tab until the cookie banner choices are reached'],
                  evidence: [trace.id],
                  proposedFix: 'Make every consent choice a real <button> (or give it tabindex="0" and Enter/Space handlers).',
                }))
              }
            }
            if (zoomed.overflow?.overflow) {
              findings.add(draft(context, CHECK_ID, {
                key: 'reflow-200', route: path, severity: 'medium', confidence: 'confirmed',
                title: 'Content scrolls horizontally at 200 % zoom',
                expected: 'At 200 % zoom content reflows without horizontal scrolling (WCAG 1.4.10).',
                observed: `At ${ZOOM.percent} % zoom (CSS viewport ${zoomed.overflow.innerWidth}px) ${path} is ${zoomed.overflow.scrollWidth}px wide${zoomed.overflow.offenders.length ? `; widest offenders: ${zoomed.overflow.offenders.join(', ')}` : ''}.`,
                reproduction: [`Open ${path} in a ${ZOOM.width}x${ZOOM.height} desktop window`, `Zoom to ${ZOOM.percent} %`, 'Scroll sideways'],
                evidence: zoomed.screenshot ? [zoomed.screenshot] : [],
                proposedFix: 'Replace fixed widths with max-width and flexible layouts so the page fits a 640px-wide viewport.',
              }))
            } else if (!zoomed.overflow) {
              unconcluded.push(`the ${ZOOM.percent} % zoom layout of ${path} could not be measured`)
            }
          })

          // Desktop, accepted: axe again with the banner dismissed through the audit browser's consent.
          if (bannerShown && !acceptedUnavailable) {
            await withPage(context, 'desktop', 'accepted', async page => {
              const visited = await visit(page, url, settleMs)
              if (!visited.ok) { unconcluded.push(`navigation failed (accepted): ${visited.problem}`); return }
              const consent = page.consentOutcome()
              if (!consent?.applied) {
                acceptedUnavailable = true
                observations.push(`The audit browser could not accept cookies on ${path}: the accepted state was not tested (tried once, not repeated on later routes).`)
                return
              }
              markTested(coverage, path, 'desktop', 'accepted')
              await scan(page, path, 'accepted')
            })
          } else if (!bannerShown) {
            observations.push(`${path}: no cookie banner in the clean state, so the accepted state is the clean state (tested once).`)
          }

          // Mobile, clean: layout overflow.
          if (mobile) {
            await withPage(context, 'mobile', 'clean', async page => {
              const visited = await visit(page, url, settleMs)
              if (!visited.ok) { unconcluded.push(`navigation failed (mobile): ${visited.problem}`); return }
              markTested(coverage, path, 'mobile', 'clean')
              const overflow = await overflowOf(page)
              const screenshot = await shot(page, `${path} on the mobile viewport`)
              if (!overflow) { unconcluded.push(`the mobile layout of ${path} could not be measured`); return }
              if (overflow.overflow) {
                findings.add(draft(context, CHECK_ID, {
                  key: 'mobile-overflow', route: path, severity: 'medium', confidence: 'confirmed',
                  title: 'Content scrolls horizontally on a phone',
                  expected: 'The page fits the mobile viewport without horizontal scrolling (WCAG 1.4.10).',
                  observed: `On the mobile viewport (${overflow.innerWidth}px) ${path} is ${overflow.scrollWidth}px wide${overflow.offenders.length ? `; widest offenders: ${overflow.offenders.join(', ')}` : ''}.`,
                  reproduction: [`Open ${path} on a phone (412px wide)`, 'Scroll sideways'],
                  evidence: screenshot ? [screenshot] : [],
                  proposedFix: 'Replace fixed widths with max-width and flexible layouts; check images and tables with max-width: 100%.',
                }))
              }
            })
          }
        } catch (error) {
          throwIfAborted(context)
          unconcluded.push(`${path}: ${message(error)}`)
        }
      }

      const budget = budgetProblem(context)
      if (budget) unconcluded.push(budget)
      if (incompleteDropped) observations.push(`${incompleteDropped} further axe incomplete item(s) not listed (bound of ${MAX_INCOMPLETE}).`)

      const manual = manualReview(context)
      const list = findings.list()
      if (!list.length && !unconcluded.length) observations.unshift(`PASS for the automated portion; ${manual.length} manual checks listed for human review`)
      return outcome(CHECK_ID, { findings: list, unconcluded, evidence, humanReview: [...incomplete, ...manual], coverage, observations })
    },
  }
}

export const accessibilityCheck = createAccessibilityCheck()
