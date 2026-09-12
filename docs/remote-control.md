# Remote control between your machines

Conductor can run selected Claude Code or Codex tabs on another computer you own while keeping the tab and its conversation visible in the computer in front of you. Remote control is off by default. Pairing a machine does not share every project: the owner chooses projects on the host and then confirms which working copy on the controlling computer matches each remote working copy.

## Sign in with GitHub

Open **Account & machines** and choose **Sign in with GitHub**. Conductor uses GitHub's device flow, so authorization happens in the owner's browser and Conductor never receives a GitHub password.

Installed builds include Conductor's public native OAuth client ID. Developers can override it with `CONDUCTOR_GITHUB_CLIENT_ID`; no client secret is used or bundled. The requested scopes are:

- `read:user`, to identify the account;
- `admin:public_key`, to register and remove this machine's device key;
- `offline_access`, to receive rotating credentials when expiring OAuth tokens are enabled.

The access token, refresh token, token expiration times, and the device private key are stored together only through the operating system credential vault. They are not sent to the renderer, written to ordinary settings, or logged. Conductor refreshes an expiring access token before use, serializes concurrent refresh attempts, persists each rotated token pair, and verifies that it still identifies the same numeric GitHub account. A rejected or expired refresh token signs the machine out. Temporary GitHub or network failures use bounded retry backoff without discarding an access token that is still valid.

Signing out removes local credentials and device keys immediately, revokes all paired authority, disconnects outbound peers, and stops the server. Conductor then makes a best-effort request to remove its public device key from GitHub. If GitHub cannot be reached, the UI tells the owner to remove the **Conductor device** key from GitHub manually.

## Enable and pair a host

On the computer that will run the work:

1. Sign in to GitHub.
2. Turn on **Let my other machines control this one**.
3. Leave exposure on **This computer only** for two isolated Conductor instances on one computer, or deliberately select **My local network** for another physical machine.
4. Create a pairing code and transfer it to the other computer through a channel you trust.

On the controlling computer, sign in to the same GitHub account, paste the code under **Machines this one can use**, and connect. The host shows the requesting machine, its GitHub account and device-key fingerprint. Choose the exact projects to share and approve the request.

The listener uses HTTPS with a self-signed certificate whose SHA-256 fingerprint is pinned from the single-use pairing code. Every later request is signed by an Ed25519 device key whose public half must still exist on the signed-in GitHub account. Pairing codes expire and are consumed once. Revocation, disabling remote control, signing out, switching accounts, or forgetting a peer wins even when GitHub verification was already in flight.

Network exposure binds the server to local interfaces. Conductor does not provide internet discovery, relay, router configuration, or firewall changes; the two machines must already be able to reach each other.

## Confirm projects and place a tab

After pairing, refresh the projects advertised by the host. For each project, explicitly confirm which local project is the same working copy. Conductor compares durable project identity and recorded paths rather than trusting a matching display name. A moved working copy requires confirmation; a different working copy must be paired again.

In a project's new-tab launcher, use **Run on** to choose an online machine that has that project confirmed. Open Claude Code or Codex normally. The linked remote tab and child tabs inherit the selected actual machine. Terminals, local-model providers, and providers whose conversation protocol cannot be mirrored remain local.

The host enforces the project grant on every operation. Remote file reads, guarded writes, project tasks, tabs, and agent operations cannot address an arbitrary path or an unshared project.

## Offline behavior

Remote conversation events are projected into the controlling computer's structured history. If the host becomes unreachable, Conductor reports the machine as offline/unreachable rather than pretending the tab is connected. Already mirrored history remains readable. New remote operations fail until that exact paired host is reachable again; history retention is not evidence that the remote process is still running.

## Troubleshooting

- **GitHub sign-in is unavailable:** unlock the OS credential store. A developer override can also explicitly disable the public OAuth client ID by supplying an empty value.
- **The other machine cannot connect:** verify that the host selected **My local network**, both machines can reach the shown address and port, and the firewall permits the connection. Create a new code if the old one expired or was used.
- **A machine is listed but unavailable for this project:** refresh its projects and confirm the matching working copies in **Account & machines**.
- **GitHub session expired or was revoked:** sign in again. Peers are revoked when the account credential is lost and must be paired again.
- **Sign-out could not remove the GitHub key:** remove the named **Conductor device** entry in GitHub's SSH key settings.

Automated integration coverage uses two isolated Conductor service/app instances with deterministic account and network fixtures. That validates the two-sided protocol without claiming verification on a second physical computer.
