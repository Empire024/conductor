# The Conductor relay as a container: Node, the source, and nothing else.
#
# There is no build stage and no npm install, because the relay has no dependencies - Node 24 runs
# the TypeScript directly. What goes in is the source you can read in this repository, which is the
# point: the one component that holds your traffic should not arrive through a package tree.
#
# Build from the repository root:
#   docker build -f src/relay-server/Dockerfile -t conductor-relay .

FROM node:24-alpine

WORKDIR /app

# Only what the relay imports at runtime. src/shared is copied whole because it is small and its
# relay files import nothing outside it; from src/main it needs exactly two files, and pulling in
# the rest would drag Electron-side code into a container that must never run any of it.
COPY --chown=node:node src/relay-server/ src/relay-server/
COPY --chown=node:node src/shared/ src/shared/
COPY --chown=node:node src/main/device-key.ts src/main/device-key.ts
COPY --chown=node:node src/main/relay-room.ts src/main/relay-room.ts

# Nothing here needs root, and a relay that faces the internet is the last thing to give it to.
USER node

# The default port. CONDUCTOR_RELAY_PORT overrides it, and then this line is only documentation.
EXPOSE 8787

# Asks the relay the same question anyone else would. The port follows the setting rather than the
# default, so a relay moved to another port does not report itself unhealthy for ever.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${CONDUCTOR_RELAY_PORT:-8787}/v1/health" || exit 1

# No package.json travels with the source, so Node would otherwise warn once about parsing these
# files as modules. CONDUCTOR_RELAY_SECRET is required; the server refuses to start without one.
CMD ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "src/relay-server/main.ts"]
