# omni-model — container image for Fly.io, Cloud Run, AWS App Runner, or plain Docker.
#
# Config resolution at runtime (first match wins):
#   1. OMNI_CONFIG        — inline YAML in an env var
#   2. OMNI_CONFIG_PATH   — path to a YAML file (mount or bake one in)
#   3. /app/omni.yaml     — an omni.yaml committed at the repo root (one-click deploys)
# With none of these the server exits with a message explaining the options.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm -r run build
# Produce a pruned production install of the node server with workspace deps included.
# (--legacy: copy workspace deps without requiring inject-workspace-packages=true)
RUN pnpm --filter @omni-model/node --prod deploy --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
# A root-level omni.yaml (if the deployer committed one) becomes the default config.
# The glob keeps this optional — no root config is fine when OMNI_CONFIG(_PATH) is set.
COPY omni.yaml* /app/
EXPOSE 8787
USER node
CMD ["node", "dist/cli.js"]
