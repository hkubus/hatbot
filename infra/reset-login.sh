#!/usr/bin/env bash
# Hatbot: forget the owner's password and authenticator, for when you've lost them (or think someone
# else has them). Run as root on the Proxmox host. Every browser and app is signed out, the brain
# restarts, and this prints the setup code to enter on the web app's /setup page.

set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"
# shellcheck source=/dev/null
source /etc/hatbot/host.env 2>/dev/null || die "/etc/hatbot/host.env not found; run host-setup.sh first"
: "${BRAIN_ID:?}"
[[ $EUID -eq 0 ]] || die "run as root"
ct_running "$BRAIN_ID" || die "the brain (CT $BRAIN_ID) is not running"

yes=''
read -r -p "   Forget the password and authenticator, and sign out every browser and app? [y/N] " yes || true
[[ $yes == [yY]* ]] || die "nothing changed"

started=$(pct exec "$BRAIN_ID" -- date '+%Y-%m-%d %H:%M:%S')
# As the brain's user, so the database stays its own.
pct exec "$BRAIN_ID" -- runuser -u hatbot -- env HOME=/var/lib/hatbot HATBOT_DATA_DIR=/var/lib/hatbot \
  sh -c 'cd /var/lib/hatbot/app/apps/brain && exec /usr/local/bin/bun src/reset-login.ts'
pct exec "$BRAIN_ID" -- systemctl restart hatbot-brain
code=''
for _ in $(seq 1 30); do
  code=$(pct exec "$BRAIN_ID" -- journalctl -u hatbot-brain --since "$started" --no-pager -o cat |
    grep -o 'setup code [0-9a-f]*' | tail -1 || true)
  [[ -n $code ]] && break
  sleep 1
done
[[ -n $code ]] || die "the brain didn't print a setup code; see journalctl -u hatbot-brain in CT $BRAIN_ID"
ok "Open the web app's /setup page and enter ${code#setup code }"
