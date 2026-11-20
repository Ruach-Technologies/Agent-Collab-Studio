# Sidekick image: the official Claude Code CLI and OpenAI Codex CLI, unmodified,
# for one client. Each sidekick uses one of them.
# Build: docker build -t ach-sidekick:dev sidekick/
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.311

# ca-certificates: TLS to api.anthropic.com / platform.claude.com.
# bsdutils (Essential in bookworm, listed so the dependency is explicit)
# provides `script`, which gives `claude auth login` a pseudo-terminal under a
# non-TTY `docker exec -i`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates bsdutils \
 && rm -rf /var/lib/apt/lists/*

# npm global install, pinned. It lands in /usr/local (root-owned, part of the
# read-only image), so the binary is never inside the per-sidekick home volume
# and is replaced on every image rebuild. The native installer writes into
# ~/.local, which the home volume would shadow and freeze at its first version.
RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

# Codex CLI, same reasoning: npm puts the launcher in /usr/local/bin and the
# native musl binary in /usr/local/lib/node_modules (read-only image). The
# version check runs with a throwaway CODEX_HOME so nothing lands in a home.
ARG CODEX_VERSION=0.170.0
RUN npm install -g --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && mkdir /tmp/codex-build \
 && CODEX_HOME=/tmp/codex-build codex --version \
 && rm -rf /tmp/codex-build /root/.codex /root/.npm

# Non-root user 1000:1000 (the base image's `node` user, renamed).
# /home/sidekick/.codex is CODEX_HOME; Codex refuses to start if it is
# missing. Baking it in seeds fresh home volumes; the entrypoint below also
# creates it for volumes that predate it.
RUN groupmod -n sidekick node \
 && usermod -l sidekick -d /home/sidekick -m node \
 && mkdir -p /opt/sidekick/work /home/sidekick/.codex \
 && chown -R 1000:1000 /home/sidekick

# Managed settings: highest precedence, cannot be overridden from ~/.claude.
COPY managed-settings.json /etc/claude-code/managed-settings.json
RUN chmod 0644 /etc/claude-code/managed-settings.json

# Codex system config (defaults) and requirements (enforced constraints).
COPY codex-config.toml /etc/codex/config.toml
COPY codex-requirements.toml /etc/codex/requirements.toml
RUN chmod 0755 /etc/codex \
 && chmod 0644 /etc/codex/config.toml /etc/codex/requirements.toml

# No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: in -p mode an API key would
# override the client's subscription login. CLAUDE_CODE_DISABLE_CLAUDE_MDS
# stops ~/.claude/CLAUDE.md (on the writable home volume) from loading.
ENV HOME=/home/sidekick \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    ENABLE_CLAUDEAI_MCP_SERVERS=false \
    CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
    CODEX_HOME=/home/sidekick/.codex

USER 1000:1000
# Empty, root-owned working directory for turns: no CLAUDE.md, no .mcp.json,
# no AGENTS.md, no .codex/.
WORKDIR /opt/sidekick/work
# The hub runs `docker run ... ach-sidekick:dev sleep infinity`, which replaces
# CMD but not ENTRYPOINT, so CODEX_HOME is created here on every start.
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p \"$CODEX_HOME\" 2>/dev/null; exec \"$@\"", "sidekick"]
CMD ["sleep", "infinity"]
