# Worker supervisor. Bun runs the supervisor; Node 24 boots the compiled agent
# entrypoints (`node .output/server/index.mjs`); the docker CLI serves the
# sandbox reaper against the mounted /var/run/docker.sock.
FROM oven/bun:1.3

COPY --from=node:24.18.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24.18.0-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app

# Every workspace manifest ships before the frozen install — bun.lock covers ALL
# workspaces, so a missing one fails the build ("lockfile had changes").
# Guarded by tests/integration/dockerfile-workspace-manifests.test.ts.
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/site/package.json apps/site/
COPY packages/compiler/package.json packages/compiler/
COPY packages/db/package.json packages/db/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/shared/package.json packages/shared/
COPY tests/integration/package.json tests/integration/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/worker ./apps/worker

ENV NODE_ENV=production \
    ARTIFACT_CACHE_DIR=/var/lib/agents

EXPOSE 4000
CMD ["bun", "apps/worker/src/index.ts"]
