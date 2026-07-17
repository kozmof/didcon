# based on https://github.com/anthropics/claude-code/tree/main/.devcontainer
# and https://www.chainguard.dev/unchained/migrating-a-node-js-application-to-chainguard-images

# Build island (https://github.com/landlock-lsm/island) — Landlock-based filesystem sandbox.
# Uses +crt-static to produce a fully static binary that works in any Linux environment.
FROM cgr.dev/chainguard/rust:latest-dev AS island-builder
USER root
ENV CARGO_HOME=/cargo
ARG ISLAND_REV=05a9d699fbf30289fd2af4311becf38ceb334df2
RUN cargo install --git https://github.com/landlock-lsm/island --rev ${ISLAND_REV} island

FROM cgr.dev/chainguard/node:latest-dev

# Option: specify versions explicitly
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG NPM_VERSION=11.17.0

# Switch to root for package installation
USER root

# Copy island binary from builder stage
COPY --from=island-builder /cargo/bin/island /usr/local/bin/island

# Install basic development tools and iptables/ipset
RUN apk update && apk add \
  less \
  git \
  procps \
  fzf \
  man-db \
  unzip \
  gnupg \
  iptables \
  ipset \
  iproute2 \
  bind-tools \
  jq \
  wget \
  bash \
  su-exec \
  && rm -rf /var/cache/apk/*

# Optional: herdr, a terminal agent-multiplexer (https://herdr.dev/).
# Pinned release binary with SHA256 verification, root-owned so it cannot
# self-update. Installed under /opt/herdr (not /usr/local/bin, which is
# reserved for island shims); /usr/local/bin/herdr is the sandboxing shim.
# herdr.dev is intentionally NOT firewall-whitelisted at runtime.
ARG INSTALL_HERDR=false
ARG HERDR_VERSION=0.7.4
ARG HERDR_SHA256=bc0fc02d4ba500f9cac2353a43e67fe036785ecca6eb55378e050fac3c103059
RUN if [ "$INSTALL_HERDR" = "true" ]; then \
      wget -q https://github.com/ogulcancelik/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64 -O /tmp/herdr && \
      echo "${HERDR_SHA256}  /tmp/herdr" | sha256sum -c - && \
      mkdir -p /opt/herdr/bin && \
      install -o root -g root -m 0755 /tmp/herdr /opt/herdr/bin/herdr && \
      rm /tmp/herdr && \
      /opt/herdr/bin/herdr --version ; \
    fi

ARG USERNAME=dev

# Create non-root user
RUN addgroup ${USERNAME} && adduser -D -G ${USERNAME} -s /bin/bash ${USERNAME}

# Agent and package-manager binaries are enforcement assets. Keep them root-owned.
RUN mkdir -p /usr/local/share/npm-global

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R ${USERNAME} /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions.
# config/codex must pre-exist: the codex island profile sets CODEX_HOME there
# and codex errors out instead of creating a missing directory.
# .aikido must pre-exist so the herdr Landlock policy can bind a rule to it
# (safe-chain writes its malware-scan state there).
RUN mkdir -p /workspace /home/${USERNAME}/.claude /home/${USERNAME}/.codex/tmp/arg0 \
    /home/${USERNAME}/.aikido \
    /home/${USERNAME}/.island/claude/config /home/${USERNAME}/.island/claude/data \
    /home/${USERNAME}/.island/claude/cache /home/${USERNAME}/.island/claude/state \
    /home/${USERNAME}/.island/claude/runtime /home/${USERNAME}/.island/claude/tmp \
    /home/${USERNAME}/.island/codex/config/codex /home/${USERNAME}/.island/codex/data \
    /home/${USERNAME}/.island/codex/cache /home/${USERNAME}/.island/codex/state \
    /home/${USERNAME}/.island/codex/runtime /home/${USERNAME}/.island/codex/tmp \
    /home/${USERNAME}/.island/herdr/config /home/${USERNAME}/.island/herdr/data \
    /home/${USERNAME}/.island/herdr/cache /home/${USERNAME}/.island/herdr/state \
    /home/${USERNAME}/.island/herdr/runtime /home/${USERNAME}/.island/herdr/tmp \
    /home/${USERNAME}/.config/npm && \
  chown -R ${USERNAME}:${USERNAME} /workspace /home/${USERNAME}/.claude /home/${USERNAME}/.codex \
    /home/${USERNAME}/.aikido \
    /home/${USERNAME}/.island /home/${USERNAME}/.config

# Public registry policy is root-owned and contains no credentials.
COPY .npmrc /etc/npmrc
RUN chmod 0444 /etc/npmrc

WORKDIR /workspace

# Set up non-root user
USER dev

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Set the default editor and visual
ENV EDITOR=vi
ENV VISUAL=vi

# Install npm itself into the npm-global prefix so the shim can find it at
# /usr/local/share/npm-global/bin/npm, then install Claude Code.
# Both installs happen before the npm shim is in place, so they run unsandboxed.
# npm invoked as root runs lifecycle scripts as an unprivileged user, so
# claude-code's postinstall cannot replace its root-owned bin/claude.exe
# placeholder with the native binary — run install.cjs explicitly, then
# `claude --version` so the build fails if the binary is still the stub.
USER root
RUN npm install -g npm@${NPM_VERSION} && \
    npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && \
    npm install -g @openai/codex@${CODEX_VERSION} && \
    node /usr/local/share/npm-global/lib/node_modules/@anthropic-ai/claude-code/install.cjs && \
    /usr/local/share/npm-global/bin/claude --version && \
    chown -R root:root /usr/local/share/npm-global && \
    chmod -R go-w /usr/local/share/npm-global

# Switch back to root to deploy island profiles, shims, and shell aliases
USER root

# Island profiles (Landlock sandbox policies per-tool)
COPY island/profiles/ /etc/island/profiles/
RUN chown -R root:root /etc/island && chmod -R go-w,a+rX /etc/island

# Binary shims wrap npm, git, pnpm, claude, codex, and herdr with Island sandboxing.
# /usr/local/bin must stay before /usr/bin in PATH so normal invocations use
# these shims; direct paths to the underlying binaries remain an explicit bypass.
COPY scripts/shims/ /usr/local/bin/
RUN chmod 755 /usr/local/bin/npm /usr/local/bin/git /usr/local/bin/pnpm /usr/local/bin/claude /usr/local/bin/codex /usr/local/bin/herdr

# Shell alias: 'claude' runs via island claude-code profile
COPY --chown=${USERNAME}:${USERNAME} bash_aliases /home/${USERNAME}/.bash_aliases
RUN printf '[ -f ~/.bash_aliases ] && . ~/.bash_aliases\n' > /home/${USERNAME}/.bashrc && \
    chown ${USERNAME}:${USERNAME} /home/${USERNAME}/.bashrc

# Switch back to root for firewall setup
USER root

# Set up network firewall scripts and log infrastructure
COPY scripts/ /opt/scripts/
COPY extra-whitelist.conf /opt/scripts/extra-whitelist.conf
RUN chmod +x /opt/scripts/*.sh && \
    touch /var/log/firewall.log /var/log/firewall-status.txt && \
    chmod 644 /var/log/firewall.log /var/log/firewall-status.txt

ENTRYPOINT ["/opt/scripts/entrypoint.sh"]
CMD ["sleep", "infinity"]
