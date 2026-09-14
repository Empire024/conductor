# Conductor Relay Server

A tiny WebSocket relay that routes sealed envelopes between your machines. It holds no database, no disk state, and never reads a plaintext message.

## Prerequisites

Node 24. The relay has zero npm dependencies; it runs directly from the TypeScript source.

## Run locally

Make a room secret. It is printed once; keep it, because you paste the same value into every machine that should meet here.

```
npm run relay:secret
```

Then start the relay with it:

```
CONDUCTOR_RELAY_SECRET=<the secret> npm run relay
```

`CONDUCTOR_RELAY_SECRETS` takes a comma-separated list if you want one relay to serve several rooms that cannot see each other.

You can also pass flags directly: `--secret=abc`, `--port=9000`, `--host=127.0.0.1`, `--tls-key=path/to/key.pem`, `--tls-cert=path/to/cert.pem`.

## Run in Docker

Build the image from the repository root:

```
docker build -f src/relay-server/Dockerfile -t conductor-relay .
```

Run it with the required secret:

```
docker run --rm -p 8787:8787 \
  -e CONDUCTOR_RELAY_SECRET=your-secret-here \
  conductor-relay
```

Set `CONDUCTOR_RELAY_PORT`, `CONDUCTOR_RELAY_HOST`, `CONDUCTOR_RELAY_TLS_KEY`, and `CONDUCTOR_RELAY_TLS_CERT` as needed.

## TLS note

Without `CONDUCTOR_RELAY_TLS_KEY` and `CONDUCTOR_RELAY_TLS_CERT` the relay speaks plain `ws://`. That is fine for loopback-only access or when a reverse proxy (nginx, Caddy, etc.) terminates TLS in front of it. Do not expose a plain `ws://` relay to the public internet.

## What the owner does next

In Conductor, open **Account & machines**, turn on *Reach my machines anywhere*, and fill in the relay address and the room secret under *Run the relay yourself*. A pairing code made on that machine carries both to the machine you pair with, so you only paste them once. [docs/relay-server.md](../../docs/relay-server.md) covers the rest, including what the relay can and cannot see.

## Endpoints

- `GET /v1/health` — returns `200` with JSON describing uptime, rooms, and connections.
- `WS /v1/socket` — WebSocket endpoint for authenticated machine connections.
