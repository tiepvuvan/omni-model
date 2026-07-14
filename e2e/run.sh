#!/usr/bin/env bash
#
# End-to-end verification of the whole chain against a real upstream (OpenRouter):
#
#   1. Node E2E     omni-model proxy -> OpenRouter: chat, streaming, tool calling
#   2. MacPaw E2E   MacPaw/OpenAI client + OmniAuthMiddleware -> proxy (macOS)
#   3. Foundation   FoundationModels LanguageModelSession -> proxy (iOS 27 sim)
#
# Usage:
#   OPENROUTER_API_KEY=sk-or-... e2e/run.sh
#
# Optional env:
#   OMNI_E2E_MODEL       upstream model (default: openai/gpt-4o-mini)
#   OMNI_E2E_SIMULATOR   xcodebuild -destination (default: iPhone 17 Pro, iOS 27.0)
#
set -euo pipefail
cd "$(dirname "$0")/.."

: "${OPENROUTER_API_KEY:?Set OPENROUTER_API_KEY — get a key at https://openrouter.ai}"
export OMNI_E2E_MODEL="${OMNI_E2E_MODEL:-openai/gpt-4o-mini}"
SIM="${OMNI_E2E_SIMULATOR:-platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0}"

echo "==> Building packages"
pnpm build >/dev/null

echo "==> [1/3] Node E2E — proxy -> OpenRouter (chat, streaming, tools)"
pnpm test:e2e

echo "==> Starting the proxy on :8788 for the Swift suites"
PORT=8788 node packages/node/dist/cli.js --config e2e/omni.e2e.yaml >/tmp/omni-e2e-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  curl -sf http://localhost:8788/healthz >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf http://localhost:8788/healthz >/dev/null || {
  echo "proxy failed to start:"; cat /tmp/omni-e2e-server.log; exit 1
}

echo "==> [2/3] MacPaw E2E — MacPaw/OpenAI client (macOS)"
( cd swift/OmniModelClientKit && swift test )

echo "==> [3/3] FoundationModels E2E — LanguageModelSession (iOS 27 simulator)"
( cd swift/OmniModelFoundation \
  && xcodebuild test -scheme OmniModelFoundation -destination "$SIM" CODE_SIGNING_ALLOWED=NO -quiet )

echo "==> All end-to-end suites passed."
