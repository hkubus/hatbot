#!/usr/bin/env bash
# Hatbot: install desktop-agent inside hatbot-desktop (PLAN.md §4.2). deploy.sh pushes and runs it.
#   $1          archive of apps/desktop-agent
#   DESKTOP_IP  this container's IP; desktop-agent listens only there
# desktop-agent has no dependencies, so nothing is installed from npm here.

set -euo pipefail
ARCHIVE=${1:?usage: desktop-deploy.sh ARCHIVE}
DESKTOP_IP=${DESKTOP_IP:?set DESKTOP_IP}
DIR=/opt/hatbot-desktop-agent
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8

say() { printf '\n-- %s\n' "$*"; }

say "Packages"
missing=()
for p in ffmpeg xdotool; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if ((${#missing[@]})); then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
fi
echo "ffmpeg, xdotool"

say "desktop-agent"
rm -rf "$DIR.new"
install -d -m 755 "$DIR.new"
tar -C "$DIR.new" -xf "$ARCHIVE"
rm -f "$ARCHIVE"
rm -rf "$DIR.old"
[[ -d $DIR ]] && mv "$DIR" "$DIR.old"
mv "$DIR.new" "$DIR"

cat >/etc/systemd/system/hatbot-desktop-agent.service <<EOF
[Unit]
Description=Hatbot desktop-agent: screenshots and input for the brain, on $DESKTOP_IP:7070
Requires=hatbot-xvnc.service
After=hatbot-session.service

[Service]
User=desk
Environment=DISPLAY=:1 HATBOT_AGENT_LISTEN=$DESKTOP_IP:7070
EnvironmentFile=/etc/hatbot-desktop/secrets.env
WorkingDirectory=$DIR
ExecStart=/usr/local/bin/bun src/main.ts
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q hatbot-desktop-agent
systemctl restart hatbot-desktop-agent

# shellcheck source=/dev/null
token=$(. /etc/hatbot-desktop/secrets.env && printf '%s' "$DESKTOP_AGENT_TOKEN")
for _ in $(seq 1 20); do
  if printf 'Authorization: Bearer %s\n' "$token" |
    curl -fsS -m 2 -o /dev/null -H @- "http://$DESKTOP_IP:7070/health" 2>/dev/null; then
    say "desktop-agent is up"
    exit 0
  fi
  sleep 0.5
done
journalctl -u hatbot-desktop-agent -n 30 --no-pager >&2 || true
if [[ -d $DIR.old ]]; then
  echo "desktop-agent didn't come up; going back to the previous version" >&2
  rm -rf "$DIR"
  mv "$DIR.old" "$DIR"
  systemctl restart hatbot-desktop-agent
else
  echo "desktop-agent didn't come up" >&2
fi
exit 1
