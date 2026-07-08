# Control plane. Bun runs the app; Node 24 + npm are required AT RUNTIME for
# `eve build` (compiled agent projects install + build under Node — eve's
# engines check refuses Node < 24). Node pin: packages/compiler/versions.json.
FROM oven/bun:1.3

COPY --from=node:24.18.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24.18.0-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /app

# Workspace manifests first — the install layer only invalidates on dep changes.
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/compiler/package.json packages/compiler/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY tests/integration/package.json tests/integration/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/control-plane ./apps/control-plane

# /var/lib/agents must equal the worker's ARTIFACT_CACHE_DIR (compiled
# artifacts bake absolute paths — see AGENTS.md).
ENV NODE_ENV=production \
    AGENT_BUILD_ROOT=/var/lib/agents \
    NPM_CACHE_DIR=/var/lib/npm-cache

EXPOSE 3000
CMD ["bun", "apps/control-plane/src/index.ts"]
