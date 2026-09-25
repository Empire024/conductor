import { useEffect, useRef, useState } from 'react'
import { BellRing, Check, Copy, Download, ExternalLink, Lock, Pencil, RefreshCw, ShieldAlert, Smartphone, Wifi, X } from 'lucide-react'
import type { PhoneAccessState, PhoneDevice, PhoneExposure } from '../../../shared/phone-access'
import { DEFAULT_PHONE_PORT, PHONE_LOCK_IDLE_MINUTES, TAILSCALE_APP_LINKS, TAILSCALE_DNS_ADMIN_URL, trustPageUrl } from '../../../shared/phone-access'
import { qrSvg } from '../../../shared/qr-code'
import {
  accessStatus,
  certificateUrl,
  checkedText,
  chosenEndpoint,
  countdownText,
  endpointChoices,
  exposureExplanation,
  fingerprintGroups,
  notificationLabel,
  notificationStep,
  notificationTarget,
  pairStepStatus,
  phoneTailscaleStep,
  portProblem,
  portToCommit,
  pushFailureWarning,
  recommendedEndpointOf,
  recommendedEndpointSentence,
  relativeTime,
  renameToCommit,
  stepStateWord,
  tailnetOf,
  tailscaleCertificateStep,
  tailscaleCertificateWord,
  testResultText,
  type SetupStepStatus
} from './phone-access-view'
import './PhoneAccessSettings.css'

const fail = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/**
 * A QR code, drawn from our own encoder rather than fetched from anywhere.
 *
 * The markup goes in through dangerouslySetInnerHTML because it is a string we generated from a URL
 * the main process minted or a constant in the contract - no user text reaches it. A throw is still
 * caught: a failed encode should cost the owner a QR code, not the whole settings page.
 */
const qrMarkup = (text: string): string => {
  try { return qrSvg(text, { moduleSize: 4, margin: 2, dark: '#0b0e12', light: '#ffffff' }) } catch { return '' }
}

type PhonePlatform = 'ios' | 'android'

/**
 * Phone access, as the owner sets it up from the desktop: the switch and the address to keep at the
 * top, then four numbered steps, each with a QR code, a status and a way to try again.
 *
 * The panel never decides anything itself: every switch, the port and every pairing act goes to the
 * main process, which answers with the whole new state, and every step's status is read from that
 * state. That is why nothing here is optimistic - a phone believing it is paired when the listener
 * never started is exactly the confusion this page exists to prevent.
 */
