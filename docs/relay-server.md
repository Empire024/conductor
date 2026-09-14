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

## Running it

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

A certificate no authority signed is refused by default, as it should be. There is no setting to
ignore that in the app's own settings; it exists only as a dependency-level override for a relay on
a LAN you control, and a public relay should never need it.

## Pointing Conductor at it

In **Account & machines**, with *Reach my machines anywhere* on, fill in **Run the relay yourself**:
the address (`wss://relay.example.com`, or `ws://127.0.0.1:8787` while it is on this machine) and
the room secret. The address is an ordinary setting; the secret goes into the operating system's
credential store next to the device key and is never read back out, not by the renderer and not by
this file's author.

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
  a shared network. Conductor reports the relay as unavailable and reconnects with a backoff; it does
  not quietly fall back to the gist, because falling back into a rate limit is how the machines
  became unreachable in the first place.

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
