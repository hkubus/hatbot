#!/usr/bin/env bash
# Hatbot: install a release of the app inside hatbot-brain. deploy.sh pushes and runs it.
#   $1  archive made with `git archive HEAD`
# Releases live in /var/lib/hatbot/releases; /var/lib/hatbot/app links to the live one.

set -euo pipefail
ARCHIVE=${1:?usage: brain-deploy.sh ARCHIVE}
ROOT=/var/lib/hatbot
KEEP=3
export LC_ALL=C.UTF-8

say() { printf '\n-- %s\n' "$*"; }
as_hatbot() { runuser -u hatbot -- env HOME=$ROOT PATH=/usr/local/bin:/usr/bin:/bin "$@"; }

# deploy.sh on the host and the Update button (hatbot-update) both end up here; one at a time.
exec 9>/run/lock/hatbot-deploy.lock
flock -n 9 || {
  echo "another deploy is running" >&2
  exit 1
}

say "Unpack"
full_sha=$(git get-tar-commit-id <"$ARCHIVE" 2>/dev/null || true)
sha=${full_sha:0:7}
rel=$ROOT/releases/$(date +%Y%m%d-%H%M%S)${sha:+-$sha}
install -d -o hatbot -g hatbot -m 750 "$ROOT/releases"
install -d -m 750 "$rel"
tar -C "$rel" -xf "$ARCHIVE"
# What's live, for Settings and the updater. RELEASE_SUBJECT is the commit's subject line.
jq -n --arg sha "$full_sha" --arg subject "${RELEASE_SUBJECT:-}" --arg at "$(date -Is)" \
  '{sha: $sha, subject: $subject, deployedAt: $at} | with_entries(select(.value != ""))' \
  >"$rel/release.json"
chown -R hatbot:hatbot "$rel"
rm -f "$ARCHIVE"
echo "$rel"

say "Install and build"
(cd "$rel" && as_hatbot bun install --frozen-lockfile)
# --bun runs Vite on Bun; the brain has no Node.
(cd "$rel/apps/web" && as_hatbot bun --bun run build)

say "Service unit"
cat >/etc/systemd/system/hatbot-brain.service <<'EOF'
[Unit]
Description=Hatbot brain
After=network-online.target
Wants=network-online.target
# Keep restarting however often it fails, 2 s apart, instead of giving up after five.
StartLimitIntervalSec=0

[Service]
User=hatbot
Group=hatbot
WorkingDirectory=/var/lib/hatbot/app/apps/brain
Environment=HATBOT_HOST=0.0.0.0 HATBOT_PORT=8080 HATBOT_DATA_DIR=/var/lib/hatbot
Environment=HATBOT_MEMORY_DIR=/var/lib/hatbot/memory HATBOT_ARCHIVE_DIR=/archive
EnvironmentFile=/etc/hatbot/brain.env
EnvironmentFile=-/etc/hatbot/secrets.env
EnvironmentFile=-/etc/hatbot/proxmox.env
EnvironmentFile=-/etc/hatbot/desktop.env
EnvironmentFile=-/etc/hatbot/boxes.env
EnvironmentFile=-/etc/hatbot/ntfy.env
EnvironmentFile=-/etc/hatbot/forgejo.env
EnvironmentFile=-/etc/hatbot/github.env
EnvironmentFile=-/etc/hatbot/mcp.env
EnvironmentFile=-/etc/hatbot/pbs.env
EnvironmentFile=-/etc/hatbot/homeassistant.env
EnvironmentFile=-/etc/hatbot/uptimekuma.env
ExecStart=/usr/local/bin/bun src/main.ts
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/hatbot /archive

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q hatbot-brain

say "Switch"
# brain-provision.sh made app/ an empty directory; from here on it's a link.
if [[ -d $ROOT/app && ! -L $ROOT/app ]]; then
  rmdir "$ROOT/app" 2>/dev/null || mv "$ROOT/app" "$ROOT/app.before-releases"