export function PhoneAccessSettings(): React.JSX.Element {
  const [state, setState] = useState<PhoneAccessState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  /** The port being typed, before it is committed; null while the box shows the saved one. */
  const [port, setPort] = useState<string | null>(null)
  const [portError, setPortError] = useState('')
  const [copied, setCopied] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [tested, setTested] = useState<Record<string, string>>({})
  const [savedTo, setSavedTo] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [platform, setPlatform] = useState<PhonePlatform>('ios')
  /** The address the owner picked for the pairing code; null follows the recommended one. */
  const [picked, setPicked] = useState<string | null>(null)
  /**
   * The phones paired when the page first heard from the main process. Pairing is done for a phone
   * that is not in here; one paired earlier may be holding an address that no longer answers.
   */
  const known = useRef<Set<string> | null>(null)
  /** The phone lock code being typed; it crosses to the main process once, to be hashed there. */
  const [lockCode, setLockCode] = useState('')
  const [lockConfirm, setLockConfirm] = useState('')
  const [lockProblem, setLockProblem] = useState('')

  const receive = (fresh: PhoneAccessState): void => {
    if (!known.current) known.current = new Set(fresh.devices.map(device => device.id))
    setState(fresh)
  }

  useEffect(() => {
    void window.conductor.phone.state().then(receive).catch(reason => setError(fail(reason)))
    // Anything else can change this: a phone pairing, a phone joining the tailnet, the listener
    // losing its address. The subscription is the only way the page hears about those, so it is
    // also the only thing that keeps the step statuses honest while it sits open.
    return window.conductor.phone.onChanged(receive)
  }, [])

  const counting = Boolean(state?.pairing)
  const loaded = state !== null
  useEffect(() => {
    // A pairing code needs a second-by-second countdown; "last seen" and "checked" age in minutes
    // and do not, so the page does not re-render every second for the rest of its open life.
    const period = counting ? 1000 : loaded ? 30_000 : 0
    if (!period) return
    const timer = setInterval(() => setNow(Date.now()), period)
    return () => clearInterval(timer)
  }, [counting, loaded])

  async function attempt<T>(label: string, action: () => Promise<T>, done: (value: T) => void): Promise<void> {
    setBusy(label)
    setError('')
    try { done(await action()) } catch (reason) { setError(fail(reason)) } finally { setBusy('') }
  }

  /** Every mutation answers with the whole new state, so there is never anything to re-fetch. */
  const apply = (label: string, action: () => Promise<PhoneAccessState>): void => { void attempt(label, action, receive) }

  /** Re-reads Tailscale. A main process older than the setup steps has no check(), only state(). */
  const recheck = (label: string): void => {
    const phone = window.conductor.phone
    apply(label, () => typeof phone.check === 'function' ? phone.check() : phone.state())
  }

  const copy = (key: string, value: string): void => {
    void window.conductor.system.copyText(value).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(''), 1500)
    })
  }

  const openLink = (url: string): void => {
    void window.conductor.system.openExternal(url).catch(reason => setError(fail(reason)))
  }

  const working = busy !== ''
  const settings = state?.settings

  const commitPort = (value: string): void => {
    const problem = portProblem(value)
    setPortError(problem)
    if (problem || !settings) return
    const next = portToCommit(value, settings.port)
    // Unchanged is not worth a restart of the listener, and the box goes back to the saved value.
    if (next === null) { setPort(null); return }
    void attempt('port', () => window.conductor.phone.setSettings({ port: next }), fresh => { receive(fresh); setPort(null) })
  }

  const commitRename = (device: PhoneDevice): void => {
    setRenaming(null)
    const name = renameToCommit(draftName, device.name)
    if (name) apply(`rename-${device.id}`, () => window.conductor.phone.rename(device.id, name))
  }

  const revoke = (device: PhoneDevice): void => {
    // Revoking is not undoable from here - that phone has to be paired again - so it is confirmed.
    if (!window.confirm(`Revoke ${device.name}? It stops seeing anything here until you pair it again.`)) return
    apply(`revoke-${device.id}`, () => window.conductor.phone.revoke(device.id))
  }

  const testNotification = (device: PhoneDevice): void => {
    void attempt(`test-${device.id}`, () => window.conductor.phone.testNotification(device.id),
      result => setTested(current => ({ ...current, [device.id]: testResultText(result) })))
  }

  const saveLockCode = (): void => {
    if (!/^[0-9]{6}$/.test(lockCode)) { setLockProblem('The code is exactly six digits.'); return }
    if (lockCode !== lockConfirm) { setLockProblem('The two codes differ.'); return }
    setLockProblem('')
    void attempt('lock-set', () => window.conductor.phone.setLockCode(lockCode), fresh => { receive(fresh); setLockCode(''); setLockConfirm('') })
  }

  const removeLockCode = (): void => {
    if (!window.confirm('Remove the phone code? Paired phones then open Conductor without one, and the phone terminal closes.')) return
    apply('lock-remove', () => window.conductor.phone.removeLockCode())
  }

  const copyButton = (key: string, value: string, title: string): React.JSX.Element => (
    <button type="button" title={title} aria-label={title} onClick={() => copy(key, value)}>
      {copied === key ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )

  /** The link a QR code carries, as text the owner can select, copy or type. */
  const linkLine = (key: string, value: string): React.JSX.Element => (
    <div className="phone-url">
      <code>{value}</code>
      {copyButton(key, value, 'Copy the link')}
    </div>
  )

  const qr = (text: string): React.JSX.Element => (
    <div className="phone-qr phone-qr-step" aria-hidden="true" dangerouslySetInnerHTML={{ __html: qrMarkup(text) }} />
  )

  const chip = (status: SetupStepStatus): React.JSX.Element => (
    <span className="phone-chip" data-state={status.state}>{stepStateWord(status.state)}</span>
  )

  /** The fact behind a chip, coloured the way the status lines above are. */
  const fact = (status: SetupStepStatus): React.JSX.Element => (
    <p className={status.state === 'done' ? 'phone-status' : status.state === 'problem' ? 'phone-error' : 'phone-warning'}>
      {status.state === 'done' ? <Check size={12} /> : <ShieldAlert size={12} />}
      <span>{status.text}{status.fix ? ` ${status.fix}` : ''}</span>
    </p>
  )

  const checkButton = (label: string): React.JSX.Element => (
    <button type="button" disabled={working} onClick={() => recheck(label)}>
      <RefreshCw size={12} className={busy === label ? 'phone-spin' : undefined} /> {busy === label ? 'Checking…' : 'Check again'}
    </button>
  )

  const stepHead = (number: number, title: string, status: SetupStepStatus): React.JSX.Element => (
    <div className="phone-step-head">
      <span className="phone-step-number" data-state={status.state} aria-hidden="true">{status.state === 'done' ? <Check size={12} /> : number}</span>
      <strong>{title}</strong>
      {chip(status)}
    </div>
  )

  if (!state || !settings) {
    return (
      <section className="phone-access-settings">
        <div className="settings-section-title">
          <Smartphone size={14} />
          <div>
            <strong>Phone access</strong>
            <span>Watch, answer and start work from your phones. Notifications reach them even when the app is closed.</span>
          </div>
        </div>
        {error && <p className="phone-error"><ShieldAlert size={12} /> {error}</p>}
        {!error && <p className="phone-hint">Reading this computer&apos;s phone listener…</p>}
      </section>
    )
  }

  const tailnet = tailnetOf(state.tailscale)
  const status = accessStatus(state)
  const recommended = recommendedEndpointOf(state)
  const caUrl = certificateUrl(recommended)
  const trustUrl = recommended ? trustPageUrl(recommended) : ''
  const pairing = state.pairing ?? null
  const countdown = pairing ? countdownText(pairing.expiresAt, now) : ''
  const choices = endpointChoices(state.endpoints, recommended, tailnet)
  const pairEndpoint = chosenEndpoint(picked, state.endpoints, recommended)
  const pairingElsewhere = Boolean(pairing?.endpoint && pairEndpoint && pairing.endpoint !== pairEndpoint)
  const appLink = TAILSCALE_APP_LINKS[platform]

  const step1 = phoneTailscaleStep(tailnet)
  const step2 = tailscaleCertificateStep(tailnet, settings.tailscaleCertificate)
  const step3 = pairStepStatus(state.devices, known.current, pairing, state.listening)
  const step4 = notificationStep(state.devices, settings.notifications, state.pushConfigured)
  const notifyTarget = notificationTarget(state.devices)

  return (
    <section className="phone-access-settings">
      <div className="settings-section-title">
        <Smartphone size={14} />
        <div>
          <strong>Phone access</strong>
          <span>Watch, answer and start work from your phones. Notifications reach them even when the app is closed.</span>
        </div>
      </div>

      {error && <p className="phone-error"><ShieldAlert size={12} /> {error}</p>}

      <div className="phone-card phone-top">
        <label className="phone-row">
          <span>
            <strong>Let my phones control this Conductor</strong>
            <small>Off unless you turn it on, here. A phone still has to be paired in step 3 before it sees anything.</small>
          </span>
          <input type="checkbox" checked={settings.enabled} disabled={working}
            onChange={event => apply('enabled', () => window.conductor.phone.setSettings({ enabled: event.target.checked }))} />
        </label>

        {settings.enabled && status.kind === 'ok' && <p className="phone-status"><Wifi size={12} /> {status.text}</p>}
        {settings.enabled && status.kind === 'warning' && <p className="phone-warning"><ShieldAlert size={12} /> {status.text}</p>}
        {status.kind === 'error' && <p className="phone-error"><ShieldAlert size={12} /> {status.text}</p>}

        {settings.enabled && state.listening && recommended && (
          <div className="phone-keep">
            <span>Address for your phone</span>
            {linkLine('recommended', recommended)}
            <small>{recommendedEndpointSentence(recommended, tailnet)}</small>
          </div>
        )}
      </div>

      <h3 className="phone-steps-title">Set up your phone</h3>

      {/* Step 1: the phone joins the tailnet, so the address above answers away from home. */}
      <div className="phone-card phone-step" data-step="1" data-state={step1.state}>
        {stepHead(1, 'Tailscale on the phone', step1)}
        <div className="phone-step-body">
          {qr(appLink)}
          <div className="phone-step-detail">
            <p className="phone-step-text">
              Scan this with the phone&apos;s camera and install Tailscale. Sign in with
              {tailnet.loginName ? <> <strong>{tailnet.loginName}</strong>, the account this computer uses,</> : ' the same account as this computer'} and keep Tailscale on.
            </p>
            {linkLine('tailscale-app', appLink)}
            <button type="button" className="phone-link-button" onClick={() => setPlatform(platform === 'ios' ? 'android' : 'ios')}>
              {platform === 'ios' ? 'Android phone? Show the Play Store link' : 'iPhone? Show the App Store link'}
            </button>
            {fact(step1)}
            <div className="phone-actions">
              {checkButton('check-tailscale')}
              {step1.state === 'problem' && !tailnet.installed && (
                <button type="button" onClick={() => openLink(TAILSCALE_APP_LINKS.any)}><ExternalLink size={12} /> Get Tailscale for this computer</button>
              )}
            </div>
            <small className="phone-checked">{checkedText(tailnet.checkedAt, now)}</small>
          </div>
        </div>
      </div>

      {/* Step 2: without a trusted certificate the phone refuses the address, and a Home Screen app shows only a blank page. */}
      <div className="phone-card phone-step" data-step="2" data-state={step2.state}>
        {stepHead(2, 'Make the address trusted', step2)}
        <p className="phone-step-text">Your phone has to trust this computer before it opens the app. Pick one of two ways.</p>

        <div className="phone-way">
          <strong className="phone-way-title">Tailscale certificate <em>Recommended</em></strong>
          <p className="phone-hint">Tailscale gets a certificate every phone already trusts, so there is nothing to install on the phone.</p>
          {tailnet.httpsEnabled === false && tailnet.certificate !== 'active' ? (
            <div className="phone-step-body">
              {qr(TAILSCALE_DNS_ADMIN_URL)}
              <div className="phone-step-detail">
                <p className="phone-step-text">Open the Tailscale DNS page, here or on the phone, and turn on HTTPS Certificates. Then check again.</p>
                {linkLine('tailscale-dns', TAILSCALE_DNS_ADMIN_URL)}
                {fact(step2)}
                <div className="phone-actions">
                  <button type="button" className="phone-primary" onClick={() => openLink(TAILSCALE_DNS_ADMIN_URL)}><ExternalLink size={12} /> Open the Tailscale DNS page</button>
                  {checkButton('check-https')}
                </div>
              </div>
            </div>
          ) : (
            <>
              {fact(step2)}
              <div className="phone-actions">
                {step2.state === 'problem' && settings.tailscaleCertificate && (
                  <button type="button" disabled={working} onClick={() => apply('tailscale-retry', () => window.conductor.phone.setSettings({ tailscaleCertificate: true }))}>
                    <RefreshCw size={12} /> Ask Tailscale again
                  </button>
                )}
                {checkButton('check-https')}
              </div>
            </>
          )}
          <label className="phone-row">
            <span>
              <strong>Get a trusted certificate from Tailscale</strong>
              <small>
                Certificates are public: the name {tailnet.dnsName ? <code>{tailnet.dnsName}</code> : 'of this computer'} appears in certificate logs anyone can search.
                Turn this on only if that name says nothing you would keep private.
              </small>
            </span>
            <input type="checkbox" checked={settings.tailscaleCertificate} disabled={working}
              onChange={event => apply('tailscale-certificate', () => window.conductor.phone.setSettings({ tailscaleCertificate: event.target.checked }))} />
          </label>
          <div className="phone-endpoint">
            <div><span>Tailscale certificate</span><code>{tailscaleCertificateWord(tailnet.certificate)}</code></div>
          </div>
          {tailnet.message && tailnet.certificate !== 'failed' && <p className="phone-hint">{tailnet.message}</p>}
        </div>

        <div className="phone-way">
          <strong className="phone-way-title">Conductor certificate</strong>
          {trustUrl ? (
            <div className="phone-step-body">
              {qr(trustUrl)}
              <div className="phone-step-detail">
                <p className="phone-step-text">Scan this, open it in Safari, and install the certificate this computer made. Check the fingerprint matches.</p>
                {linkLine('trust', trustUrl)}
                <div className="phone-endpoint">
                  <div><span>Fingerprint</span><code>{fingerprintGroups(state.caFingerprint) || 'Created when the listener first starts'}</code></div>
                </div>
                <p className="phone-hint">Nothing tells this computer when the phone trusts it. This way is done when the phone opens the app without a warning.</p>
              </div>
            </div>
          ) : (
            <p className="phone-hint">The code for this appears while this computer is listening.</p>
          )}
          <div className="phone-actions">
            <button type="button" disabled={working || !state.caFingerprint}
              onClick={() => void attempt('certificate', () => window.conductor.phone.saveCertificate(), path => setSavedTo(path ?? ''))}>
              <Download size={13} /> Save certificate…
            </button>
            <button type="button" disabled={!caUrl} onClick={() => copy('ca', caUrl)}>
              {copied === 'ca' ? <Check size={13} /> : <Copy size={13} />} Copy download link
            </button>
          </div>
          {savedTo && <small className="phone-saved">Saved to {savedTo}</small>}
          <details className="phone-advanced">
            <summary>Steps on the phone</summary>
            <div className="phone-platform">
              <strong>iPhone and iPad</strong>
              <ol>
                <li>Open the link in Safari. Other browsers cannot install a profile; the page offers Open in Safari.</li>
                <li>Allow the profile when Safari asks.</li>
                <li>Settings → Profile Downloaded → Install.</li>
                <li>Settings → General → About → Certificate Trust Settings, and turn on full trust for Conductor.</li>
              </ol>
              <strong>Android</strong>
              <ol>
                <li>Open the download link and save the file.</li>
                <li>Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate.</li>
                <li>Pick the downloaded file and confirm.</li>
              </ol>
            </div>
          </details>
        </div>
      </div>

      {/* Step 3: the code rides in the QR's fragment, so scanning both opens the address and fills it in. */}
      <div className="phone-card phone-step phone-link" data-step="3" data-state={step3.state}>
        {stepHead(3, 'Pair', step3)}
        {choices.length > 1 && (
          <fieldset className="phone-choices" disabled={working}>
            <legend>Address in the code</legend>
            {choices.map(choice => (
              <label key={choice.endpoint} className="phone-choice">
                <input type="radio" name="phone-pair-endpoint" value={choice.endpoint} checked={choice.endpoint === pairEndpoint}
                  onChange={() => setPicked(choice.endpoint)} />
                <span><strong>{choice.label}</strong><code>{choice.endpoint}</code></span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="phone-step-body">
          {pairing ? qr(pairing.url) : <div className="phone-qr-empty" aria-hidden="true">Code appears here</div>}
          <div className="phone-step-detail">
            <p className="phone-step-text">Scan the code with the phone&apos;s camera. It is good for ten minutes and pairs one phone.</p>
            {pairing && (
              <>
                <div className="phone-code">
                  <code>{pairing.code}</code>
                  {copyButton('code', pairing.code, 'Copy the code')}
                </div>
                {linkLine('url', pairing.url)}
                {countdown && <small className="phone-countdown">{countdown}</small>}
                {pairingElsewhere && <p className="phone-warning"><ShieldAlert size={12} /> This code names {pairing.endpoint}. Show a new code to use the address you picked.</p>}
              </>
            )}
            {fact(step3)}
            <div className="phone-actions">
              <button type="button" className="phone-primary" disabled={working || !state.listening}
                onClick={() => apply('pair', () => window.conductor.phone.pair(pairEndpoint ?? undefined))}>
                {pairing ? 'Show a new code' : 'Show pairing code'}
              </button>
              {pairing && <button type="button" disabled={working} onClick={() => apply('cancel-pairing', () => window.conductor.phone.cancelPairing())}>Cancel</button>}
            </div>
          </div>
        </div>
        <ul className="phone-notes">
          <li>If the camera opens Chrome, the page offers Open in Safari. Tap it.</li>
          <li>On iPhone, pair inside the Home Screen app: iOS keeps its storage apart from Safari.</li>
          <li>Already have Conductor on the Home Screen? Open it and type the code there.</li>
        </ul>
      </div>

      {/* Step 4: iOS delivers web push only to a Home Screen web app. */}
      <div className="phone-card phone-step" data-step="4" data-state={step4.state}>
        {stepHead(4, 'Home Screen and notifications', step4)}
        <div className="phone-step-body">
          {recommended ? qr(recommended) : <div className="phone-qr-empty" aria-hidden="true">Needs the listener</div>}
          <div className="phone-step-detail">
            <p className="phone-step-text">
              Open the address in Safari, tap Share, then Add to Home Screen. Open Conductor from the Home Screen and
              turn notifications on under Phone.
            </p>
            {recommended && linkLine('home', recommended)}
            {fact(step4)}
            <div className="phone-actions">
              {notifyTarget && (
                <button type="button" disabled={working} onClick={() => testNotification(notifyTarget)}>
                  <BellRing size={12} /> Test notification
                </button>
              )}
              <button type="button" disabled={working} onClick={() => apply('check-push', () => window.conductor.phone.state())}>
                <RefreshCw size={12} className={busy === 'check-push' ? 'phone-spin' : undefined} /> Check again
              </button>
            </div>
            {notifyTarget && tested[notifyTarget.id] && <small className="phone-hint">{tested[notifyTarget.id]}</small>}
          </div>
        </div>
      </div>

      <div className="phone-card">
        <strong className="phone-card-title"><Smartphone size={13} /> Paired phones</strong>
        {!state.devices.length && <p className="phone-hint">No phones paired yet.</p>}
        {state.devices.map(device => (
          <div className="phone-device" key={device.id}>
            <div className="phone-device-head">
              {renaming === device.id ? (
                <input className="phone-rename" autoFocus value={draftName} maxLength={60}
                  onChange={event => setDraftName(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') { setDraftName(device.name); event.currentTarget.blur() }
                  }}
                  onBlur={() => commitRename(device)} />
              ) : (
                <strong title="Double-click to rename" onDoubleClick={() => { setRenaming(device.id); setDraftName(device.name) }}>{device.name}</strong>
              )}
              <i className="phone-dot" data-connected={device.connected} title={device.connected ? 'Open right now' : 'Not connected'} />
              {renaming !== device.id && (
                <button type="button" className="phone-icon" title="Rename this phone" onClick={() => { setRenaming(device.id); setDraftName(device.name) }}>
                  <Pencil size={12} />
                </button>
              )}
            </div>
            <small>{notificationLabel(device)} · last seen {relativeTime(device.lastSeenAt, now)}</small>
            {pushFailureWarning(device) && <small className="phone-problem">{pushFailureWarning(device)}</small>}
            <div className="phone-actions">
              <button type="button" disabled={working} onClick={() => testNotification(device)}>
                <BellRing size={12} /> Test notification
              </button>
              <button type="button" disabled={working} title="Revoke this phone's access" onClick={() => revoke(device)}><X size={12} /> Revoke</button>
            </div>
            {tested[device.id] && <small className="phone-hint">{tested[device.id]}</small>}
          </div>
        ))}
      </div>

      <div className="phone-card phone-lock">
        <strong className="phone-card-title"><Lock size={13} /> Phone lock</strong>
        <p className="phone-hint">
          {state.lock.configured
            ? `Every phone asks for the 6-digit code before it shows anything, and again before it opens a terminal.${state.lock.unlockedDevices.length ? ` ${state.lock.unlockedDevices.length} unlocked right now.` : ''}`
            : 'Off. A paired phone opens Conductor without a code, and the phone terminal stays closed.'}
        </p>
        {state.lock.lockedOut && (
          <p className="phone-error"><ShieldAlert size={12} /> Locked out after {state.lock.failures} wrong codes. No phone can unlock until you reset it.</p>
        )}
        {!state.lock.lockedOut && state.lock.failures > 0 && (
          <p className="phone-warning">{state.lock.failures} wrong {state.lock.failures === 1 ? 'code' : 'codes'} in a row; five lock every phone out.</p>
        )}
        <div className="phone-lock-form">
          <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} placeholder={state.lock.configured ? 'New code' : '6-digit code'}
            aria-label="Phone code" value={lockCode} disabled={working}
            onChange={event => { setLockCode(event.target.value.replace(/\D/g, '')); setLockProblem('') }} />
          <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} placeholder="Again"
            aria-label="Phone code again" value={lockConfirm} disabled={working}
            onChange={event => { setLockConfirm(event.target.value.replace(/\D/g, '')); setLockProblem('') }}
            onKeyDown={event => { if (event.key === 'Enter') saveLockCode() }} />
          <button type="button" disabled={working || !lockCode} onClick={saveLockCode}>{state.lock.configured ? 'Change code' : 'Set code'}</button>
        </div>
        {lockProblem && <p className="phone-error"><ShieldAlert size={12} /> {lockProblem}</p>}
        {state.lock.configured && (
          <>
            <label className="phone-row">
              <span>
                <strong>Lock after</strong>
                <small>An unlocked phone locks after this long untouched, and when the app has been in the background for a minute.</small>
              </span>
              <select value={state.lock.idleMinutes} disabled={working}
                onChange={event => apply('lock-idle', () => window.conductor.phone.setLockIdle(Number(event.target.value)))}>
                {PHONE_LOCK_IDLE_MINUTES.map(minutes => <option key={minutes} value={minutes}>{minutes} {minutes === 1 ? 'minute' : 'minutes'}</option>)}
              </select>
            </label>
            <div className="phone-actions">
              {(state.lock.lockedOut || state.lock.failures > 0) && (
                <button type="button" disabled={working} onClick={() => apply('lock-reset', () => window.conductor.phone.resetLock())}><RefreshCw size={12} /> Reset attempts</button>
              )}
              <button type="button" disabled={working || !state.lock.unlockedDevices.length} onClick={() => apply('lock-all', () => window.conductor.phone.lockPhones())}><Lock size={12} /> Lock every phone now</button>
              <button type="button" disabled={working} onClick={removeLockCode}><X size={12} /> Remove code</button>
            </div>
          </>
        )}
      </div>

      <details className="phone-card phone-advanced phone-advanced-card">
        <summary>Advanced</summary>
        <div className="phone-advanced-body">
          <label className="phone-row">
            <span>
              <strong>Phones may reach this computer</strong>
              <small>{exposureExplanation(settings.exposure, tailnet)}</small>
            </span>
            <select value={settings.exposure} disabled={working}
              onChange={event => apply('exposure', () => window.conductor.phone.setSettings({ exposure: event.target.value as PhoneExposure }))}>
              <option value="network">This network</option>
              <option value="tailscale">Only through Tailscale</option>
            </select>
          </label>

          <label className="phone-row">
            <span>
              <strong>Port</strong>
              <small>Change it only if something else on this computer already uses it. The default is {DEFAULT_PHONE_PORT}, and it stays fixed so a phone&apos;s bookmark keeps working.</small>
            </span>
            <input type="text" inputMode="numeric" disabled={working} value={port ?? String(settings.port)}
              onChange={event => { setPort(event.target.value); setPortError('') }}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
              onBlur={event => commitPort(event.target.value)} />
          </label>
          {portError && <p className="phone-error"><ShieldAlert size={12} /> {portError}</p>}

          <label className="phone-row">
            <span>
              <strong>Send push notifications</strong>
              <small>Each phone still turns them on for itself, from the app on that phone. This switch stops all of them at once.</small>
            </span>
            <input type="checkbox" checked={settings.notifications} disabled={working}
              onChange={event => apply('notifications', () => window.conductor.phone.setSettings({ notifications: event.target.checked }))} />
          </label>
          {!state.pushConfigured && <p className="phone-hint">The push keys are created when the listener starts, so nothing can be delivered before that.</p>}
        </div>
      </details>
    </section>
  )
}
