# omni-model — the container image. This is the only supported deployment target.
#
# Requires a PostgreSQL database: everything (configuration, rate limits, write
# keys, request logs) is stored there. Configuration is managed at runtime
# through the admin API, not through environment variables.

# --- Stage 1: build every package -------------------------------------------
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r run build

# --- Stage 2: production-only node_modules (symlinked workspaces intact) ----
FROM node:22-alpine AS prod-deps
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/postgres/package.json packages/postgres/
COPY packages/admin/package.json packages/admin/
COPY packages/node/package.json packages/node/
RUN pnpm install --prod --frozen-lockfile

# --- Stage 3: runtime --------------------------------------------------------
FROM node:22-alpine
# OCI labels: link the published GHCR package to the repo and describe it.
# (docker/metadata-action overrides these with commit-accurate values in CI.)
LABEL org.opencontainers.image.source="https://github.com/tiepvuvan/omni-model" \
      org.opencontainers.image.description="Self-hosted OpenAI-compatible AI proxy with dashboard-configured auth, rate limits and model routing, backed by PostgreSQL." \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /repo /app
COPY --from=build /repo/packages/core/dist /app/packages/core/dist
COPY --from=build /repo/packages/postgres/dist /app/packages/postgres/dist
COPY --from=build /repo/packages/admin/dist /app/packages/admin/dist
COPY --from=build /repo/packages/node/dist /app/packages/node/dist
# On PATH so `docker exec <container> omni-model create-admin …` works, which is
# how an operator is seeded in a deployment with no public sign-up. `migrate` and
# `import-config` are reachable the same way.
RUN chmod +x /app/packages/node/dist/cli.js \
  && ln -s /app/packages/node/dist/cli.js /usr/local/bin/omni-model
EXPOSE 8787
# Liveness, not readiness: `/healthz` answers whenever the process is up, so a
# misconfigured proxy is left running to be fixed rather than restarted in a
# loop. Orchestrators should poll `/readyz` to decide whether to route traffic —
# it also reports "draining" during a shutdown, which is what takes an instance
# out of rotation while it finishes the requests it already accepted.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
USER node
# SIGTERM drains in-flight requests, including streams still being written.
# Give the container more than that budget: `docker stop -t 30`, or Kubernetes
# `terminationGracePeriodSeconds: 30` against the 25s default drain.
STOPSIGNAL SIGTERM
CMD ["node", "packages/node/dist/cli.js"]
