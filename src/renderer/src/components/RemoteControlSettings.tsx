import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Github, Laptop, LogOut, MonitorSmartphone, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import type { GitHubAuthState, RemoteControlState, RemoteExposure } from '../../../shared/remote-control'
import './RemoteControlSettings.css'

const fail = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)
const shortFingerprint = (value: string | null): string => value ? value.replace(/:/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim() : ''

/**
 * Identity and remote control in one place. The pairing approval is part of the security
 * boundary, so it always names the machine, the account and the exact projects being granted
 * before the owner can say yes.
 */
export function RemoteControlSettings(): React.JSX.Element {
  const [github, setGithub] = useState<GitHubAuthState | null>(null)
  const [state, setState] = useState<RemoteControlState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [ticket, setTicket] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [grants, setGrants] = useState<Record<string, string[]>>({})

  const refresh = useCallback(() => {
    void window.conductor.remote.githubState().then(setGithub).catch(reason => setError(fail(reason)))
    void window.conductor.remote.state().then(setState).catch(reason => setError(fail(reason)))
  }, [])

  useEffect(() => {
    refresh()
    const stopGithub = window.conductor.remote.onGitHubState(setGithub)
    const stopState = window.conductor.remote.onState(setState)
    return () => { stopGithub(); stopState() }
  }, [refresh])

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(label); setError('')
    try { await action() } catch (reason) { setError(fail(reason)) } finally { setBusy(''); refresh() }
  }

  const copy = (value: string): void => {
    void window.conductor.system.copyText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }

  const signedIn = github?.phase === 'signed-in'
  const settings = state?.settings
  const pendingGrants = (pendingId: string): string[] => grants[pendingId] ?? state?.projects.map(project => project.id) ?? []

  return (
    <section className="remote-control-settings">
      <div className="settings-section-title">
        <MonitorSmartphone size={14} />
        <div>
          <strong>Account &amp; machines</strong>
          <span>Sign in with GitHub, then let your own machines run Conductor tabs for each other.</span>
        </div>
      </div>

      {error && <p className="remote-error"><ShieldAlert size={12} /> {error}</p>}

      <div className="remote-card">
        {!signedIn && github?.phase !== 'awaiting-authorization' && (
          <>
            <p className="remote-hint">Conductor uses GitHub&apos;s device flow: you approve in your own browser and Conductor never sees your password. The token is kept in this computer&apos;s credential store.</p>
            {github && !github.secureStorageAvailable && <p className="remote-error"><ShieldAlert size={12} /> This computer has no available credential store, so the token cannot be saved. Unlock the OS keychain and try again.</p>}
            {github && !github.clientIdConfigured && <p className="remote-error"><ShieldAlert size={12} /> No GitHub OAuth client ID is configured (CONDUCTOR_GITHUB_CLIENT_ID).</p>}
            <button className="remote-primary" disabled={busy === 'sign-in'} onClick={() => void run('sign-in', () => window.conductor.remote.signIn())}>
              <Github size={13} /> Sign in with GitHub
            </button>
          </>
        )}

        {github?.phase === 'awaiting-authorization' && github.prompt && (
          <div className="remote-device-flow">
            <p className="remote-hint">Open GitHub and enter this code. It expires shortly.</p>
            <div className="remote-code">
              <code>{github.prompt.userCode}</code>
              <button title="Copy the code" onClick={() => copy(github.prompt!.userCode)}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
            </div>
            <div className="remote-actions">
              <button className="remote-primary" onClick={() => void window.conductor.system.openExternal(github.prompt!.verificationUri)}>Open {github.prompt.verificationUri}</button>
              <button onClick={() => void run('cancel', () => window.conductor.remote.cancelSignIn())}>Cancel</button>
            </div>
          </div>
        )}

        {signedIn && github?.identity && (
          <div className="remote-identity">
            {github.identity.avatarUrl && <img src={github.identity.avatarUrl} alt="" width={30} height={30} />}
            <div>
              <strong>{github.identity.name || github.identity.login}</strong>
              <span>Signed in as {github.identity.login}</span>
              {github.deviceKeyFingerprint && <small>Device key {shortFingerprint(github.deviceKeyFingerprint)}</small>}
            </div>
            <button title="Sign out and revoke every paired machine" disabled={busy === 'sign-out'} onClick={() => void run('sign-out', () => window.conductor.remote.signOut())}>
              <LogOut size={13} /> Sign out
            </button>
          </div>
        )}
        {github?.message && <p className="remote-hint">{github.message}</p>}
      </div>

      {signedIn && settings && state && (
        <>
          <div className="remote-card">
            <label className="remote-row">
              <span><strong>Let my other machines control this one</strong><small>Off unless you turn it on, on this machine.</small></span>
              <input type="checkbox" checked={settings.enabled} onChange={event => void run('enabled', () => window.conductor.remote.setSettings({ enabled: event.target.checked }))} />
            </label>
            <label className="remote-row">
              <span><strong>This machine is called</strong><small>Shown on tabs that run here.</small></span>
              <input type="text" value={settings.machineName} maxLength={60}
                onChange={event => setState({ ...state, settings: { ...settings, machineName: event.target.value } })}
                onBlur={event => void run('name', () => window.conductor.remote.setSettings({ machineName: event.target.value }))} />
            </label>
            <label className="remote-row">
              <span><strong>Reachable from</strong><small>{settings.exposure === 'network' ? 'Your local network can reach this machine. Only a machine paired to your GitHub account can connect, over TLS.' : 'This computer only. Nothing leaves the machine.'}</small></span>
              <select value={settings.exposure} onChange={event => void run('exposure', () => window.conductor.remote.setSettings({ exposure: event.target.value as RemoteExposure }))}>
                <option value="loopback">This computer only (recommended)</option>
                <option value="network">My local network — deliberate exposure</option>
              </select>
            </label>
            {settings.exposure === 'network' && (
              <p className="remote-warning"><ShieldAlert size={12} /> This machine now accepts connections from your network. Traffic is encrypted and every request must be signed by a device key registered on your GitHub account.</p>
            )}
            {state.message && <p className="remote-hint">{state.message}</p>}
            {state.listening && (
              <div className="remote-endpoint">
                <div><span>Listening on</span><code>{state.endpoint}</code></div>
                <div><span>Certificate</span><code>{shortFingerprint(state.fingerprint)}</code></div>
              </div>
            )}
            {state.listening && (
              <div className="remote-actions">
                <button className="remote-primary" disabled={busy === 'ticket'} onClick={() => void run('ticket', async () => {
                  const created = await window.conductor.remote.createTicket()
                  setTicket(created.encoded)
                })}>Create a pairing code</button>
                {ticket && <button onClick={() => copy(ticket)}>{copied ? <Check size={13} /> : <Copy size={13} />} Copy code</button>}
              </div>
            )}
            {ticket && <textarea className="remote-ticket" readOnly value={ticket} rows={3} onFocus={event => event.currentTarget.select()} />}
          </div>

          {state.pending.map(request => (
            <div className="remote-card remote-approval" key={request.id}>
              <strong><ShieldCheck size={13} /> {request.machineName} wants to control this machine</strong>
              <p className="remote-hint">Signed in as {request.accountLogin} · device key {shortFingerprint(request.keyFingerprint)}</p>
              <ul className="remote-grants">
                {request.grants.map(grant => <li key={grant.label}><span>{grant.label}</span><small>{grant.detail}</small></li>)}
              </ul>
              <fieldset className="remote-projects">
                <legend>Share these projects</legend>
                {state.projects.map(project => (
                  <label key={project.id}>
                    <input type="checkbox" checked={pendingGrants(request.id).includes(project.id)}
                      onChange={event => setGrants({
                        ...grants,
                        [request.id]: event.target.checked
                          ? [...pendingGrants(request.id), project.id]
                          : pendingGrants(request.id).filter(id => id !== project.id)
                      })} />
                    {project.name}
                  </label>
                ))}
              </fieldset>
              <div className="remote-actions">
                <button className="remote-primary" onClick={() => void run('approve', () => window.conductor.remote.approve(request.id, pendingGrants(request.id)))}>Approve</button>
                <button onClick={() => void run('deny', () => window.conductor.remote.deny(request.id))}>Deny</button>
              </div>
            </div>
          ))}

          <div className="remote-card">
            <strong className="remote-card-title"><Laptop size={13} /> Machines allowed to control this one</strong>
            {!state.peers.length && <p className="remote-hint">None yet. Create a pairing code and enter it on your other machine.</p>}
            {state.peers.map(peer => (
              <div className="remote-peer" key={peer.id}>
                <div>
                  <strong>{peer.machineName}</strong>
                  <small>{peer.accountLogin} · {peer.grantedProjectIds.length} project{peer.grantedProjectIds.length === 1 ? '' : 's'} · {peer.revokedAt ? 'revoked' : peer.lastSeenAt ? `last seen ${new Date(peer.lastSeenAt).toLocaleString()}` : 'not used yet'}</small>
                </div>
                {!peer.revokedAt && <button title="Revoke access immediately" onClick={() => void run('revoke', () => window.conductor.remote.revoke(peer.id))}><X size={13} /> Revoke</button>}
              </div>
            ))}
          </div>

          <div className="remote-card">
            <strong className="remote-card-title"><MonitorSmartphone size={13} /> Machines this one can use</strong>
            <p className="remote-hint">Paste a pairing code created on the other machine. A tab can then be told to run there.</p>
            <textarea className="remote-ticket" rows={3} value={joinCode} placeholder="Paste pairing code" onChange={event => setJoinCode(event.target.value)} />
            <div className="remote-actions">
              <button className="remote-primary" disabled={!joinCode.trim() || busy === 'connect'}
                onClick={() => void run('connect', async () => { await window.conductor.remote.connect(joinCode.trim()); setJoinCode('') })}>
                {busy === 'connect' ? 'Waiting for approval…' : 'Connect'}
              </button>
            </div>
            {state.connections.map(connection => (
              <div className="remote-peer" key={connection.machineId}>
                <div>
                  <strong>{connection.machineName}</strong>
                  <small>{connection.host}:{connection.port} · {connection.status}{connection.message ? ` · ${connection.message}` : ''}</small>
                </div>
                <button title="Forget this machine" onClick={() => void run('forget', () => window.conductor.remote.forget(connection.machineId))}><X size={13} /> Forget</button>
              </div>
            ))}
          </div>

          {state.activity.length > 0 && (
            <div className="remote-card">
              <strong className="remote-card-title">Recent remote activity</strong>
              <ul className="remote-activity">
                {state.activity.slice(0, 12).map(entry => (
                  <li key={entry.id} data-outcome={entry.outcome}>
                    <span>{entry.machineName}</span>
                    <code>{entry.detail}</code>
                    <small>{new Date(entry.at).toLocaleTimeString()}{entry.message ? ` · ${entry.message}` : ''}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
