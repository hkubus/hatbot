#!/usr/bin/env bash
# Hatbot: install desktop-agent inside hatbot-desktop (PLAN.md §4.2). deploy.sh pushes and runs it,
# and it installs itself as /usr/local/sbin/hatbot-desktop-agent-deploy for updates from the brain:
# desktop-agent drops an archive in its state directory, and hatbot-desktop-agent-update.path runs this.
#   $1          archive of apps/desktop-agent
#   DESKTOP_IP  this container's IP; desktop-agent listens only there
# desktop-agent has no dependencies, so nothing is installed from npm here.

set -euo pipefail
ARCHIVE=${1:?usage: desktop-deploy.sh ARCHIVE}
DESKTOP_IP=${DESKTOP_IP:?set DESKTOP_IP}
DIR=/opt/hatbot-desktop-agent
STATE=/var/lib/hatbot-desktop-agent
SELF=/usr/local/sbin/hatbot-desktop-agent-deploy
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8

say() { printf '\n-- %s\n' "$*"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [[ $ARCHIVE == "$STATE"/* ]]; then
  # desktop-agent (user desk) wrote it: read it as desk, so a planted link can't point root anywhere.
  runuser -u desk -- cat "$ARCHIVE" >"$tmp/agent.tar"
  runuser -u desk -- rm -f "$ARCHIVE"
else
  cp "$ARCHIVE" "$tmp/agent.tar"
  rm -f "$ARCHIVE"
fi

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
tar -C "$DIR.new" --no-same-owner --no-same-permissions -xf "$tmp/agent.tar"
chmod -R a+rX,go-w "$DIR.new"
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
StateDirectory=hatbot-desktop-agent
StateDirectoryMode=0700
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

# The desktop's shell (desktop_shell): its own throwaway user, a home in /var/lib/hatbot-shell, no /home
# (the browser profile), no screen, no secrets. desktop-agent reaches it on a Unix socket.
cat >/etc/systemd/system/hatbot-desktop-shell.service <<EOF
[Unit]
Description=Hatbot desktop shell: commands from desktop tasks, kept away from the browser profile

[Service]
DynamicUser=yes
StateDirectory=hatbot-shell
RuntimeDirectory=hatbot-shell
RuntimeDirectoryMode=0755
Environment=HOME=/var/lib/hatbot-shell
WorkingDirectory=/var/lib/hatbot-shell
ExecStart=/usr/local/bin/bun $DIR/src/shell.ts
Restart=always
RestartSec=2
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
TasksMax=256
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF

# Updates from the brain. Only deploy.sh runs install the installer, so an update can't change it.
if [[ $(realpath "$0") != "$SELF" ]]; then
  install -m 755 "$0" "$SELF.new"
  mv -f "$SELF.new" "$SELF"
fi
cat >/etc/systemd/system/hatbot-desktop-agent-update.path <<EOF
[Unit]
Description=Hatbot: install a desktop-agent update from the brain

[Path]
PathExists=$STATE/update.tar

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/hatbot-desktop-agent-update.service <<EOF
[Unit]
Description=Hatbot: install a desktop-agent update from the brain

[Service]
Type=oneshot
Environment=DESKTOP_IP=$DESKTOP_IP
ExecStart=$SELF $STATE/update.tar
EOF

systemctl daemon-reload
systemctl enable -q hatbot-desktop-agent hatbot-desktop-shell
systemctl enable -q --now hatbot-desktop-agent-update.path
systemctl restart hatbot-desktop-shell hatbot-desktop-agent

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
