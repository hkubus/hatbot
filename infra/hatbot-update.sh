#!/usr/bin/env bash
# Hatbot: update desktop-agent and the brain from git (the Update button in Settings).
# brain-deploy.sh installs this as /usr/local/sbin/hatbot-update. It runs as root from
# hatbot-update.path when the brain writes /var/lib/hatbot/update-request, so the brain itself never
# holds the git token or root. Settings come from /etc/hatbot/update.env, which deploy.sh writes.
# Progress goes to /var/lib/hatbot-update/status.json, which the brain reads.
# The HATBOT_* paths below can be overridden to try it outside the brain.

set -euo pipefail
STATE=${HATBOT_UPDATE_STATE:-/var/lib/hatbot-update}
REQUEST=${HATBOT_UPDATE_REQUEST:-/var/lib/hatbot/update-request}
APP=${HATBOT_APP:-/var/lib/hatbot/app}
ETC=${HATBOT_ETC:-/etc/hatbot}
REPO=$STATE/repo.git
export LC_ALL=C.UTF-8

rm -f "$REQUEST"
install -d -m 755 "$STATE"
exec >"$STATE/last.log" 2>&1
chmod 644 "$STATE/last.log"

started=$(date -Is)
from='' to='' subject='' notes='[]'
status() { # status STATE STEP [ERROR]
  jq -n --arg state "$1" --arg step "$2" --arg error "${3:-}" --arg started "$started" \
    --arg from "$from" --arg to "$to" --arg subject "$subject" --argjson notes "$notes" \
    --arg finished "$([[ $1 == running ]] || date -Is)" \
    '{state: $state, step: $step, error: $error, startedAt: $started, finishedAt: $finished,
      from: $from, to: $to, subject: $subject, notes: $notes} | with_entries(select(.value != ""))' \
    >"$STATE/status.json.tmp"
  chmod 644 "$STATE/status.json.tmp"
  mv -f "$STATE/status.json.tmp" "$STATE/status.json"
  printf '\n-- %s %s\n' "$2" "${3:-}"
}
note() { notes=$(jq -c --arg n "$1" '. + [$n]' <<<"$notes"); }
fail() {
  status failed "$step" "$1"
  exit 1
}
step=Starting
trap 'fail "the update stopped unexpectedly; see $STATE/last.log on the brain"' ERR

step=Fetching
status running "$step"
# shellcheck source=/dev/null
[[ -r $ETC/update.env ]] && source "$ETC/update.env"
[[ -n ${HATBOT_GIT_URL:-} ]] || fail "updates aren't set up; run deploy.sh to set them up"
branch=${HATBOT_GIT_BRANCH:-main}
[[ -d $REPO ]] || git init -q --bare "$REPO"
# The token goes in through the environment, so it never shows up in the process list.
git_auth=()
if [[ -n ${HATBOT_GIT_TOKEN:-} ]]; then
  basic=$(printf '%s:%s' "${HATBOT_GIT_USER:-hatbot}" "$HATBOT_GIT_TOKEN" | base64 -w0)
  git_auth=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
    "GIT_CONFIG_VALUE_0=Authorization: Basic $basic")
fi
"${git_auth[@]}" git -C "$REPO" fetch -q --no-tags "$HATBOT_GIT_URL" "+refs/heads/$branch:refs/heads/$branch" ||
  fail "couldn't fetch $branch from $HATBOT_GIT_URL"
to=$(git -C "$REPO" rev-parse "refs/heads/$branch")
subject=$(git -C "$REPO" log -1 --format=%s "$to")
from=$(jq -r '.sha // empty' "$APP/release.json" 2>/dev/null || true)
echo "live: ${from:-unknown}, $branch: $to"
if [[ $from == "$to" ]]; then
  status current "Up to date"
  exit 0
fi

