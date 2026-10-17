#!/usr/bin/env bash
# Hatbot: deploy the app to the brain (PLAN.md §9.4).
# Run as root on the Proxmox host after host-setup.sh. Each run installs a new release; one that fails
# its health check is rolled back.
#   ./deploy.sh 124:/root/hatbot   deploy HEAD of a git checkout inside another container
#   ./deploy.sh hatbot.tar         deploy an archive made with `git archive HEAD`
# The first run asks for the public URL, your reverse proxy's IP, the Anthropic API key, your ntfy server
# and the git repository the Update button in Settings pulls from.

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
src_sha='' src_subject='' src_remote=''
if [[ $SOURCE =~ ^([0-9]+):(/.+)$ ]]; then
  src_ct=${BASH_REMATCH[1]} src_dir=${BASH_REMATCH[2]}
  pct exec "$src_ct" -- git -C "$src_dir" archive --format=tar HEAD >"$tmp/app.tar" ||
    die "could not archive $src_dir in CT $src_ct"
  src_sha=$(pct exec "$src_ct" -- git -C "$src_dir" rev-parse HEAD)
  src_subject=$(pct exec "$src_ct" -- git -C "$src_dir" log -1 --format=%s)
  # Without any user:password@ part.
  src_remote=$(pct exec "$src_ct" -- git -C "$src_dir" remote get-url origin 2>/dev/null |
    sed -E 's#^(https?://)[^/@]*@#\1#' || true)
  info "${src_sha:0:7} $src_subject"
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
  def_url=${HATBOT_PUBLIC_URL:-}
  def_proxies=${HATBOT_TRUSTED_PROXIES:-}
  url='' proxies=''
  until [[ ${url:-$def_url} == http*://* ]]; do
    read -r -p "   Public URL of the web app, e.g. https://hatbot.example.com${def_url:+ [$def_url]}: " url ||
      die "the web app's public URL is needed"
  done
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
  if pct exec "$BRAIN_ID" -- grep -qsxE 'NTFY_TOPIC=(hatbot)?' /etc/hatbot/ntfy.env; then
    warn "the ntfy topic is the old shared default; run deploy.sh with NTFY_URL set to pick a random one"
  fi
else
  ntfy_url='' topic='' token=''
  read -r -p "   URL of your ntfy server (empty to skip) [${NTFY_URL:-}]: " ntfy_url || true
  ntfy_url=${ntfy_url:-${NTFY_URL:-}}
  ntfy_url=${ntfy_url%/}
  if [[ -n $ntfy_url ]]; then
    # Whoever reads the topic sees every notification and can press its Approve buttons, so the
    # suggestion is one nobody can guess.
    def_topic=hatbot-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
    read -r -p "   ntfy topic [$def_topic]: " topic || true
    until [[ ${topic:-$def_topic} =~ ^[-_A-Za-z0-9]{1,64}$ ]]; do
      read -r -p "   only letters, digits, - and _ [$def_topic]: " topic || true
    done
    topic=${topic:-$def_topic}
    if ((${#topic} < 20)); then
      warn "a short topic can be guessed; on a server that lets anyone read, anyone could approve for you"
    fi
    read -r -s -p "   ntfy access token of a user that may publish to it (recommended): " token || true
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
    [[ -n $token ]] || warn "no token: the server must let anyone publish to the topic, so a notification that looks like Hatbot's may not be"
    # A server that lets anyone read the topic shows them every notification, Approve buttons included.
    if pct exec "$BRAIN_ID" -- curl -fsS -m 10 -o /dev/null "$ntfy_url/$topic/json?poll=1&since=$(date +%s)" 2>/dev/null; then
      warn "$ntfy_url lets anyone read the topic; allow only your ntfy user to read it (ntfy's access control)"
    fi
    push_secret "$BRAIN_ID" /etc/hatbot/ntfy.env <<EOF
NTFY_URL=$ntfy_url
NTFY_TOPIC=$topic
NTFY_TOKEN=$token
EOF
    unset token
  else
    warn "no ntfy; run deploy.sh again to add it (needed from M2 on, for approvals)"
  fi
fi

# The Update button in Settings: hatbot-update on the brain fetches from here (as root; the brain
# service never sees the token).
if [[ -z ${HATBOT_GIT_URL:-} ]] && ct_has_file "$BRAIN_ID" /etc/hatbot/update.env; then
  ok "keeping /etc/hatbot/update.env (set HATBOT_GIT_URL to change it)"
else
  def_git=${HATBOT_GIT_URL:-$src_remote}
  git_url='' git_branch='' git_user='' git_token=''
  read -r -p "   Git repository the Update button pulls from, https (empty to skip) [$def_git]: " git_url || true
  git_url=${git_url:-$def_git}
  if [[ $git_url == https://* ]]; then
    read -r -p "   Branch [main]: " git_branch || true
    git_branch=${git_branch:-main}
    read -r -s -p "   Access token that can read the repository (empty for a public one): " git_token || true
    echo
    if [[ -n $git_token ]]; then
      def_user=$(sed -E 's#^https://[^/]+/([^/]+)/.*#\1#' <<<"$git_url")
      read -r -p "   Forgejo user for the token [$def_user]: " git_user || true
      git_user=${git_user:-$def_user}
    fi
    # Checked from the brain, which is what has to reach it. The token goes over stdin.
    # shellcheck disable=SC2016
    check='IFS= read -r t
      if [ -n "$t" ]; then
        b=$(printf "%s:%s" "$2" "$t" | base64 -w0)
        export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $b"
      fi
      GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$1" "refs/heads/$3" >/dev/null'
    if printf '%s\n' "$git_token" | pct exec "$BRAIN_ID" -- sh -c "$check" sh "$git_url" "$git_user" "$git_branch"; then
      ok "the brain can read $git_branch from $git_url"
    else
      warn "the brain can't read $git_branch from $git_url; saving it anyway"
    fi
    {
      printf 'HATBOT_GIT_URL=%q\nHATBOT_GIT_BRANCH=%q\nHATBOT_GIT_USER=%q\nHATBOT_GIT_TOKEN=%q\n' \
        "$git_url" "$git_branch" "$git_user" "$git_token"
      # Kept from the file this replaces: commit signature checks (README.md).
      pct exec "$BRAIN_ID" -- sh -c 'grep -s "^HATBOT_UPDATE_SIGNERS=" /etc/hatbot/update.env || true'
    } | push_secret "$BRAIN_ID" /etc/hatbot/update.env
    unset git_token
  elif [[ -n $git_url ]]; then
    warn "only https repositories are supported; skipping updates"
  else
    warn "no repository; the Update button stays off until you run deploy.sh again"
  fi
fi

step "3/3 Release"
: "${DESKTOP_ID:?}" "${DESKTOP_IP:?}"
mkdir "$tmp/agent"
tar -C "$tmp/agent" -xf "$tmp/app.tar" --strip-components=2 apps/desktop-agent
[[ -z $src_sha ]] || echo "$src_sha" >"$tmp/agent/VERSION"
tar -C "$tmp/agent" -cf "$tmp/agent.tar" .
pct push "$DESKTOP_ID" "$tmp/agent.tar" /root/hatbot-desktop-agent.tar --perms 600
pct push "$DESKTOP_ID" "$HERE/desktop-deploy.sh" /root/desktop-deploy.sh --perms 700
if ! pct exec "$DESKTOP_ID" -- env DESKTOP_IP="$DESKTOP_IP" bash /root/desktop-deploy.sh /root/hatbot-desktop-agent.tar; then
  warn "desktop-agent failed to install; the brain is deployed anyway, but desktop tasks won't run"
fi

pct push "$BRAIN_ID" "$tmp/app.tar" /root/hatbot-app.tar --perms 600
pct push "$BRAIN_ID" "$HERE/brain-deploy.sh" /root/brain-deploy.sh --perms 700
pct exec "$BRAIN_ID" -- env RELEASE_SUBJECT="$src_subject" bash /root/brain-deploy.sh /root/hatbot-app.tar
