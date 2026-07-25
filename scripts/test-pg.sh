#!/usr/bin/env bash
#
# Run the integration suites against a real PostgreSQL.
#
#   pnpm test:pg                 # start Postgres if needed, run every suite
#   pnpm test:pg packages/postgres   # ...or just some of them
#
# The container is left running so repeat runs are fast; stop it with
# `pnpm test:pg:down`. Set TEST_POSTGRES_URL to point at your own server
# instead, and this script skips Docker entirely.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE=docker-compose.test.yml

if [ -n "${TEST_POSTGRES_URL:-}" ]; then
  echo "==> Using TEST_POSTGRES_URL from the environment"
else
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not available. Start it, or set TEST_POSTGRES_URL to your own server." >&2
    exit 1
  fi

  echo "==> Starting PostgreSQL ($COMPOSE_FILE)"
  docker compose -f "$COMPOSE_FILE" up -d --wait

  export TEST_POSTGRES_URL="postgres://omni:secret@localhost:55432/omni_test"
fi

echo "==> Running integration suites"
# Without the gate the suites skip themselves, which would look like a pass.
exec pnpm exec vitest run "$@"
