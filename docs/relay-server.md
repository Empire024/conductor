# The relay you run yourself

Conductor links two of your machines over a direct HTTPS connection whenever one can reach the
other. When they are on different networks there is no such route, so a relay carries the messages
instead. Conductor ships two, and you choose by configuring one or not.

The first needs no server at all: an encrypted mailbox in a private gist on your own GitHub account.
It works, but it is a mailbox, so it has to be polled, and every poll is charged against the
account's API budget. One paired machine that is switched off is enough to spend that budget on
probes, after which every machine reads as offline and nothing can be linked at all.

The second is this one: a small server you run, that pushes messages the moment they are written.
It answers to nobody's rate limit, it holds nothing on disk, and it cannot read a word of what it
carries.

## What it is trusted with

Only routing. Every message is sealed to the recipient's X25519 key before it leaves the sending
machine and signed by the sender's Ed25519 device key, and both cover the routing fields, so a
relay cannot read a message, alter one, re-address one, or write one that any machine will act on.
What it sees is the outside of an envelope: two machine ids and a length.

That still leaves metadata, and it leaves denial of service, which is why the relay is not open to
the world. One secret - the room secret - decides who may connect:

- A machine derives a **room id** from the secret and sends that. The secret itself never travels.
- It proves membership with an HMAC over the same statement it signs with its device key, and the
  statement contains a nonce the server issued on that connection, so a captured proof is useless
  on any other socket.
- The server answers with an HMAC of its own. A machine that does not get it back hangs up without
  publishing anything, so pointing Conductor at an impostor address tells the impostor nothing.

A machine is also its device key, on this route exactly as on the direct one: the relay refuses a
second machine claiming an id that is already connected under a different key, and the app refuses
any answer the key it called was not the one to sign.

## Linking two computers

In **Account & machines**, press **Invite a device**. That switches on everything a link needs -
remote control, the room secret, and a relay running here if this machine is not already pointed at
one - and produces a single code. On the other computer, press **I have an invite** and paste it.
The code carries the address to reach this machine, the other addresses it answers on, the
certificate to pin and the room secret, so nothing is typed on the second machine. The first machine
then asks its owner whether to allow the second one and which projects it may open.

Everything below is what that button does, for owners who want to do it themselves or differently.
It lives under **Advanced** in the same panel.

## Running it from Conductor

In **Account & machines → Advanced**, with *Reach my machines anywhere* on, turn on **Run the relay
on this machine**. Conductor starts the relay in its own process, mints a certificate for it, and
makes the room secret if this machine does not have one yet. The panel then shows the port it is on
and the addresses another machine can use. If that port is already taken - another Conductor on the
same machine, anything else - the relay moves to a free one and says which, rather than refusing to
start.

That machine has to be awake for the others to meet on it, and it is reachable from the network it
is on. To reach it from anywhere else, turn on **Let my machines reach it from anywhere**: Conductor
asks the router to forward that port to this machine, and the panel says whether it worked.

Two things commonly stop it, and the panel names both rather than reporting a generic failure:

- **The router does not answer.** UPnP is switched off in most routers by default, and a host
  firewall can also drop the reply. Turn UPnP on, or forward the port by hand - the message says
  which port to which address.
- **Your connection has no public IPv4 at all.** Providers increasingly hand out DS-Lite or
  carrier-grade NAT, where the router itself sits behind the provider's network. There is no port to
  forward, and a router page for forwarding one may not even exist.

The second case is not the dead end it looks like, because such a connection nearly always has IPv6,
and on IPv6 this machine already holds a public address of its own. Nothing needs forwarding: the
router only has to stop refusing traffic to it, on a page usually called IPv6 exposure, pinholes or
firewall rules. Those pages ask for the machine's hardware address rather than an address that can
change, so the panel prints that too, along with the exact `wss://[…]` address the other machine
will use. The relay listens on both families, so the same port serves either.

The catch worth knowing: an IPv6-only route works only for a machine that itself has IPv6. Conductor
hands over every address the relay answers on and tries them in turn, so a machine that has only
IPv4 falls back to the local address when it is on the same network - and cannot reach it otherwise.

Then create a pairing code and take it to the other machine. The code carries the relay's address,
its certificate fingerprint and the room secret, so there is nothing to type on the second machine -
and the machine running the relay still confirms the pairing by hand before anything is shared.

## Running it yourself

Make a secret. Keep the output; you will paste it into each machine.

```sh
npm run relay:secret
```

Start the relay on the machine that will host it:

```sh
CONDUCTOR_RELAY_SECRET=<the secret> npm run relay
```

