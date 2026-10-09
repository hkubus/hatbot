#!/usr/bin/env bash
# Hatbot: install a release of the app inside hatbot-brain (PLAN.md §9.4). deploy.sh pushes and runs it.
#   $1  archive made with `git archive HEAD`
# Releases live in /var/lib/hatbot/releases; /var/lib/hatbot/app links to the live one.

set -euo pipefail
ARCHIVE=${1:?usage: brain-deploy.sh ARCHIVE}
ROOT=/var/lib/hatbot
KEEP=3
export LC_ALL=C.UTF-8

say() { printf '\n-- %s\n' "$*"; }
as_hatbot() { runuser -u hatbot -- env HOME=$ROOT PATH=/usr/local/bin:/usr/bin:/bin "$@"; }

say "Unpack"
sha=$(git get-tar-commit-id <"$ARCHIVE" 2>/dev/null | cut -c1-7 || true)
rel=$ROOT/releases/$(date +%Y%m%d-%H%M%S)${sha:+-$sha}
install -d -o hatbot -g hatbot -m 750 "$ROOT/releases"
install -d -m 750 "$rel"
tar -C "$rel" -xf "$ARCHIVE"
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
After=network-online.target ntfy.service
Wants=network-online.target

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
EnvironmentFile=-/etc/hatbot/ntfy.env
ExecStart=/usr/local/bin/bun src/main.ts
Restart=on-failure
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
switch_to "$rel"
if ! healthy; then
  journalctl -u hatbot-brain --since "$started" -n 40 --no-pager >&2 || true
  if [[ -n $previous ]]; then
    echo "the new release failed its health check; going back to $previous" >&2
    switch_to "$previous"
  fi
  exit 1
fi
echo "live: $rel"

# Prune old releases, never the live one or the one before it.
find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort | head -n -"$KEEP" | while read -r d; do
  [[ $d == "$rel" || $d == "$previous" ]] || rm -rf "$d"
done

code=$(journalctl -u hatbot-brain --since "$started" --no-pager -o cat | grep -o 'setup code [0-9A-Za-z-]*' | tail -1 || true)
if [[ -n $code ]]; then
  say "First run"
  echo "Open the web app's /setup page and enter $code"
fi
say "Deployed"
