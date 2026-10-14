#!/usr/bin/env bash
# Hatbot: run Settings → Check everything from a shell, e.g. after a deploy.
# Usage: HATBOT_TOKEN=<API token from Settings → Account> infra/smoke.sh [https://hatbot.example]
# Exit code 1 if a check failed, 2 if Hatbot couldn't be reached. Warnings don't fail it.

set -uo pipefail
URL=${1:-${HATBOT_URL:-http://127.0.0.1:8080}}
: "${HATBOT_TOKEN:?set HATBOT_TOKEN to an API token (Settings → Account → New token)}"

out=$(curl -fsS --max-time 120 -X POST -H "authorization: Bearer $HATBOT_TOKEN" \
  "${URL%/}/api/v1/checks?text=1") || { echo "Couldn't reach Hatbot at $URL" >&2; exit 2; }
printf '%s\n' "$out"
grep -q '^FAIL' <<<"$out" && exit 1
exit 0
