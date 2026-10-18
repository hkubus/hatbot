#!/usr/bin/env bash
# Hatbot: install the boxes agent (apps/hatbox) inside hatbot-boxes (PLAN.md §21.6). deploy.sh pushes and
# runs it, and it installs itself as /usr/local/sbin/hatbox-agent-deploy for updates from the brain: the
# agent drops an archive in its state directory, and hatbox-agent-update.path runs this.
#   $1        archive of apps/hatbox, with packages/shared in node_modules/@hatbot/shared
#   BOXES_IP  this guest's IP; the agent listens only there
# The agent has no dependencies from npm, so nothing is installed for it here. It installs the boxes' own
# packages itself (bun install --ignore-scripts), as its user, which is why that user reaches the internet.

set -euo pipefail
ARCHIVE=${1:?usage: boxes-deploy.sh ARCHIVE}
BOXES_IP=${BOXES_IP:?set BOXES_IP}
DIR=/opt/hatbox-agent
STATE=/var/lib/hatbox
SELF=/usr/local/sbin/hatbox-agent-deploy
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8

say() { printf '\n-- %s\n' "$*"; }

id hatbox >/dev/null 2>&1 || {
  echo "there's no hatbox user; run boxes-provision.sh first (host-setup.sh or ssh-setup.sh does)" >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [[ $ARCHIVE == "$STATE"/* ]]; then
  # The agent (user hatbox) wrote it: read it as hatbox, so a planted link can't point root anywhere.
  runuser -u hatbox -- cat "$ARCHIVE" >"$tmp/agent.tar"
  runuser -u hatbox -- rm -f "$ARCHIVE"
else
  cp "$ARCHIVE" "$tmp/agent.tar"
  rm -f "$ARCHIVE"
fi

say "Packages"
missing=()
for p in dbus polkitd; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if ((${#missing[@]})); then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
fi
echo "dbus, polkitd"

say "The boxes agent"
# An archive from an update was handed in by the agent (hatbox), and becomes root-owned files here, so it
# may hold only plain files and directories: no links, devices, set-id or sticky bits, and no paths out of
# the directory. Then nothing in it gives hatbox more than hatbox already has.
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

# The agent runs the boxes for the brain: it keeps their files in its state directory, installs their
# packages, and starts and stops their units through systemctl, which the polkit rule below allows.
# /run/hatbox holds each box's socket directory; it outlives the agent's restarts, as running boxes do.
cat >/etc/systemd/system/hatbox-agent.service <<EOF
[Unit]
Description=Hatbot boxes agent: runs the boxes' backends for the brain, on $BOXES_IP:7071
# Restart=always means always: no giving up after five quick failures.
StartLimitIntervalSec=0
After=network-online.target
Wants=network-online.target

[Service]
User=hatbox
Environment=HATBOX_LISTEN=$BOXES_IP:7071
EnvironmentFile=/etc/hatbox/secrets.env
StateDirectory=hatbox
StateDirectoryMode=0755
RuntimeDirectory=hatbox
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
WorkingDirectory=$DIR
ExecStart=/usr/local/bin/bun src/main.ts
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/hatbox.slice <<'EOF'
[Unit]
Description=Hatbot's boxes: their backends and builds, 384 MB for all of them

[Slice]
MemoryMax=384M
TasksMax=512
CPUQuota=150%
EOF

# A box's backend, started on its first request and stopped after 15 idle minutes, both by the agent; no
# [Install]. A user of its own, no network (it reaches the agent through its socket directory, and the
# internet only through the agent), its data in a state directory only it can enter, and of the agent's
# files only its own app, read-only. Its secrets it asks of the agent through that socket as it starts,
# so only this unit gets them: LoadCredential= would have PID 1 read, as root, a file the agent's user
# wrote, and SetCredential= means writing units.
cat >/etc/systemd/system/hatbox@.service <<'EOF'
[Unit]
Description=Hatbot box %i
StartLimitIntervalSec=0

[Service]
Slice=hatbox.slice
DynamicUser=yes
User=hatbox-box-%i
StateDirectory=hatbox-data/%i
StateDirectoryMode=0700
WorkingDirectory=/var/lib/hatbox-data/%i
Environment=HOME=/tmp HATBOX_ID=%i HATBOX_APP=/var/lib/hatbox/boxes/%i/app/server.js HATBOX_SOCKETS=/run/hatbox/%i
# The box's own user opens its log. A StandardOutput= file is opened by PID 1, as root, following any
# link the agent's user could have put there.
ExecStart=/bin/sh -c 'exec /usr/local/bin/bun /opt/hatbox-agent/src/runner.ts >>/var/lib/hatbox/logs/%i.log 2>&1'
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX
# /dev/shm too: PrivateDevices= brings the guest's, which every box would share.
TemporaryFileSystem=/var/lib/hatbox:ro /run/hatbox:ro /dev/shm
BindReadOnlyPaths=/var/lib/hatbox/boxes/%i/app
BindPaths=/run/hatbox/%i /var/lib/hatbox/logs/%i.log
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateIPC=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
MemoryMax=128M
TasksMax=64
TimeoutStopSec=5
OOMScoreAdjust=500
EOF

# A throwaway build: bun build, after the agent ran bun install --ignore-scripts into src/. Macros run code
# at build time, so it gets a user of its own, no network, and of the agent's files only its build folder.
# /run/hatbox is hidden too: the boxes' sockets are there.
cat >/etc/systemd/system/hatbox-build@.service <<'EOF'
[Unit]
Description=Hatbot box %i: a build
StartLimitIntervalSec=0

[Service]
Type=oneshot
Slice=hatbox.slice
DynamicUser=yes
User=hatbox-build-%i
Environment=HOME=/tmp
WorkingDirectory=/var/lib/hatbox/build/%i
# Its own user writes build.log, as hatbox@ does its log.
ExecStart=/bin/sh -c 'exec /usr/local/bin/bun /opt/hatbox-agent/src/build.ts >build.log 2>&1'
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX
TemporaryFileSystem=/var/lib/hatbox:ro /run/hatbox:ro /dev/shm
BindPaths=/var/lib/hatbox/build/%i
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateIPC=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
MemoryMax=256M
TasksMax=64
TimeoutStartSec=120
EOF

# The agent's user may start, stop and clean (delete the data of) boxes' backends, and start and stop
# their builds. Nothing else of systemd's: no other units, no unit files, no reloads.
cat >"$tmp/50-hatbox.rules" <<'EOF'
// Managed by hatbot infra/boxes-deploy.sh.
polkit.addRule(function (action, subject) {
  if (subject.user !== "hatbox" || action.id.indexOf("org.freedesktop.systemd1.") !== 0) {
    return polkit.Result.NOT_HANDLED;
  }
  if (action.id === "org.freedesktop.systemd1.manage-units") {
    var unit = action.lookup("unit") || "";
    var verb = action.lookup("verb") || "";
    if (/^hatbox@[0-9]+\.service$/.test(unit) && ["start", "stop", "clean"].indexOf(verb) >= 0) {
      return polkit.Result.YES;
    }
    if (/^hatbox-build@[0-9]+\.service$/.test(unit) && ["start", "stop"].indexOf(verb) >= 0) {
      return polkit.Result.YES;
    }
  }
  return polkit.Result.NO;
});
EOF
install -m 644 "$tmp/50-hatbox.rules" /etc/polkit-1/rules.d/50-hatbox.rules
# polkitd watches its rules, but a restart makes sure this one is loaded before the agent asks.
systemctl try-restart polkit.service

# Updates from the brain. Only deploy.sh runs install the installer, so an update can't change it.
if [[ $(realpath "$0") != "$SELF" ]]; then
  install -m 755 "$0" "$SELF.new"
  mv -f "$SELF.new" "$SELF"
fi
cat >/etc/systemd/system/hatbox-agent-update.path <<EOF
[Unit]
Description=Hatbot: install a boxes agent update from the brain

[Path]
PathExists=$STATE/update.tar

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/hatbox-agent-update.service <<EOF
[Unit]
Description=Hatbot: install a boxes agent update from the brain

[Service]
Type=oneshot
Environment=BOXES_IP=$BOXES_IP
ExecStart=$SELF $STATE/update.tar
EOF

systemctl daemon-reload
systemctl enable -q hatbox-agent
systemctl enable -q --now hatbox-agent-update.path
# Running boxes run the old runner.ts; stopped, they start again on the new one at their next request.
systemctl stop 'hatbox@*.service' || true
systemctl restart hatbox-agent

# shellcheck source=/dev/null
token=$(. /etc/hatbox/secrets.env && printf '%s' "$HATBOX_AGENT_TOKEN")
health=''
for _ in $(seq 1 60); do
  health=$(printf 'Authorization: Bearer %s\n' "$token" |
    curl -fsS -m 5 -H @- "http://$BOXES_IP:7071/health" 2>/dev/null || true)
  if grep -q '"ok":true' <<<"$health"; then
    say "The boxes agent is up"
    exit 0
  fi
  sleep 0.5
done
journalctl -u hatbox-agent -n 30 --no-pager >&2 || true
if [[ -d $DIR.old ]]; then
  echo "the boxes agent didn't come up; going back to the previous version" >&2
  rm -rf "$DIR"
  mv "$DIR.old" "$DIR"
  systemctl restart hatbox-agent
else
  echo "the boxes agent didn't come up" >&2
fi
exit 1