fi
previous=$(readlink "$ROOT/app" || true)
switch_to() {
  ln -sfn "$1" "$ROOT/app.new"
  mv -T "$ROOT/app.new" "$ROOT/app"
  systemctl restart hatbot-brain
}
healthy() {
  local _
  for _ in $(seq 1 30); do
    curl -fsS -m 2 -o /dev/null http://127.0.0.1:8080/api/v1/health && return 0
    sleep 0.5
  done
  return 1
}
started=$(date '+%Y-%m-%d %H:%M:%S')
# The new release may migrate the database, which the previous one can't read; a copy from before goes
# back with it. The brain is stopped first, so nothing is written after the copy.
db=$ROOT/hatbot.sqlite
backup=''
if [[ -n $previous && -f $db ]]; then
  systemctl stop hatbot-brain
  backup=$rel/hatbot.sqlite.before
  if ! (cd "$ROOT" && as_hatbot env SRC="$db" DST="$backup" bun -e \
    'const { Database } = require("bun:sqlite"); new Database(process.env.SRC).run("VACUUM INTO ?", [process.env.DST]);'); then
    systemctl start hatbot-brain
    echo "couldn't copy the database; the brain stays on $previous" >&2
    exit 1
  fi
  chmod 600 "$backup"
  echo "database copied to $backup"
fi
switch_to "$rel"
if ! healthy; then
  journalctl -u hatbot-brain --since "$started" -n 40 --no-pager >&2 || true
  if [[ -n $previous ]]; then
    echo "the new release failed its health check; going back to $previous" >&2
    if [[ -n $backup ]]; then
      systemctl stop hatbot-brain
      as_hatbot cp "$backup" "$db.restore"
      rm -f "$db-wal" "$db-shm"
      mv -f "$db.restore" "$db"
      echo "database put back as it was before the deploy"
    fi
    switch_to "$previous"
  fi
  exit 1
fi
echo "live: $rel"

# Prune old releases, never the live one or the one before it.
find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort | head -n -"$KEEP" | while read -r d; do
  [[ $d == "$rel" || $d == "$previous" ]] || rm -rf "$d"
done

say "Updater"
# Older commits have no updater; deploying one leaves the installed updater alone.
if [[ -f $rel/infra/hatbot-update.sh ]]; then
  # The Update button in Settings: the brain writes update-request, and root runs hatbot-update.
  # Replaced with a rename, so a running hatbot-update (which runs this script) keeps its own copy.
  install -m 755 "$rel/infra/hatbot-update.sh" /usr/local/sbin/hatbot-update.new
  mv -f /usr/local/sbin/hatbot-update.new /usr/local/sbin/hatbot-update
  cat >/etc/systemd/system/hatbot-update.path <<'EOF'
[Unit]
Description=Hatbot: update from git when the brain asks

[Path]
PathExists=/var/lib/hatbot/update-request

[Install]
WantedBy=multi-user.target
EOF
  cat >/etc/systemd/system/hatbot-update.service <<'EOF'
[Unit]
Description=Hatbot: update desktop-agent and the brain from git

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hatbot-update
EOF
  systemctl daemon-reload
  systemctl enable -q --now hatbot-update.path
  install -d -m 755 /var/lib/hatbot-update
  # Where updates come from, for Settings (the token stays in update.env, which only root reads).
  if [[ -r /etc/hatbot/update.env ]]; then
    (
      # shellcheck source=/dev/null
      source /etc/hatbot/update.env
      signed=false
      [[ -z ${HATBOT_UPDATE_SIGNERS:-} ]] || signed=true
      jq -n --arg url "${HATBOT_GIT_URL:-}" --arg branch "${HATBOT_GIT_BRANCH:-main}" \
        --argjson signed "$signed" \
        '{url: $url, branch: $branch, signed: $signed} | with_entries(select(.value != ""))'
    ) >/var/lib/hatbot-update/source.json
  else
    rm -f /var/lib/hatbot-update/source.json
  fi
  chmod -f 644 /var/lib/hatbot-update/source.json || true
  echo "hatbot-update.path is watching"
fi

code=$(journalctl -u hatbot-brain --since "$started" --no-pager -o cat | grep -o 'setup code [0-9A-Za-z-]*' | tail -1 || true)
if [[ -n $code ]]; then
  say "First run"
  echo "Open the web app's /setup page and enter $code"
fi
say "Deployed"