It listens on `0.0.0.0:8787` by default; `CONDUCTOR_RELAY_PORT` and `CONDUCTOR_RELAY_HOST` change
that, and `--secret`, `--port` and `--host` do the same on the command line. `GET /v1/health`
answers with the protocol version, uptime and connection counts, and deliberately says nothing
about which machines are on it.

There is no build step and no `npm install`: Node runs the TypeScript directly, and the server has
no dependencies at all - its WebSocket framing is part of Conductor rather than a package. See
[src/relay-server/README.md](../src/relay-server/README.md) for the container image.

### TLS

Plain `ws://` is fine on loopback and nowhere else. To leave the machine, either terminate TLS in
front of it:

```
CONDUCTOR_RELAY_HOST=127.0.0.1 CONDUCTOR_RELAY_SECRET=… npm run relay
# then point nginx/Caddy/Cloudflare at 127.0.0.1:8787 and serve wss:// publicly
```

or let the relay serve TLS itself:

```sh
CONDUCTOR_RELAY_SECRET=… CONDUCTOR_RELAY_TLS_KEY=/etc/ssl/relay.key CONDUCTOR_RELAY_TLS_CERT=/etc/ssl/relay.crt npm run relay
```

A relay Conductor runs for you serves a certificate it signs itself, and the pairing code carries
that certificate's fingerprint. The other machine pins it: exactly one certificate will do, which is
stricter than trusting any certificate a public authority has signed, and it works without a domain
name. A relay you run yourself with a certificate from an authority needs no pin, and one with a
self-signed certificate and no pin is refused.

## Pointing Conductor at a relay somewhere else

With **Run the relay on this machine** off, the panel offers an address and a room secret instead:
`wss://relay.example.com` and the secret that relay serves. The address is an ordinary setting; the
secret goes into the operating system's credential store next to the device key and is never read
back out, not by the renderer and not by this file's author.

The panel then shows which route is carrying the machine and how many machines have checked in.
Leaving both boxes empty, or pressing **Back to the gist**, returns that machine to the gist
mailbox.

A pairing code created on a machine that uses a relay carries the address and the secret with it.
The machine being paired adopts them, unless it already has a relay of its own - moving a machine to
a different relay silently would cut every pairing it already has. You are carrying the code between
your own two machines through a channel you trust, which is the same channel a shared secret needs.

## What changes once it is on

- **Latency.** A message is pushed. The gist route polls every 1.5 seconds while a call is in
  flight and every 15 seconds when idle; this route has no poll at all.
- **Presence.** The relay states who is connected and tells everyone the moment that changes. The
  gist route had to discover it by probing, which is what made an offline machine expensive.
- **Cost.** An idle pair of machines costs one open socket. No API budget is involved.
- **Failure.** If the relay is unreachable, the direct route is still tried first and still works on
  a shared network. After forty-five seconds of a relay that cannot be reached - no IPv6 on this
  network, the machine running it asleep, an address that was true at home and is not here - the
  machines fall back to the gist mailbox so that they still meet, and the panel says that is what
  happened. The relay keeps being retried and takes over again the moment it answers. Both machines
  make that decision independently and land in the same place, which is the point: a machine that
  falls back alone has only changed which empty room it waits in.

## Limits it enforces

The numbers live in `src/shared/relay-protocol.ts`, which both the app and the server import, so
neither can drift from the other:

| | |
| --- | --- |
| Largest frame | 6 MiB, which clears a 3 MiB request once base64 has grown it |
| Handshake | 10 seconds and 16 KiB before a socket that has not authenticated is closed |
| Send rate | 200 messages a second per socket, bursting to 400 |
| Offline queue | 16 messages or 8 MiB per machine, dropped after 90 seconds |
| Room size | 64 machines |
| Router lease | one hour, renewed while the relay runs and handed back when it stops |

The send rate is a guard against a runaway loop rather than a budget: every mirrored tab polls the
machine that runs it about once a second, and each poll is a request and an answer, so ordinary work
with a dozen tabs open is already tens of messages a second. A message the relay does throttle is
tried once more rather than failing the call.

The queue is deliberately short. A caller gives up after 90 seconds, so a message held longer than
that would be delivered to a machine whose owner stopped waiting - which means running their work
late and unwatched, rather than not at all.

## When it restarts

Nothing is persisted, and nothing needs to be. Directory entries are republished by each machine on
connect, and a queued message is only worth keeping while its caller waits. A relay that restarts is
briefly empty rather than inconsistent, which is why it needs no database, no migrations and no
backups.