# This runs the fetched commit's brain-deploy.sh as root. With HATBOT_UPDATE_SIGNERS (an ssh
# allowed_signers file) set in update.env, only a commit signed by one of its keys is deployed.
if [[ -n ${HATBOT_UPDATE_SIGNERS:-} ]]; then
  [[ -r $HATBOT_UPDATE_SIGNERS ]] || fail "can't read HATBOT_UPDATE_SIGNERS ($HATBOT_UPDATE_SIGNERS)"
  git -C "$REPO" -c gpg.ssh.allowedSignersFile="$HATBOT_UPDATE_SIGNERS" verify-commit "$to" ||
    fail "${to:0:7} isn't signed by a key in $HATBOT_UPDATE_SIGNERS, so it wasn't deployed"
  # Only forward: whoever can push could move the branch back to an older signed commit, from before
  # a fix. The fetch takes a forced push, so the live commit has to be in the new one's history. A live
  # commit this repo hasn't seen isn't in it either (merge-base exits 128), so that's refused too.
  if [[ -n $from ]] && ! git -C "$REPO" merge-base --is-ancestor "$from" "$to" 2>/dev/null; then
    fail "$branch moved back or was rewritten: ${to:0:7} doesn't come after the live ${from:0:7}, so it wasn't deployed. To deploy it anyway, run deploy.sh"
  fi
fi

# Host-side scripts only change through deploy.sh, host-setup.sh or ssh-setup.sh.
if [[ -n $from ]] && git -C "$REPO" cat-file -e "$from^{commit}" 2>/dev/null; then
  changed=$(git -C "$REPO" diff --name-only "$from" "$to" -- infra \
    ':!infra/brain-deploy.sh' ':!infra/hatbot-update.sh' ':!infra/README.md' | xargs -r -n1 basename | paste -sd, -)
  [[ -z $changed ]] || note "Host scripts changed ($changed); run deploy.sh again to apply them."
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -C "$REPO" archive --format=tar "$to" >"$tmp/app.tar"
# The brain first: if it fails and goes back to the old version, the desktop hasn't changed either.
# A new brain copes with the old desktop-agent for the minute until it's updated.
step="Updating the brain"
status running "$step"
# The new release's own deploy script, so changes to it apply too. It restarts the brain, rolls
# back if the new one fails its health check, and installs the new version of this script.
tar -C "$tmp" -xf "$tmp/app.tar" infra/brain-deploy.sh
RELEASE_SUBJECT=$subject bash "${HATBOT_BRAIN_DEPLOY:-$tmp/infra/brain-deploy.sh}" "$tmp/app.tar" ||
  fail "the new version didn't start, so the brain stayed on the old one and the desktop wasn't updated"

step="Updating the desktop"
status running "$step"
# shellcheck source=/dev/null
if [[ -r $ETC/desktop.env ]] && source "$ETC/desktop.env" && [[ -n ${DESKTOP_AGENT_URL:-} ]]; then
  # desktop-agent, with packages/shared copied where the workspace links it: it imports shared's keys.ts.
  mkdir -p "$tmp/agent/node_modules/@hatbot/shared"
  git -C "$REPO" archive "$to" apps/desktop-agent | tar -C "$tmp/agent" -xf - --strip-components=2
  git -C "$REPO" archive "$to" packages/shared/package.json packages/shared/src |
    tar -C "$tmp/agent/node_modules/@hatbot/shared" -xf - --strip-components=2
  echo "$to" >"$tmp/agent/VERSION"
  tar -C "$tmp/agent" -cf "$tmp/agent.tar" .
  agent() { printf 'Authorization: Bearer %s\n' "$DESKTOP_AGENT_TOKEN" | curl -sS -m 30 -H @- "$@"; }
  code=$(agent -o "$tmp/agent.out" -w '%{http_code}' --data-binary @"$tmp/agent.tar" \
    -H 'content-type: application/x-tar' "$DESKTOP_AGENT_URL/update" || true)
  case $code in
    202)
      updated=0
      for _ in $(seq 1 60); do
        sleep 2
        if [[ $(agent -m 3 "$DESKTOP_AGENT_URL/health" 2>/dev/null | jq -r '.version // empty' 2>/dev/null) == "$to" ]]; then
          updated=1
          break
        fi
      done
      ((updated)) || note "desktop-agent didn't come back on the new version; it keeps the old one. See journalctl -u hatbot-desktop-agent-update on the desktop."
      ;;
    404 | 501)
      note "desktop-agent can't update itself yet; run deploy.sh once."
      ;;
    *)
      note "desktop-agent refused the update ($code: $(head -c 200 "$tmp/agent.out" 2>/dev/null))."
      ;;
  esac
else
  note "The desktop isn't set up; only the brain was updated."
fi

trap - ERR
status "done" "Updated"
