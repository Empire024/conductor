import { useEffect, useState } from 'react'
import { BellRing, Check, Copy, Download, Pencil, QrCode, ShieldAlert, ShieldCheck, Smartphone, Wifi, X } from 'lucide-react'
import type { PhoneAccessState, PhoneDevice, PhoneExposure } from '../../../shared/phone-access'
import { DEFAULT_PHONE_PORT } from '../../../shared/phone-access'
import { qrSvg } from '../../../shared/qr-code'
import {
  accessStatus,
  certificateUrl,
  countdownText,
  exposureExplanation,
  fingerprintGroups,
  notificationLabel,
  otherEndpoints,
  portProblem,
  portToCommit,
  pushFailureWarning,
  relativeTime,
  renameToCommit,
  tailscaleCertificateWord,
  testResultText
} from './phone-access-view'
import './PhoneAccessSettings.css'

const fail = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/**
 * The pairing QR, drawn from our own encoder rather than fetched from anywhere.
 *
 * The markup goes in through dangerouslySetInnerHTML because it is a string we generated one line
 * above from a URL the main process minted - no user text reaches it. A throw is still caught: a
 * failed encode should cost the owner a QR code, not the whole settings panel.
 */
const qrMarkup = (text: string): string => {
  try { return qrSvg(text, { moduleSize: 4, margin: 2, dark: '#0b0e12', light: '#ffffff' }) } catch { return '' }
}

