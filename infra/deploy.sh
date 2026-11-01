#!/usr/bin/env bash
# Hatbot: deploy the app to the brain, the desktop and the boxes guest.
# Run where you ran host-setup.sh (as root on the Proxmox host) or ssh-setup.sh. Each run installs a new
# release; one that fails its health check is rolled back.
#   ./deploy.sh ~/hatbot           deploy HEAD of a git checkout on this machine
#   ./deploy.sh 124:/root/hatbot   Proxmox: deploy HEAD of a git checkout inside another container
#   ./deploy.sh hatbot.tar         deploy an archive made with `git archive HEAD`
# The first run asks for the public URL, your reverse proxy's IP and the git repository the Update button
# in Settings pulls from. The model provider's key and ntfy are set in the web app's guided setup.

set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"
SOURCE=${1:-}
[[ -n $SOURCE ]] || die "usage: $0 /path/to/checkout | CTID:/path/to/checkout | archive.tar"
load_state
guest_up "$BRAIN" || die "the brain ($(guest_label "$BRAIN")) is not running or can't be reached"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

step "1/3 Source"
src_sha='' src_subject='' src_remote=''
if [[ $SOURCE =~ ^([0-9]+):(/.+)$ && $HATBOT_TRANSPORT == pct ]]; then
  src_ct=${BASH_REMATCH[1]} src_dir=${BASH_REMATCH[2]}
  # Whether it's a checkout at all, before a directory named on the command line is searched as root in it.
  pct exec "$src_ct" -- git --no-pager -C "$src_dir" rev-parse --git-dir >/dev/null 2>&1 ||
    die "$src_dir in CT $src_ct isn't a git checkout"
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
elif [[ -d $SOURCE ]]; then
  git -C "$SOURCE" rev-parse --git-dir >/dev/null 2>&1 || die "$SOURCE isn't a git checkout"
  git -C "$SOURCE" archive --format=tar HEAD >"$tmp/app.tar"
  src_sha=$(git -C "$SOURCE" rev-parse HEAD)
  src_subject=$(git -C "$SOURCE" log -1 --format=%s)
  src_remote=$(git -C "$SOURCE" remote get-url origin 2>/dev/null | sed -E 's#^(https?://)[^/@]*@#\1#' || true)
  info "${src_sha:0:7} $src_subject"
  if [[ -n $(git -C "$SOURCE" status --porcelain --untracked-files=no) ]]; then
    warn "$SOURCE has uncommitted changes; only the last commit is deployed"
  fi
elif [[ -f $SOURCE ]]; then
  cp "$SOURCE" "$tmp/app.tar"
else
  die "$SOURCE is neither a checkout, CTID:/path nor a file"
fi
ok "archive is $(du -h "$tmp/app.tar" | cut -f1)"

step "2/3 Settings"
if guest_has_file "$BRAIN" /etc/hatbot/brain.env && [[ -z ${HATBOT_PUBLIC_URL:-} ]]; then
  ok "keeping /etc/hatbot/brain.env (set HATBOT_PUBLIC_URL to change it)"
