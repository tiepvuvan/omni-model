# omni-model — container image for Fly.io, Cloud Run, AWS App Runner, or plain Docker.
#
# Config resolution at runtime (first match wins):
#   1. OMNI_CONFIG        — inline YAML in an env var
#   2. OMNI_CONFIG_PATH   — path to a YAML file (mount or bake one in)
#   3. /app/omni.yaml     — an omni.yaml committed at the repo root (one-click deploys)
# With none of these the server exits with a message explaining the options.

# --- Stage 1: build every package -------------------------------------------
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm -r run build

# --- Stage 2: production-only node_modules (symlinked workspaces intact) ----
FROM node:22-alpine AS prod-deps
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/storage-redis/package.json packages/storage-redis/
COPY packages/storage-postgres/package.json packages/storage-postgres/
COPY packages/cloudflare/package.json packages/cloudflare/
COPY packages/node/package.json packages/node/
COPY apps/cloudflare/package.json apps/cloudflare/
RUN pnpm install --prod --frozen-lockfile

# --- Stage 3: runtime --------------------------------------------------------
FROM node:22-alpine
# OCI labels: link the published GHCR package to the repo and describe it.
# (docker/metadata-action overrides these with commit-accurate values in CI.)
LABEL org.opencontainers.image.source="https://github.com/tiepvuvan/omni-model" \
      org.opencontainers.image.description="Self-hosted OpenAI-compatible AI proxy with YAML-configured auth, rate limits and model routing." \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /repo /app
COPY --from=build /repo/packages/core/dist /app/packages/core/dist
COPY --from=build /repo/packages/storage-redis/dist /app/packages/storage-redis/dist
COPY --from=build /repo/packages/storage-postgres/dist /app/packages/storage-postgres/dist
COPY --from=build /repo/packages/cloudflare/dist /app/packages/cloudflare/dist
COPY --from=build /repo/packages/node/dist /app/packages/node/dist
# A root-level omni.yaml (if the deployer committed one) becomes the default config.
# The glob keeps this optional — no root config is fine when OMNI_CONFIG(_PATH) is set.
COPY omni.yaml* /app/
EXPOSE 8787
USER node
CMD ["node", "packages/node/dist/cli.js"]
