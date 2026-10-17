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
# An archive from an update was handed in by desktop-agent (desk), and becomes root-owned files here, so
# it may hold only plain files and directories: no links, devices, set-id or sticky bits, and no paths
# out of the directory. Then nothing in it gives desk more than desk already has.
if ! listing=$(tar -tvf "$tmp/agent.tar") || ! names=$(tar -tf "$tmp/agent.tar") ||
  grep -qvE '^[-d][rwx-]{9} ' <<<"$listing" || grep -qE '^/|(^|/)\.\.(/|$)' <<<"$names"; then
  echo "the archive holds something besides plain files and directories; not installed" >&2
  exit 1
fi
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
# Restart=always means always: no giving up after five quick failures.
StartLimitIntervalSec=0
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

# The shell's and the renderer's DynamicUsers (systemd gives them UIDs from 61184-65519) get no TCP on
# loopback or this container's own address: Chromium's DevTools port (127.0.0.1:9222) has no
# authentication and would hand over the browser's logins. systemd's IPAddressDeny= below needs BPF,
# which an unprivileged container may not have, so nftables does it. Loaded after nftables.service, whose
# 'flush ruleset' drops it, and again on its restarts.
install -d -m 750 /etc/hatbot-desktop
cat >/etc/hatbot-desktop/shell.nft <<'EOF'
#!/usr/sbin/nft -f
# Managed by hatbot infra/desktop-deploy.sh.
table inet hatbot_shell
delete table inet hatbot_shell

table inet hatbot_shell {
  chain output {
    type filter hook output priority filter; policy accept;
    oif lo meta skuid 61184-65519 meta l4proto tcp counter reject with tcp reset
  }
}
EOF
# No ExecStop: stopping it must not open loopback up.
cat >/etc/systemd/system/hatbot-shell-firewall.service <<'EOF'
[Unit]
Description=Hatbot: keep the desktop shell and the renderer off loopback (Chromium's DevTools)
After=nftables.service
PartOf=nftables.service
Before=hatbot-desktop-shell.service hatbot-render.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/hatbot-desktop/shell.nft

[Install]
WantedBy=multi-user.target nftables.service
EOF

# The desktop's shell (desktop_shell): its own throwaway user, a home in /var/lib/hatbot-shell, no /home
# (the browser profile), no screen, no secrets. desktop-agent reaches it on a Unix socket, in a directory
# only desk may enter, so the renderer can't. systemd sets the directory's group back to the unit's own
# when ExecStart runs, so desk gets it after. PrivateIPC: the screen grabs' X shared memory (MIT-SHM, which
# ffmpeg makes readable by every user) is out of its reach, and the renderer's.
cat >/etc/systemd/system/hatbot-desktop-shell.service <<EOF
[Unit]
Description=Hatbot desktop shell: commands from desktop tasks, kept away from the browser profile
StartLimitIntervalSec=0
Requires=hatbot-shell-firewall.service
After=hatbot-shell-firewall.service

[Service]
DynamicUser=yes
StateDirectory=hatbot-shell
RuntimeDirectory=hatbot-shell
RuntimeDirectoryMode=0750
Environment=HOME=/var/lib/hatbot-shell
WorkingDirectory=/var/lib/hatbot-shell
ExecStart=/usr/local/bin/bun $DIR/src/shell.ts
ExecStartPost=+/usr/bin/chgrp desk /run/hatbot-shell
Restart=always
RestartSec=2
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateIPC=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=localhost $DESKTOP_IP
TasksMax=256
MemoryHigh=600M
MemoryMax=1G
# Under memory pressure the kernel kills a runaway command before Chromium or desktop-agent.
OOMScoreAdjust=500

[Install]
WantedBy=multi-user.target
EOF

# The renderer, for watchers that run a page's scripts (src/render.ts): a headless Chromium per page, with
# a throwaway profile, as its own throwaway user like the shell. No /home (the bots' profiles), no screen,
# no DevTools port, and a socket only desk reaches, like the shell's. Chromium's own sandbox works under
# it. getifaddrs, which it uses to know the desktop's addresses, needs netlink. The desktop has 1.5 GB and
# the bots' Chromium has no cap, so this one does.
cat >/etc/systemd/system/hatbot-render.service <<EOF
[Unit]
Description=Hatbot renderer: pages for watchers, in a headless Chromium of its own
StartLimitIntervalSec=0
Requires=hatbot-shell-firewall.service
After=hatbot-shell-firewall.service

[Service]
DynamicUser=yes
RuntimeDirectory=hatbot-render
RuntimeDirectoryMode=0750
Environment=HOME=/tmp
ExecStart=/usr/local/bin/bun $DIR/src/render.ts
ExecStartPost=+/usr/bin/chgrp desk /run/hatbot-render
Restart=always
RestartSec=2
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateIPC=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
IPAddressDeny=localhost $DESKTOP_IP
TasksMax=512
MemoryMax=500M
OOMScoreAdjust=500

[Install]
WantedBy=multi-user.target
EOF

# Chromium, on the profile desktop-agent last asked for (PLAN.md §14): Hatbot's is chrome-profile, each
# other bot's chrome-profiles/<id>. desktop-agent closes it to switch; it comes straight back. Chromium
# needs a non-default profile dir for remote debugging; CDP stays on localhost for desktop-agent.
cat >/usr/local/bin/hatbot-chromium <<'EOF'
#!/bin/sh
want=$(cat /var/lib/hatbot-desktop-agent/browser-profile 2>/dev/null)
case $want in
  [a-z]*) case $want in *[!a-z0-9-]*) want=hatbot ;; esac ;;
  *) want=hatbot ;;