else
  def_url=${HATBOT_PUBLIC_URL:-}
  def_proxies=${HATBOT_TRUSTED_PROXIES:-}
  url='' proxies=''
  # Only the scheme and host: the brain compares it with browsers' Origin, and refuses a path.
  until [[ ${url:-$def_url} =~ ^https?://[^/?#@]+/?$ ]]; do
    read -r -p "   Public URL of the web app, e.g. https://hatbot.example.com${def_url:+ [$def_url]}: " url ||
      die "the web app's public URL is needed"
  done
  read -r -p "   IP of your reverse proxy, to trust its X-Forwarded-For (empty: none) [$def_proxies]: " proxies || true
  push_secret "$BRAIN" /etc/hatbot/brain.env <<EOF
HATBOT_PUBLIC_URL=${url:-$def_url}
HATBOT_TRUSTED_PROXIES=${proxies:-$def_proxies}
EOF
fi

# The Update button in Settings: hatbot-update on the brain fetches from here (as root; the brain
# service never sees the token).
if [[ -z ${HATBOT_GIT_URL:-} ]] && guest_has_file "$BRAIN" /etc/hatbot/update.env; then
  ok "keeping /etc/hatbot/update.env (set HATBOT_GIT_URL to change it)"
  if ! guest_exec "$BRAIN" grep -qs '^HATBOT_UPDATE_SIGNERS=.' /etc/hatbot/update.env; then
    warn "Update deploys any commit on the branch; run deploy.sh with HATBOT_GIT_URL set to give it your signing key"
  fi
else
  def_git=${HATBOT_GIT_URL:-$src_remote}
  # Updates run the new commit's brain-deploy.sh as root on the brain, so the upstream repository isn't
  # offered by default: point it at a fork you control, or skip and run deploy.sh to update.
  if [[ -z ${HATBOT_GIT_URL:-} && $def_git =~ ^https://github\.com/hkubus/hatbot(\.git)?/?$ ]]; then
    info "Update runs whatever the repository's branch holds as root on the brain, so use one you control"
    info "(a fork), or leave it empty and update by running deploy.sh again."
    def_git=''
  fi
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
      read -r -p "   Git user the token belongs to [$def_user]: " git_user || true
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
    if printf '%s\n' "$git_token" | guest_exec "$BRAIN" sh -c "$check" sh "$git_url" "$git_user" "$git_branch"; then
      ok "the brain can read $git_branch from $git_url"
    else
      warn "the brain can't read $git_branch from $git_url; saving it anyway"
    fi
    # An update runs the new commit's brain-deploy.sh as root, so only commits signed with your key
    # are deployed once there is one (README.md, "Signed commits only").
    signers=$(guest_exec "$BRAIN" sh -c 'grep -s "^HATBOT_UPDATE_SIGNERS=." /etc/hatbot/update.env || true')
    if [[ -n $signers ]]; then
      ok "keeping the commit signature check ($signers)"
    else
      signing_key=''
      read -r -p "   SSH public key you sign commits with, so only those are deployed (empty: any commit): " signing_key || true
      if [[ $signing_key =~ ^(ssh-|ecdsa-|sk-)[^[:space:]]+[[:space:]]+[A-Za-z0-9+/=]+ ]]; then
        printf 'owner namespaces="git" %s\n' "$signing_key" | push_secret "$BRAIN" /etc/hatbot/allowed_signers
        signers=HATBOT_UPDATE_SIGNERS=/etc/hatbot/allowed_signers
      elif [[ -n $signing_key ]]; then
        warn "that isn't an SSH public key; Update deploys any commit on $git_branch"
      else
        warn "Update deploys any commit on $git_branch, so whoever can push to it can run code on the brain"
      fi
    fi
    {
      printf 'HATBOT_GIT_URL=%q\nHATBOT_GIT_BRANCH=%q\nHATBOT_GIT_USER=%q\nHATBOT_GIT_TOKEN=%q\n' \
        "$git_url" "$git_branch" "$git_user" "$git_token"
      [[ -z $signers ]] || printf '%s\n' "$signers"
    } | push_secret "$BRAIN" /etc/hatbot/update.env
    unset git_token
  elif [[ -n $git_url ]]; then
    warn "only https repositories are supported; skipping updates"
  else
    warn "no repository; the Update button stays off until you run deploy.sh again"
  fi
fi

step "3/3 Release"
# release_script PLUGIN SCRIPT: the deployed commit's own, or this checkout's for one from before the
# guests' scripts were their plugins'.
release_script() {
  local path=plugins/$1/infra/$2
  if tar -C "$tmp" -xf "$tmp/app.tar" "$path" 2>/dev/null; then
    printf '%s\n' "$tmp/$path"
  else
    guest_script "$1" "$2"
  fi
}
if [[ -z $DESKTOP ]]; then
  info "no desktop (ssh-setup.sh was given none); deploying only the brain"
else
  : "${DESKTOP_IP:?}"
  # desktop-agent, with packages/shared copied where the workspace links it: it imports shared's keys.ts.
  mkdir -p "$tmp/agent/node_modules/@hatbot/shared"
  tar -C "$tmp/agent" -xf "$tmp/app.tar" --strip-components=2 apps/desktop-agent
  tar -C "$tmp/agent/node_modules/@hatbot/shared" -xf "$tmp/app.tar" --strip-components=2 \
    packages/shared/package.json packages/shared/src
  [[ -z $src_sha ]] || echo "$src_sha" >"$tmp/agent/VERSION"
  tar -C "$tmp/agent" -cf "$tmp/agent.tar" .
  guest_push "$DESKTOP" "$tmp/agent.tar" /root/hatbot-desktop-agent.tar 600
  script=$(release_script desktop desktop-deploy.sh)
  guest_push "$DESKTOP" "$script" /root/desktop-deploy.sh 700
  if ! guest_exec "$DESKTOP" env DESKTOP_IP="$DESKTOP_IP" bash /root/desktop-deploy.sh /root/hatbot-desktop-agent.tar; then
    warn "desktop-agent failed to install; the brain is deployed anyway, but desktop tasks won't run"
  fi
fi

if [[ -z $BOXES ]]; then
  info "no boxes guest; boxes are only pages"
elif ! tar -tf "$tmp/app.tar" apps/hatbox/src/main.ts >/dev/null 2>&1; then
  warn "this commit has no apps/hatbox; the boxes guest is left as it is"
elif ! guest_up "$BOXES"; then
  warn "the boxes guest ($(guest_label "$BOXES")) is not running or can't be reached; deploying without it"
else
  : "${BOXES_IP:?}"
  # The boxes agent, laid out like desktop-agent's archive: it imports shared's sub-paths.
  mkdir -p "$tmp/hatbox/node_modules/@hatbot/shared"
  tar -C "$tmp/hatbox" -xf "$tmp/app.tar" --strip-components=2 apps/hatbox
  tar -C "$tmp/hatbox/node_modules/@hatbot/shared" -xf "$tmp/app.tar" --strip-components=2 \
    packages/shared/package.json packages/shared/src
  [[ -z $src_sha ]] || echo "$src_sha" >"$tmp/hatbox/VERSION"
  tar -C "$tmp/hatbox" -cf "$tmp/hatbox.tar" .
  guest_push "$BOXES" "$tmp/hatbox.tar" /root/hatbox-agent.tar 600
  script=$(release_script boxes boxes-deploy.sh)
  guest_push "$BOXES" "$script" /root/boxes-deploy.sh 700
  if ! guest_exec "$BOXES" env BOXES_IP="$BOXES_IP" bash /root/boxes-deploy.sh /root/hatbox-agent.tar; then
    warn "the boxes agent failed to install; the brain is deployed anyway, but boxes' backends won't run"
  fi
fi

guest_push "$BRAIN" "$tmp/app.tar" /root/hatbot-app.tar 600
guest_push "$BRAIN" "$HERE/brain-deploy.sh" /root/brain-deploy.sh 700
guest_exec "$BRAIN" env RELEASE_SUBJECT="$src_subject" bash /root/brain-deploy.sh /root/hatbot-app.tar
