# Web SPA + API gateway. Stage 1 builds the Vite bundle with an EMPTY
# VITE_API_URL — the SPA resolves it to the page origin at runtime
# (apps/web/src/lib/api-client.ts), so the image bakes in no domain.
FROM oven/bun:1.3 AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/compiler/package.json packages/compiler/
COPY packages/db/package.json packages/db/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/shared/package.json packages/shared/
COPY tests/integration/package.json tests/integration/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/web ./apps/web
ENV VITE_API_URL=""
RUN bun run --cwd apps/web build

FROM nginx:1.29-alpine
COPY infra/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