esac
if [ "$want" = hatbot ]; then dir=/home/desk/chrome-profile; else dir=/home/desk/chrome-profiles/$want; fi
mkdir -p -m 700 "$dir"
printf '%s\n' "$want" >/run/hatbot-chromium/profile
exec chromium --user-data-dir="$dir" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check --password-store=basic --start-maximized
EOF
chmod 755 /usr/local/bin/hatbot-chromium
cat >/etc/systemd/system/hatbot-chromium.service <<'EOF'
[Unit]
Description=Hatbot desktop: Chromium, on the profile of the bot using it
StartLimitIntervalSec=0
Requires=hatbot-xvnc.service
After=hatbot-session.service

[Service]
User=desk
Environment=DISPLAY=:1
RuntimeDirectory=hatbot-chromium
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
WorkingDirectory=/home/desk
ExecStart=/usr/local/bin/hatbot-chromium
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF
install -d -o desk -g desk -m 700 /home/desk/chrome-profiles
# Before the service, the XFCE session started Chromium itself.
if [[ -e /home/desk/.config/autostart/hatbot-chromium.desktop ]]; then
  rm -f /home/desk/.config/autostart/hatbot-chromium.desktop
  pkill -u desk -f -- '--user-data-dir=/home/desk/chrome-profile' || true
  sleep 2
fi

# Xvnc's abstract socket (@/tmp/.X11-unix/X1) is shared by everything in the container's network
# namespace, so the shell or the renderer could reach the screen through it; their PrivateTmp already
# hides the file socket, which desktop-agent, the session and Chromium use. Provisions before this lack -nolisten local.
xvnc=/etc/systemd/system/hatbot-xvnc.service
restart_x=0
if [[ -f $xvnc ]] && ! grep -q -- '-nolisten local' "$xvnc"; then
  sed -i 's/ -nolisten tcp$/ -nolisten tcp -nolisten local/' "$xvnc"
  restart_x=1
fi

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
systemctl enable -q hatbot-shell-firewall
systemctl restart hatbot-shell-firewall
if ((restart_x)); then systemctl restart hatbot-xvnc; fi
systemctl enable -q hatbot-desktop-agent hatbot-desktop-shell hatbot-render
systemctl enable -q --now hatbot-chromium
systemctl enable -q --now hatbot-desktop-agent-update.path
systemctl restart hatbot-desktop-shell hatbot-render hatbot-desktop-agent

# shellcheck source=/dev/null
token=$(. /etc/hatbot-desktop/secrets.env && printf '%s' "$DESKTOP_AGENT_TOKEN")
# The deep check grabs a frame and asks Chromium's DevTools. desktop-agent waits for the display before it
# answers, so a restarted Xvnc takes a few seconds.
health=''
for _ in $(seq 1 60); do
  health=$(printf 'Authorization: Bearer %s\n' "$token" |
    curl -fsS -m 5 -H @- "http://$DESKTOP_IP:7070/health?deep=1" 2>/dev/null || true)
  if grep -q '"ok":true' <<<"$health"; then
    say "desktop-agent is up"
    exit 0
  fi
  sleep 0.5
done
# Chromium not answering isn't desktop-agent's fault; keep the new version.
if grep -q '"x":true' <<<"$health"; then
  say "desktop-agent is up, but Chromium's DevTools isn't answering (journalctl -u hatbot-chromium)"
  exit 0
fi
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
