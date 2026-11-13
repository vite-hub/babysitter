# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# The build bakes in the release revision and the public URL.
ARG BABYSITTER_RELEASE=docker
ARG BABYSITTER_PUBLIC_URL
RUN BABYSITTER_RELEASE=$BABYSITTER_RELEASE BABYSITTER_PUBLIC_URL=$BABYSITTER_PUBLIC_URL pnpm build

FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.167.0
# git and gh check out and inspect PRs, codex runs the repair passes, and corepack runs
# each target repository's own package manager for the host install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps tini \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @openai/codex@$CODEX_VERSION \
  && npm cache clean --force \
  && corepack enable \
  && install -d -o node -g node /data /data/home /data/codex /data/tmp
COPY --from=build --chown=node:node /app/.output /app/.output
USER node
# Agent State lives in .vitehub under the working directory, so the process runs in /data.
WORKDIR /data
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  HOME=/data/home \
  CODEX_HOME=/data/codex \
  TMPDIR=/data/tmp \
  VITEHUB_AGENT_INVOCATIONS_DATABASE_URL=file:/data/.vitehub/agents/babysitter/invocations.sqlite \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
VOLUME /data
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:$PORT/api/_vitehub/host/health" >/dev/null || exit 1
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "mkdir -p \"$HOME\" \"$CODEX_HOME\" \"$TMPDIR\" && exec node /app/.output/server/index.mjs"]