/**
 * Phone access, as the owner sets it up from the desktop.
 *
 * The panel never decides anything itself: every switch, the port and every pairing act goes to the
 * main process, which answers with the whole new state. That is why nothing here is optimistic -
 * a phone believing it is paired when the listener never started is exactly the confusion this
 * section exists to prevent.
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

  useEffect(() => {
    void window.conductor.phone.state().then(setState).catch(reason => setError(fail(reason)))
    // Anything else can change this: a phone pairing, a phone going quiet, the listener losing its
    // address. The subscription is the only way the panel hears about those, so it is also the only
    // thing that keeps it honest while it sits open.
    return window.conductor.phone.onChanged(setState)
  }, [])

  const counting = Boolean(state?.pairing)
  const phones = state?.devices.length ?? 0
  useEffect(() => {
    // A pairing code needs a second-by-second countdown; "last seen" ages in minutes and does not,
    // so the panel does not re-render every second for the rest of its open life.
    const period = counting ? 1000 : phones ? 30_000 : 0
    if (!period) return
    const timer = setInterval(() => setNow(Date.now()), period)
    return () => clearInterval(timer)
  }, [counting, phones])

  async function attempt<T>(label: string, action: () => Promise<T>, done: (value: T) => void): Promise<void> {
    setBusy(label)
    setError('')
    try { done(await action()) } catch (reason) { setError(fail(reason)) } finally { setBusy('') }
  }

  /** Every mutation answers with the whole new state, so there is never anything to re-fetch. */
  const apply = (label: string, action: () => Promise<PhoneAccessState>): void => { void attempt(label, action, setState) }

  const copy = (key: string, value: string): void => {
    void window.conductor.system.copyText(value).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(''), 1500)
    })
  }

  const working = busy !== ''
  const settings = state?.settings
  const pairing = state?.pairing ?? null
  const status = state ? accessStatus(state) : null
  const caUrl = certificateUrl(state?.primaryEndpoint ?? null)
  const countdown = pairing ? countdownText(pairing.expiresAt, now) : ''

  const commitPort = (value: string): void => {
    const problem = portProblem(value)
    setPortError(problem)
    if (problem || !settings) return
    const next = portToCommit(value, settings.port)
    // Unchanged is not worth a restart of the listener, and the box goes back to the saved value.
    if (next === null) { setPort(null); return }
    void attempt('port', () => window.conductor.phone.setSettings({ port: next }), fresh => { setState(fresh); setPort(null) })
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
      {!state && !error && <p className="phone-hint">Reading this computer&apos;s phone listener…</p>}

      {state && settings && (
        <>
          <div className="phone-card">
            <label className="phone-row">
              <span>
                <strong>Let my phones control this Conductor</strong>
                <small>Off unless you turn it on, here. A phone still has to be paired below before it sees anything.</small>
              </span>
              <input type="checkbox" checked={settings.enabled} disabled={working}
                onChange={event => apply('enabled', () => window.conductor.phone.setSettings({ enabled: event.target.checked }))} />
            </label>

            {settings.enabled && status?.kind === 'ok' && <p className="phone-status"><Wifi size={12} /> {status.text}</p>}
            {settings.enabled && status?.kind === 'warning' && <p className="phone-warning"><ShieldAlert size={12} /> {status.text}</p>}
            {status?.kind === 'error' && <p className="phone-error"><ShieldAlert size={12} /> {status.text}</p>}
            {settings.enabled && state.listening && otherEndpoints(state.endpoints, state.primaryEndpoint).length > 0 && (
              <div className="phone-endpoint">
                {otherEndpoints(state.endpoints, state.primaryEndpoint).map(endpoint => (
                  <div key={endpoint}><span>Also reachable at</span><code>{endpoint}</code></div>
                ))}
              </div>
            )}
          </div>

          <div className="phone-card">
            <label className="phone-row">
              <span>
                <strong>Phones may reach this computer</strong>
                <small>{exposureExplanation(settings.exposure, state.tailscale)}</small>
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

            {settings.exposure === 'tailscale' && (
              <div className="phone-tailscale">
                <div className="phone-endpoint">
                  <div><span>This machine</span><code>{state.tailscale.address ?? 'No tailnet address'}</code></div>
                  <div><span>Name on the tailnet</span><code>{state.tailscale.dnsName ?? 'None'}</code></div>
                  <div><span>Tailscale certificate</span><code>{tailscaleCertificateWord(state.tailscale.certificate)}</code></div>
                </div>
                <label className="phone-row">
                  <span>
                    <strong>Get a trusted certificate from Tailscale</strong>
                    <small>Needs HTTPS enabled for your tailnet. The machine name becomes public in certificate logs.</small>
                  </span>
                  <input type="checkbox" checked={settings.tailscaleCertificate} disabled={working}
                    onChange={event => apply('tailscale-certificate', () => window.conductor.phone.setSettings({ tailscaleCertificate: event.target.checked }))} />
                </label>
                {state.tailscale.message && (
                  <p className={state.tailscale.certificate === 'failed' ? 'phone-warning' : 'phone-hint'}>
                    {state.tailscale.certificate === 'failed' && <ShieldAlert size={12} />} {state.tailscale.message}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="phone-card phone-link">
            <strong className="phone-card-title"><QrCode size={13} /> Pair a phone</strong>
            <p className="phone-hint">
              The code is good for ten minutes and pairs one phone. Scanning it opens the address and fills the code in,
              so there is nothing to type over there.
            </p>
            {!state.listening && <p className="phone-warning"><ShieldAlert size={12} /> A pairing code can only be shown while this computer is listening.</p>}
            <div className="phone-actions">
              <button className="phone-primary" disabled={working || !state.listening}
                onClick={() => apply('pair', () => window.conductor.phone.pair())}>
                {pairing ? 'Show a new pairing code' : 'Show pairing code'}
              </button>
              {pairing && <button disabled={working} onClick={() => apply('cancel-pairing', () => window.conductor.phone.cancelPairing())}>Cancel</button>}
            </div>

            {pairing && (
              <div className="phone-pairing">
                <div className="phone-qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: qrMarkup(pairing.url) }} />
                <div className="phone-pairing-detail">
                  <div className="phone-code">
                    <code>{pairing.code}</code>
                    <button title="Copy the code" onClick={() => copy('code', pairing.code)}>{copied === 'code' ? <Check size={13} /> : <Copy size={13} />}</button>
                  </div>
                  <div className="phone-url">
                    <code>{pairing.url}</code>
                    <button title="Copy the address" onClick={() => copy('url', pairing.url)}>{copied === 'url' ? <Check size={13} /> : <Copy size={13} />}</button>
                  </div>
                  {countdown && <small className="phone-countdown">{countdown}</small>}
                </div>
              </div>
            )}

            <ol className="phone-steps">
              <li>Install the certificate once (below).</li>
              <li>Open the address on the phone or scan the code.</li>
              <li>Add it to the Home Screen for notifications.</li>
            </ol>
          </div>

          <div className="phone-card">
            <strong className="phone-card-title"><ShieldCheck size={13} /> Trust this computer on your phone</strong>
            <p className="phone-hint">
              This computer signs its own certificate, so a phone has to be told once that it is yours. Install it from
              the link below, then check the fingerprint matches what the phone shows.
            </p>
            <div className="phone-endpoint">
              <div>
                <span>Certificate authority</span>
                <code>{fingerprintGroups(state.caFingerprint) || 'Created when the listener first starts'}</code>
              </div>
            </div>
            <div className="phone-actions">
              <button disabled={working || !state.caFingerprint}
                onClick={() => void attempt('certificate', () => window.conductor.phone.saveCertificate(), path => setSavedTo(path ?? ''))}>
                <Download size={13} /> Save certificate…
              </button>
              <button disabled={!caUrl} onClick={() => copy('ca', caUrl)}>
                {copied === 'ca' ? <Check size={13} /> : <Copy size={13} />} Copy download link
              </button>
            </div>
            {savedTo && <small className="phone-saved">Saved to {savedTo}</small>}

            <details className="phone-advanced">
              <summary>Steps on the phone</summary>
              <div className="phone-platform">
                <strong>iPhone and iPad</strong>
                <ol>
                  <li>Open the download link in Safari — other browsers cannot install a profile.</li>
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
                    <button className="phone-icon" title="Rename this phone" onClick={() => { setRenaming(device.id); setDraftName(device.name) }}>
                      <Pencil size={12} />
                    </button>
                  )}
                </div>
                <small>{notificationLabel(device)} · last seen {relativeTime(device.lastSeenAt, now)}</small>
                {pushFailureWarning(device) && <small className="phone-problem">{pushFailureWarning(device)}</small>}
                <div className="phone-actions">
                  <button disabled={working}
                    onClick={() => void attempt(`test-${device.id}`, () => window.conductor.phone.testNotification(device.id),
                      result => setTested(current => ({ ...current, [device.id]: testResultText(result) })))}>
                    <BellRing size={12} /> Test notification
                  </button>
                  <button disabled={working} title="Revoke this phone's access" onClick={() => revoke(device)}><X size={12} /> Revoke</button>
                </div>
                {tested[device.id] && <small className="phone-hint">{tested[device.id]}</small>}
              </div>
            ))}
          </div>

          <div className="phone-card">
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
        </>
      )}
    </section>
  )
}
