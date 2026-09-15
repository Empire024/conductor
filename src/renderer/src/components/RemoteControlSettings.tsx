import { useCallback, useEffect, useState } from 'react'
import { Activity, Check, Copy, Github, Laptop, LogOut, MonitorSmartphone, Network, Plug, ShieldAlert, ShieldCheck, Unplug, X } from 'lucide-react'
import type { GitHubAuthState, MachineDiagnostics, RemoteControlState, RemoteExposure, RemotePeerRecord } from '../../../shared/remote-control'
import type { RelayStatus } from '../../../shared/remote-relay'
import { checkRemoteProjectPlacement, samePath, sameWorkingCopy } from '../../../shared/project-identity'
import { describeConnectionRecord, detachExplanationLines } from './remote-attachment-view'
import { PEER_PAIRING_NOTE, matchTailnetPeer, peerSummary, tailnetSummary } from './tailnet-state'
import { executionTargetSummary, failureExplanation, failureWords } from './execution-target'
import './RemoteControlSettings.css'

const fail = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)
const shortFingerprint = (value: string | null): string => value ? value.replace(/:/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim() : ''

/** Which relay is carrying this machine, in the owner's terms rather than the protocol's. */
const relayRouteLabel = (relay: RelayStatus, hosting: boolean): string =>
  relay.route !== 'server' ? 'Private gist on your GitHub account'
    : hosting ? 'The relay on this machine'
    : `Your own relay${relay.endpoint ? ` · ${relay.endpoint}` : ''}`

/** What the relay running here is doing, said the way the owner would ask about it. */
const hostLabel = (host: RemoteControlState['relayHost']): string =>
  host.running ? (host.port ? `Running on port ${host.port}` : 'Running') : host.message ? 'Not running' : 'Off'

/**
 * Whether machines off this network can reach it, and - when they cannot - that it is so.
 *
 * A public IPv6 address counts, and counts without anything being forwarded: the machine already
 * holds it, and the router only has to allow traffic to it. Saying "this network only" while such an
 * address is listed would be false about the one thing an owner just configured.
 */
const internetLabel = (host: RemoteControlState['relayHost']): string => {
  if (host.internet.state === 'open') return host.internet.address ?? 'Open'
  if (host.internet.state === 'opening') return 'Asking your router…'
  const ipv6 = host.addresses.some(address => address.includes('['))
  if (host.internet.state === 'failed') return ipv6 ? 'Over IPv6, if your router allows this port' : 'Not reachable from outside'
  return ipv6 ? 'Over IPv6, if your router allows this port' : 'This network only'
}

/**
 * Where the owner stands, in one sentence: whether another computer is linked, and if one is not
 * reaching this machine, the single reason that matters rather than five statuses to read across.
 */
function linkSummary(state: RemoteControlState): string {
  const others = state.connections.filter(connection => connection.status !== 'revoked')
  const allowed = state.peers.filter(peer => !peer.revokedAt)
  if (!others.length && !allowed.length) {
    return 'No other computer yet. Invite one from here, or paste an invite made on the computer you want to reach.'
  }
  const connected = others.filter(connection => connection.status === 'connected')
  const waiting = others.filter(connection => connection.status === 'pending')
  const lost = others.filter(connection => connection.status === 'unreachable')
  const parts: string[] = []
  if (connected.length) parts.push(`${connected.map(entry => entry.machineName).join(', ')} ${connected.length === 1 ? 'is' : 'are'} linked and reachable.`)
  if (waiting.length) parts.push(`${waiting.map(entry => entry.machineName).join(', ')} is waiting to be allowed on that computer.`)
  if (lost.length) {
    const why = lost.find(entry => entry.message)?.message ?? state.relay.message
    parts.push(`${lost.map(entry => entry.machineName).join(', ')} cannot be reached right now.${why ? ` ${why}` : ''}`)
  }
  if (!others.length && allowed.length) {
    parts.push(`${allowed.map(peer => peer.machineName).join(', ')} may control this computer. Nothing here controls it back until you paste an invite from it.`)
  }
  return parts.join(' ')
}

/** The relay's own words for what it is doing, so "why can't I reach my laptop" has an answer here. */
const relayLabel = (relay: RelayStatus): string => {
  if (relay.phase === 'ready') return relay.reachable.length ? 'Connected' : 'Waiting for another machine'
  if (relay.phase === 'connecting') return 'Checking in'
  if (relay.phase === 'unavailable') return 'Paused'
  if (relay.phase === 'error') return 'Not working'
  return 'Off'
}

/**
 * What has become of a project this machine shares, seen from here. A folder that moved is
 * something the owner can confirm; a folder that now holds a different working copy is not,
 * because the approval was given to the copy that used to be there.
 */
function sharedProjectState(peer: RemotePeerRecord, state: RemoteControlState, projectId: string): { detail: string; moved: boolean; warning: string } {
  const granted = peer.grantedProjects.find(entry => entry.projectId === projectId)
  const project = state.projects.find(entry => entry.id === projectId)
  if (!project) return { detail: projectId, moved: false, warning: 'No longer registered on this machine.' }
  if (!granted?.identity) return { detail: project.path, moved: false, warning: 'Shared before projects carried an identity, so there is nothing recorded to compare against.' }
  if (!project.identity) return { detail: project.path, moved: false, warning: project.identityError ?? 'This project identity cannot be read.' }
  if (!sameWorkingCopy(project.identity, granted.identity)) {
    return { detail: project.path, moved: false, warning: 'This folder now holds a different working copy than the one shared. Revoke and pair again rather than confirming it.' }
  }
  if (!samePath(project.identity.path, granted.identity.path)) {
    return { detail: project.path, moved: true, warning: `Shared as ${granted.identity.path}, now at ${project.identity.path}.` }
  }
  return { detail: project.path, moved: false, warning: '' }
}

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
  const [pairs, setPairs] = useState<Record<string, string>>({})
  const [relayAddress, setRelayAddress] = useState<string | null>(null)
  const [relaySecret, setRelaySecret] = useState('')
  const [hostPort, setHostPort] = useState<string | null>(null)
  const [linkMode, setLinkMode] = useState<'idle' | 'invited' | 'joining'>('idle')
  const [diagnostics, setDiagnostics] = useState<Record<string, MachineDiagnostics>>({})
  /** The machine whose "use this computer independently" explanation is open, before confirming. */
  const [confirmDetach, setConfirmDetach] = useState<string | null>(null)
  const [detachOutcome, setDetachOutcome] = useState('')

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
  const tailnet = tailnetSummary(state?.tailscale ?? { installed: false, backendState: null, self: null, peers: [], message: null, checkedAt: null })

  const showDiagnostics = (machineId: string): void => {
    void run('diagnostics', async () => {
      const result = await window.conductor.remote.diagnostics(machineId)
      setDiagnostics(current => ({ ...current, [machineId]: result }))
    })
  }
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
            <p className="remote-hint">Conductor uses GitHub&apos;s device flow: you approve in your own browser and Conductor never sees your password. Expiring access and refresh credentials are rotated automatically in this computer&apos;s credential store.</p>
            {github && !github.secureStorageAvailable && <p className="remote-error"><ShieldAlert size={12} /> This computer has no available credential store, so GitHub credentials cannot be saved. Unlock the OS keychain and try again.</p>}
            {github && !github.clientIdConfigured && <p className="remote-error"><ShieldAlert size={12} /> GitHub sign-in is unavailable because the public OAuth client ID was explicitly disabled.</p>}
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
              <small>GitHub credentials refresh automatically in the OS credential store.</small>
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
          {/*
            Linking two computers is one thing an owner wants, and it used to be ten settings. The
            two buttons below are the whole flow: one machine makes an invite - which switches on
            everything the link needs and starts a relay here if none is configured - and the other
            pastes it. Everything those steps used to expose is still here, under Advanced, for the
            cases that need it.
          */}
          <div className="remote-card remote-link">
            <strong className="remote-card-title"><Laptop size={13} /> Link a device</strong>
            <p className="remote-hint">{linkSummary(state)}</p>
            <div className="remote-actions">
              <button className="remote-primary" disabled={busy === 'invite'} onClick={() => void run('invite', async () => {
                const created = await window.conductor.remote.invite()
                setTicket(created.encoded)
                setLinkMode('invited')
              })}>Invite a device</button>
              <button disabled={busy === 'invite'} onClick={() => { setLinkMode(linkMode === 'joining' ? 'idle' : 'joining'); setTicket('') }}>
                I have an invite
              </button>
            </div>

            {/*
              The tailnet, beside the two link buttons, because "which of my computers can I even
              see from here" is the question an owner asks immediately before pairing one. It is
              shown next to the invite flow and not instead of it: a computer being visible here is
              not permission to use it, and PEER_PAIRING_NOTE says so in as many words.
            */}
            {state.tailscale.peers.length > 0 && (
              <div className="remote-tailnet">
                <strong className="remote-card-title"><Network size={13} /> Hosts on your tailnet</strong>
                <ul className="remote-tailnet-list">
                  {state.tailscale.peers.map(peer => {
                    const paired = state.connections.find(connection => matchTailnetPeer([peer], connection.host)?.id === peer.id)
                    return (
                      <li key={peer.id} data-online={peer.online}>
                        <span>
                          <strong>{peer.hostName}</strong>
                          <small>{peer.addresses[0] ?? peer.dnsName}</small>
                        </span>
                        <code>{peerSummary(peer)}</code>
                        <small>{paired ? `Paired as ${paired.machineName}` : 'Not paired'}</small>
                      </li>
                    )
                  })}
                </ul>
                <p className="remote-hint">{PEER_PAIRING_NOTE}</p>
              </div>
            )}
            {settings.exposure === 'tailscale' && !state.tailscale.peers.length && tailnet.usable && (
              <p className="remote-hint">No other computers on your tailnet yet. Sign the other one into the same Tailscale account, then check again.</p>
            )}

            {linkMode === 'invited' && ticket && (
              <>
                <p className="remote-hint">
                  Paste this into <strong>Link a device → I have an invite</strong> on your other computer, within ten minutes.
                  It carries the address to reach this machine, the certificate to check it against and the secret they share.
                </p>
                <textarea className="remote-ticket" readOnly value={ticket} rows={3} onFocus={event => event.currentTarget.select()} />
                <div className="remote-actions">
                  <button onClick={() => copy(ticket)}>{copied ? <Check size={13} /> : <Copy size={13} />} Copy invite</button>
                </div>
              </>
            )}

            {linkMode === 'joining' && (
              <>
                <textarea className="remote-ticket" rows={3} value={joinCode} placeholder="Paste the invite from your other computer"
                  onChange={event => setJoinCode(event.target.value)} />
                <div className="remote-actions">
                  <button className="remote-primary" disabled={!joinCode.trim() || busy === 'connect'}
                    onClick={() => void run('connect', async () => {
                      await window.conductor.remote.connect(joinCode.trim())
                      setJoinCode('')
                      setLinkMode('idle')
                    })}>Link this computer</button>
                </div>
                <p className="remote-hint">The other computer will ask, there, whether to allow this one and which projects it may open.</p>
              </>
            )}
          </div>

          <details className="remote-advanced">
            <summary>Advanced — machine name, relay and network</summary>
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
              <span>
                <strong>Direct connections</strong>
                <small>
                  {settings.exposure === 'tailscale'
                    ? 'This machine is reachable only at its own Tailscale address, so the only way in is through the tailnet you signed both computers into.'
                    : settings.exposure === 'network'
                      ? 'Your local network can reach this machine directly. Only a machine paired to your GitHub account can connect, over TLS.'
                      : settings.relay
                        ? 'No direct connection from your network. Your other machines still reach this one through the encrypted relay below, wherever they are.'
                        : 'This computer only. With the relay off too, nothing reaches this machine from anywhere.'}
                </small>
              </span>
              <select value={settings.exposure} onChange={event => void run('exposure', () => window.conductor.remote.setSettings({ exposure: event.target.value as RemoteExposure }))}>
                <option value="tailscale">Only through Tailscale — recommended</option>
                <option value="loopback">This computer only</option>
                <option value="network">My local network — faster on the same network</option>
              </select>
            </label>
            {settings.exposure === 'tailscale' && (
              <div className="remote-tailscale">
                <div className="remote-endpoint">
                  <div><span>Tailscale</span><code>{tailnet.status}</code></div>
                  {tailnet.address && <div><span>This machine</span><code>{tailnet.address}</code></div>}
                  {state.tailscale.self && <div><span>Name on the tailnet</span><code>{state.tailscale.self.dnsName || state.tailscale.self.hostName}</code></div>}
                  {state.tailscale.self?.loginName && <div><span>Signed in as</span><code>{state.tailscale.self.loginName}</code></div>}
                  <div><span>Checked</span><code>{tailnet.checkedAt}</code></div>
                </div>
                {/*
                  In this mode the listener binds that address and nothing else. When the tailnet is
                  not usable it does not start at all rather than widening to 0.0.0.0, a public IPv6
                  address, the LAN or the relay - so the panel owes the owner the reason, not a
                  vaguer version of "it works anyway".
                */}
                {!tailnet.usable && <p className="remote-warning"><ShieldAlert size={12} /> {tailnet.message} Until then this machine accepts no connections at all; nothing falls back to your network or the relay.</p>}
                <div className="remote-actions">
                  <button disabled={busy === 'tailscale'} onClick={() => void run('tailscale', () => window.conductor.remote.tailscale())}>Check the tailnet again</button>
                </div>
              </div>
            )}
            {settings.exposure === 'network' && (
              <p className="remote-warning"><ShieldAlert size={12} /> This machine now accepts connections from your network. Traffic is encrypted and every request must be signed by a device key registered on your GitHub account.</p>
            )}
            <label className="remote-row">
              <span>
                <strong>Reach my machines anywhere</strong>
                <small>
                  Off your network, messages travel as ciphertext through a private gist on your own GitHub account.
                  GitHub never holds a key that opens one, and no port is opened here.
                </small>
              </span>
              <input type="checkbox" checked={settings.relay}
                onChange={event => void run('relay', () => window.conductor.remote.setSettings({ relay: event.target.checked }))} />
            </label>
            {settings.relay && (
              <div className="remote-endpoint">
                <div><span>Encrypted relay</span><code>{relayLabel(state.relay)}</code></div>
                <div><span>Route</span><code>{relayRouteLabel(state.relay, settings.relayHosting)}</code></div>
                {state.relay.reachable.length > 0 && <div><span>Machines checked in</span><code>{state.relay.reachable.length}</code></div>}
              </div>
            )}
            {settings.relay && (
              <div className="remote-relay-server">
                <label className="remote-row">
                  <span>
                    <strong>Run the relay on this machine</strong>
                    <small>
                      Your machines meet on a relay instead of through GitHub, so nothing is charged against an API budget
                      and a message arrives the moment it is sent. Conductor runs it here, with a certificate and a room
                      secret it makes for you. This machine has to be awake for the others to meet on it.
                    </small>
                  </span>
                  <input type="checkbox" checked={settings.relayHosting} disabled={busy === 'relay-host'}
                    onChange={event => void run('relay-host', () => window.conductor.remote.setRelayHosting({ enabled: event.target.checked }))} />
                </label>

                {settings.relayHosting && (
                  <>
                    <div className="remote-endpoint">
                      <div><span>Relay here</span><code>{hostLabel(state.relayHost)}</code></div>
                      <div><span>Reachable</span><code>{internetLabel(state.relayHost)}</code></div>
                      {state.relayHost.addresses.map(address => (
                        <div key={address}>
                          {/* A bracketed address is a public IPv6 one: reachable from anywhere that
                              has IPv6, once the router is told to allow it. */}
                          <span>{address.includes('[') ? 'Public IPv6' : 'On this network'}</span>
                          <code>{address}</code>
                        </div>
                      ))}
                    </div>
                    <label className="remote-row">
                      <span>
                        <strong>Let my machines reach it from anywhere</strong>
                        <small>
                          Asks your router to forward this port to this machine, which is what lets a laptop on another
                          network arrive at all. Nothing is published: whoever connects still has to hold the room secret,
                          and you still confirm every pairing here by hand.
                        </small>
                      </span>
                      <input type="checkbox" checked={settings.relayHostInternet} disabled={busy === 'relay-host'}
                        onChange={event => void run('relay-host', () => window.conductor.remote.setRelayHosting({ internet: event.target.checked }))} />
                    </label>
                    {state.relayHost.internet.message && <p className="remote-hint">{state.relayHost.internet.message}</p>}
                    {state.relayHost.message && <p className="remote-error"><ShieldAlert size={12} /> {state.relayHost.message}</p>}
                    <label className="remote-row">
                      <span><strong>Port</strong><small>Change it only if something else on this machine already uses it.</small></span>
                      <input type="text" inputMode="numeric" value={hostPort ?? String(settings.relayHostPort)}
                        onChange={event => setHostPort(event.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
                        onBlur={event => {
                          const port = Number(event.target.value)
                          setHostPort(null)
                          if (Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== settings.relayHostPort) {
                            void run('relay-host', () => window.conductor.remote.setRelayHosting({ port }))
                          }
                        }} />
                    </label>
                    <p className="remote-hint">
                      Create a pairing code below and give it to your other machine. The code carries this relay&apos;s address,
                      its certificate and the room secret, so there is nothing to type over there.
                    </p>
                  </>
                )}

                {!settings.relayHosting && (
                  <>
                    <label className="remote-row">
                      <span>
                        <strong>Or use a relay somewhere else</strong>
                        <small>
                          One you already run — on a server, from the container image, or on another of your machines.
                          Leave both empty to fall back to the private gist.
                        </small>
                      </span>
                    </label>
                    <input type="text" placeholder="wss://relay.example.com" spellCheck={false}
                      value={relayAddress ?? settings.relayEndpoint}
                      onChange={event => setRelayAddress(event.target.value)} />
                    <input type="password" autoComplete="off" spellCheck={false}
                      placeholder={state.relaySecretSet ? 'Room secret — saved on this machine' : 'Room secret'}
                      value={relaySecret} onChange={event => setRelaySecret(event.target.value)} />
                    <div className="remote-actions">
                      <button className="remote-primary" disabled={busy === 'relay-server'} onClick={() => void run('relay-server', async () => {
                        // An empty box means "leave the stored secret alone", so re-saving an address
                        // never silently wipes the secret that makes it usable.
                        await window.conductor.remote.setRelayServer(relayAddress ?? settings.relayEndpoint, relaySecret.trim() ? relaySecret.trim() : null)
                        setRelaySecret('')
                        setRelayAddress(null)
                      })}>Use this relay</button>
                      {(settings.relayEndpoint || state.relaySecretSet) && (
                        <button disabled={busy === 'relay-server'} onClick={() => void run('relay-server', async () => {
                          await window.conductor.remote.setRelayServer('', '')
                          setRelaySecret('')
                          setRelayAddress(null)
                        })}>Back to the gist</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            {settings.relay && state.relay.message && <p className="remote-hint">{state.relay.message}</p>}
            {state.message && <p className="remote-hint">{state.message}</p>}
            {state.listening && (
              <div className="remote-endpoint">
                <div><span>Listening on</span><code>{state.endpoint}</code></div>
                <div><span>Certificate</span><code>{shortFingerprint(state.fingerprint)}</code></div>
              </div>
            )}
            {(state.listening || state.relay.phase === 'ready') && (
              <div className="remote-actions">
                {/* The plain code, for a machine already set up the way its owner wants it. */}
                <button disabled={busy === 'ticket'} onClick={() => void run('ticket', async () => {
                  const created = await window.conductor.remote.createTicket()
                  setTicket(created.encoded)
                  setLinkMode('invited')
                })}>Create a pairing code without changing anything</button>
              </div>
            )}
          </div>
          </details>

          {state.pending.map(request => (
            <div className="remote-card remote-approval" key={request.id}>
              <strong><ShieldCheck size={13} /> {request.machineName} wants to control this machine</strong>
              <p className="remote-hint">Signed in as {request.accountLogin} · device key {shortFingerprint(request.keyFingerprint)}</p>
              <ul className="remote-grants">
                {request.grants.map(grant => <li key={grant.label}><span>{grant.label}</span><small>{grant.detail}</small></li>)}
              </ul>
              <fieldset className="remote-projects">
                <legend>Share these projects — check the folder, not just the name</legend>
                {state.projects.map(project => (
                  <label key={project.id}>
                    <input type="checkbox" checked={pendingGrants(request.id).includes(project.id)} disabled={!project.identity}
                      onChange={event => setGrants({
                        ...grants,
                        [request.id]: event.target.checked
                          ? [...pendingGrants(request.id), project.id]
                          : pendingGrants(request.id).filter(id => id !== project.id)
                      })} />
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.path}</small>
                      {project.identityError && <small className="remote-project-problem">{project.identityError}</small>}
                    </span>
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
              <div className="remote-peer-block" key={peer.id}>
                <div className="remote-peer">
                  <div>
                    <strong>{peer.machineName}</strong>
                    <small>{peer.accountLogin} · {peer.grantedProjects.length} project{peer.grantedProjects.length === 1 ? '' : 's'} · {peer.revokedAt ? 'revoked' : peer.lastSeenAt ? `last seen ${new Date(peer.lastSeenAt).toLocaleString()}` : 'not used yet'}</small>
                  </div>
                  {!peer.revokedAt && <button title="Revoke access immediately" onClick={() => void run('revoke', () => window.conductor.remote.revoke(peer.id))}><X size={13} /> Revoke</button>}
                </div>
                {!peer.revokedAt && peer.grantedProjects.map(granted => {
                  const shared = sharedProjectState(peer, state, granted.projectId)
                  const project = state.projects.find(entry => entry.id === granted.projectId)
                  return (
                    <div className="remote-mapping" key={granted.projectId}>
                      <strong>{project?.name ?? granted.projectId}</strong>
                      <small>{shared.detail}</small>
                      {shared.warning && <small className="remote-project-problem">{shared.warning}</small>}
                      {shared.moved && (
                        <div className="remote-actions">
                          <button className="remote-primary" onClick={() => void run('reshare', () => window.conductor.remote.reshareProject(peer.id, granted.projectId))}>
                            Confirm the new location
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          <div className="remote-card">
            <strong className="remote-card-title"><MonitorSmartphone size={13} /> Machines this one can use</strong>
            <p className="remote-hint">Paste a pairing code created on the other machine. A tab can then be told to run there.</p>
            <div className="remote-actions">
              <button className="remote-primary" disabled={busy === 'connect'}
                onClick={() => { setLinkMode('joining'); setTicket('') }}>
                {busy === 'connect' ? 'Waiting for approval…' : 'Connect'}
              </button>
            </div>
            {state.connections.map(connection => {
              const machine = describeConnectionRecord(connection)
              const detached = machine.state === 'detached'
              const summary = executionTargetSummary({
                label: '', machineId: connection.machineId, machineName: connection.machineName, local: false,
                state: { detached: 'Detached', offline: 'Offline', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting' }[machine.state],
                path: detached || machine.state === 'offline' ? '' : machine.path === 'direct' ? 'Direct' : machine.path === 'relayed' ? 'Relayed' : 'Unknown',
                transport: machine.transport === 'tailscale' ? 'over Tailscale' : '',
                failure: failureWords(machine.failure), detail: '', detached
              })
              const report = diagnostics[connection.machineId]
              return (
              <div className="remote-peer-block" key={connection.machineId}>
                <div className="remote-peer">
                  <div>
                    <strong>{connection.machineName}</strong>
                    <small>{connection.host}:{connection.port} · {summary}{connection.message ? ` · ${connection.message}` : ''}</small>
                    {machine.failure && <small className="remote-project-problem">{failureExplanation(machine.failure, connection.machineName)}</small>}
                  </div>
                  <div className="remote-actions">
                    <button title="Ask that machine which projects it shares now" disabled={busy === 'refresh-projects' || detached}
                      onClick={() => void run('refresh-projects', () => window.conductor.remote.remoteProjects(connection.machineId))}>Refresh projects</button>
                    <button title="What this computer knows about that connection right now" disabled={busy === 'diagnostics'}
                      onClick={() => showDiagnostics(connection.machineId)}><Activity size={13} /> Diagnostics</button>
                    {/* Forgetting is a different act from detaching and from revoking, so it stays
                        exactly where it was and keeps its own word. */}
                    <button title="Forget this machine" onClick={() => void run('forget', () => window.conductor.remote.forget(connection.machineId))}><X size={13} /> Forget</button>
                  </div>
                </div>

                {report && (
                  <div className="remote-diagnostics">
                    <div className="remote-endpoint">
                      <div><span>State</span><code>{report.connection.state}</code></div>
                      <div><span>Route</span><code>{report.connection.path}</code></div>
                      <div><span>Transport</span><code>{report.connection.transport ?? 'none'}</code></div>
                      <div><span>Generation</span><code>{report.connection.generation}</code></div>
                      {report.endpoint && <div><span>Dials</span><code>{report.endpoint.host}:{report.endpoint.port}</code></div>}
                      {report.endpoint && <div><span>Pinned certificate</span><code>{shortFingerprint(report.endpoint.fingerprint)}</code></div>}
                      {report.tailscalePeer && <div><span>Tailnet node</span><code>{peerSummary(report.tailscalePeer)}</code></div>}
                      <div><span>Last contact</span><code>{report.lastContactAt ? new Date(report.lastContactAt).toLocaleString() : 'never'}</code></div>
                      <div><span>Push channel</span><code>{report.stream.open ? 'open' : 'closed'} · {report.stream.reconnects} reconnect{report.stream.reconnects === 1 ? '' : 's'}</code></div>
                      {report.stream.lastHeardAt && <div><span>Last heard</span><code>{new Date(report.stream.lastHeardAt).toLocaleTimeString()}</code></div>}
                      <div><span>Mirrored sessions</span><code>{report.cursors.length}</code></div>
                    </div>
                  </div>
                )}

                {/*
                  The standalone action. It is prominent because it is the one thing an owner needs
                  when MAIN is off, lost or gone - the moment they are least able to go looking for
                  it - and it needs nothing from MAIN to work.
                */}
                <div className="remote-standalone" data-detached={detached}>
                  {detached ? (
                    <>
                      <strong><Unplug size={13} /> Using this computer independently of {connection.machineName}</strong>
                      <p className="remote-hint">
                        Nothing is being sent to {connection.machineName}, nothing is being retried, and this is remembered
                        across restarts. The pairing is still here; only you decide when to attach again.
                      </p>
                      <div className="remote-actions">
                        <button className="remote-primary" disabled={busy === 'attach'}
                          onClick={() => void run('attach', async () => {
                            await window.conductor.remote.attach(connection.machineId)
                            setDetachOutcome(`Attached to ${connection.machineName} again. Retained edits stay as recovery drafts; nothing was replayed.`)
                          })}><Plug size={13} /> Attach to {connection.machineName}</button>
                      </div>
                    </>
                  ) : confirmDetach === connection.machineId ? (
                    <>
                      <strong><Unplug size={13} /> Disconnect from {connection.machineName} and use this computer independently</strong>
                      <ul className="remote-grants">
                        {detachExplanationLines(connection.machineName).map(line => <li key={line}><small>{line}</small></li>)}
                      </ul>
                      <div className="remote-actions">
                        <button className="remote-primary" disabled={busy === 'detach'}
                          onClick={() => void run('detach', async () => {
                            await window.conductor.remote.detach(connection.machineId)
                            setConfirmDetach(null)
                            setDetachOutcome(`This computer is now independent of ${connection.machineName}. Any unsaved edits to its files are kept here as recovery drafts.`)
                          })}>Use this computer independently</button>
                        <button onClick={() => setConfirmDetach(null)}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <div className="remote-actions">
                      <button className="remote-standalone-trigger" onClick={() => { setDetachOutcome(''); setConfirmDetach(connection.machineId) }}>
                        <Unplug size={13} /> Disconnect from {connection.machineName} and use this computer independently
                      </button>
                    </div>
                  )}
                  {detachOutcome && confirmDetach === null && <p className="remote-hint">{detachOutcome}</p>}
                </div>
                {connection.unconfirmedRemoteProjectIds.length > 0 && (
                  <p className="remote-warning"><ShieldAlert size={12} /> This pairing was made before projects carried an identity, so nothing here records which project on {connection.machineName} matches which project here. Confirm each pair below before work can go there.</p>
                )}
                {connection.projectGrants.map(grant => {
                  const advertised = connection.remoteProjects.find(project => project.id === grant.remoteProjectId)?.identity ?? null
                  const placement = checkRemoteProjectPlacement({ grant, advertised, machineName: connection.machineName })
                  const local = state.projects.find(project => project.id === grant.localProjectId)
                  return (
                    <div className="remote-mapping" key={grant.remoteProjectId}>
                      <strong>{local?.name ?? grant.local.name} ↔ {grant.remote.name} on {connection.machineName}</strong>
                      <small>Here: {grant.local.path}</small>
                      <small>There: {grant.remote.path}</small>
                      {!placement.ok && <small className="remote-project-problem">{placement.message}</small>}
                      <div className="remote-actions">
                        {!placement.ok && placement.reason === 'project-moved' && (
                          <button className="remote-primary" onClick={() => void run('confirm-project', () => window.conductor.remote.confirmProject(connection.machineId, grant.localProjectId, grant.remoteProjectId))}>
                            Confirm the new location
                          </button>
                        )}
                        <button onClick={() => void run('release-project', () => window.conductor.remote.releaseProject(connection.machineId, grant.localProjectId))}>Remove this pair</button>
                      </div>
                    </div>
                  )
                })}
                {connection.remoteProjects.filter(project => !connection.projectGrants.some(grant => grant.remoteProjectId === project.id)).map(project => {
                  const choice = pairs[connection.machineId + ':' + project.id] ?? ''
                  return (
                    <div className="remote-mapping" key={project.id}>
                      <strong>{project.name} on {connection.machineName}</strong>
                      <small>There: {project.path}</small>
                      {project.identityError && <small className="remote-project-problem">{project.identityError}</small>}
                      <div className="remote-actions">
                        <select value={choice} disabled={!project.identity}
                          onChange={event => setPairs({ ...pairs, [connection.machineId + ':' + project.id]: event.target.value })}>
                          <option value="">Which project here is this?</option>
                          {state.projects.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} — {candidate.path}</option>)}
                        </select>
                        <button className="remote-primary" disabled={!choice || busy === 'confirm-project'}
                          onClick={() => void run('confirm-project', () => window.conductor.remote.confirmProject(connection.machineId, choice, project.id))}>
                          Confirm this pair
                        </button>
                        {/*
                          The other answer to "which project here is this?": none of them. Pairing
                          matches two working copies the owner keeps on both machines; this opens
                          the host's copy with no local copy at all, which is what you want for a
                          project that only ever lived there.
                        */}
                        <button disabled={busy === 'open-remote-project'}
                          onClick={() => void run('open-remote-project', async () => {
                            await window.conductor.remote.openRemoteProject(connection.machineId, project.id)
                            window.dispatchEvent(new CustomEvent('conductor:projects-changed'))
                          })}>
                          Open it from {connection.machineName} instead — no copy here
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              )
            })}
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
