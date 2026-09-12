# Conductor local-agent sandbox: the execution boundary for local models.
#
# Small on purpose - bash, git, Node, Python and a few diff/search utilities, nothing more.
# The image build is the only step allowed to use the network; the runtime container is always
# started with --network none. No secrets are baked in, and nothing here runs as root.
#
# The tag is pinned to a stable Debian-based release line. `setup` records the digest the local
# Docker actually resolved into .local-models/config.json, so the image in use stays identifiable.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      procps \
      less \
      ca-certificates \
      make \
 && rm -rf /var/lib/apt/lists/*

# A fixed non-root uid, matching the --user the runtime always passes.
RUN useradd --uid 10001 --user-group --create-home --shell /bin/bash agent \
 && mkdir -p /workspace \
 && chown 10001:10001 /workspace

# The workspace is a bind mount owned by the host, so git needs to accept it without being
# handed a writable global config at runtime (the root filesystem is read-only).
RUN printf '[safe]\n\tdirectory = *\n' > /etc/gitconfig

USER 10001:10001
WORKDIR /workspace
ENV HOME=/home/agent \
    NPM_CONFIG_CACHE=/tmp/npm \
    PIP_CACHE_DIR=/tmp/pip \
    XDG_CACHE_HOME=/tmp/cache

CMD ["sleep", "infinity"]
