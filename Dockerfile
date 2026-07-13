# omni-model — container image for Fly.io, Cloud Run, AWS App Runner, or plain Docker.
#
# Config resolution at runtime (first match wins):
#   1. OMNI_CONFIG        — inline YAML in an env var
#   2. OMNI_CONFIG_PATH   — path to a YAML file (mount or bake one in)
#   3. /app/omni.yaml     — a config committed at the repo root (one-click deploys)

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm -r run build
# Produce a pruned production install of the node server with workspace deps included.
RUN pnpm --filter @omni-model/node --prod deploy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
# A root-level omni.yaml (if the deployer committed one) becomes the default config.
COPY omni.yaml* examples/omni.yaml /app/config-examples/
RUN if [ -f /app/config-examples/omni.yaml ]; then cp /app/config-examples/omni.yaml /app/omni.yaml; fi
EXPOSE 8787
USER node
CMD ["node", "dist/cli.js"]
