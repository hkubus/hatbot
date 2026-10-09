#!/usr/bin/env bash
# Hatbot: deploy the app to the brain (PLAN.md §9.4).
# Run as root on the Proxmox host after host-setup.sh. Each run installs a new release; one that fails
# its health check is rolled back.
#   ./deploy.sh 124:/root/hatbot   deploy HEAD of a git checkout inside another container
#   ./deploy.sh hatbot.tar         deploy an archive made with `git archive HEAD`
# The first run asks for the public URL, your reverse proxy's IP, the Anthropic API key and your ntfy server.

set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"
# shellcheck source=/dev/null
source /etc/hatbot/host.env 2>/dev/null || die "/etc/hatbot/host.env not found; run host-setup.sh first"
: "${BRAIN_ID:?}"
SOURCE=${1:-}
[[ -n $SOURCE ]] || die "usage: $0 CTID:/path/to/checkout | archive.tar"
[[ $EUID -eq 0 ]] || die "run as root"
ct_running "$BRAIN_ID" || die "the brain (CT $BRAIN_ID) is not running"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

step "1/3 Source"
if [[ $SOURCE =~ ^([0-9]+):(/.+)$ ]]; then
  src_ct=${BASH_REMATCH[1]} src_dir=${BASH_REMATCH[2]}
  pct exec "$src_ct" -- git -C "$src_dir" archive --format=tar HEAD >"$tmp/app.tar" ||
    die "could not archive $src_dir in CT $src_ct"
  info "$(pct exec "$src_ct" -- git -C "$src_dir" log -1 --format='%h %s')"
  if [[ -n $(pct exec "$src_ct" -- git -C "$src_dir" status --porcelain --untracked-files=no) ]]; then
    warn "$src_dir has uncommitted changes; only the last commit is deployed"
  fi
elif [[ -f $SOURCE ]]; then
  cp "$SOURCE" "$tmp/app.tar"
else
  die "$SOURCE is neither CTID:/path nor a file"
fi
ok "archive is $(du -h "$tmp/app.tar" | cut -f1)"

step "2/3 Settings"
if ct_has_file "$BRAIN_ID" /etc/hatbot/brain.env && [[ -z ${HATBOT_PUBLIC_URL:-} ]]; then
  ok "keeping /etc/hatbot/brain.env (set HATBOT_PUBLIC_URL to change it)"
else
  def_url=${HATBOT_PUBLIC_URL:-https://hatbot.gaycats.ovh}
  def_proxies=${HATBOT_TRUSTED_PROXIES:-}
  url='' proxies=''
  read -r -p "   Public URL of the web app [$def_url]: " url || true
  read -r -p "   IP of your reverse proxy, to trust its X-Forwarded-For (empty: none) [$def_proxies]: " proxies || true
  push_secret "$BRAIN_ID" /etc/hatbot/brain.env <<EOF
HATBOT_PUBLIC_URL=${url:-$def_url}
HATBOT_TRUSTED_PROXIES=${proxies:-$def_proxies}
EOF
fi

if pct exec "$BRAIN_ID" -- grep -qs '^ANTHROPIC_API_KEY=.' /etc/hatbot/secrets.env; then
  ok "the Anthropic API key is set"
else
  key=''
  read -r -s -p "   Anthropic API key (empty to skip; chat replies fail without it): " key || true
  echo
  if [[ -n $key ]]; then
    # The key goes to curl on stdin so it never shows up in the process list.
    if printf 'x-api-key: %s\n' "$key" | curl -fsS -m 15 -o /dev/null -H @- \
      -H 'anthropic-version: 2023-06-01' https://api.anthropic.com/v1/models; then
      ok "the key works"
    else
      warn "the key was refused or the API is unreachable from the host; saving it anyway"
    fi
    {
      pct exec "$BRAIN_ID" -- sh -c 'grep -v "^ANTHROPIC_API_KEY=" /etc/hatbot/secrets.env 2>/dev/null || true'
      printf 'ANTHROPIC_API_KEY=%s\n' "$key"
    } | push_secret "$BRAIN_ID" /etc/hatbot/secrets.env
    unset key
  else
    warn "no API key; run deploy.sh again to add it"
  fi
fi

# Earlier versions of brain-provision.sh ran an ntfy server on the brain; that config doesn't count.
if [[ -z ${NTFY_URL:-} ]] && pct exec "$BRAIN_ID" -- sh -c \
  'grep -qs "^NTFY_URL=" /etc/hatbot/ntfy.env && ! grep -qs "^NTFY_URL=http://127.0.0.1:8081" /etc/hatbot/ntfy.env'; then
  ok "keeping /etc/hatbot/ntfy.env (set NTFY_URL to change it)"
else
  ntfy_url='' topic='' token=''
  read -r -p "   URL of your ntfy server (empty to skip) [${NTFY_URL:-}]: " ntfy_url || true
  ntfy_url=${ntfy_url:-${NTFY_URL:-}}
  ntfy_url=${ntfy_url%/}
  if [[ -n $ntfy_url ]]; then
    read -r -p "   ntfy topic [hatbot]: " topic || true
    read -r -s -p "   ntfy access token of a user that may publish to it (empty for none): " token || true
    echo
    # Checked from the brain, which is what has to reach it. The token goes over stdin.
    if [[ -n $token ]]; then
      if printf 'Authorization: Bearer %s\n' "$token" |
        pct exec "$BRAIN_ID" -- curl -fsS -m 10 -o /dev/null -H @- "$ntfy_url/v1/account"; then
        ok "the brain reaches $ntfy_url and the token works"
      else
        warn "the brain can't reach $ntfy_url or the token was refused; saving it anyway"
      fi
    elif pct exec "$BRAIN_ID" -- curl -fsS -m 10 -o /dev/null "$ntfy_url/v1/health"; then
      ok "the brain reaches $ntfy_url"
    else
      warn "the brain can't reach $ntfy_url; saving it anyway"
    fi
    push_secret "$BRAIN_ID" /etc/hatbot/ntfy.env <<EOF
NTFY_URL=$ntfy_url
NTFY_TOPIC=${topic:-hatbot}
NTFY_TOKEN=$token
EOF
    unset token
  else
    warn "no ntfy; run deploy.sh again to add it (needed from M2 on, for approvals)"
  fi
fi

step "3/3 Release"
: "${DESKTOP_ID:?}" "${DESKTOP_IP:?}"
mkdir "$tmp/agent"
tar -C "$tmp/agent" -xf "$tmp/app.tar" --strip-components=2 apps/desktop-agent
tar -C "$tmp/agent" -cf "$tmp/agent.tar" .
pct push "$DESKTOP_ID" "$tmp/agent.tar" /root/hatbot-desktop-agent.tar --perms 600
pct push "$DESKTOP_ID" "$HERE/desktop-deploy.sh" /root/desktop-deploy.sh --perms 700
if ! pct exec "$DESKTOP_ID" -- env DESKTOP_IP="$DESKTOP_IP" bash /root/desktop-deploy.sh /root/hatbot-desktop-agent.tar; then
  warn "desktop-agent failed to install; the brain is deployed anyway, but desktop tasks won't run"
fi

pct push "$BRAIN_ID" "$tmp/app.tar" /root/hatbot-app.tar --perms 600
pct push "$BRAIN_ID" "$HERE/brain-deploy.sh" /root/brain-deploy.sh --perms 700
pct exec "$BRAIN_ID" -- bash /root/brain-deploy.sh /root/hatbot-app.tar
