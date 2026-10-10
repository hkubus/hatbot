#!/usr/bin/env bash
# Hatbot: let it run commands inside your containers (the SSH plugin's ssh_pct_exec).
# Run as root on the Proxmox host after host-setup.sh. Safe to re-run. It sets up:
#   - a `hatbot` Unix user here that logs in with the brain's SSH key,
#   - /usr/local/sbin/hatbot-pct-exec, which runs one command in one running container and refuses
#     Hatbot's own brain and desktop,
#   - a sudo rule for that program and nothing else.
# Then add this host in Settings → Plugins → SSH with "Proxmox host" switched on.

set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"
# shellcheck source=/dev/null
source /etc/hatbot/host.env 2>/dev/null || die "/etc/hatbot/host.env not found; run host-setup.sh first"
: "${BRAIN_ID:?}" "${DESKTOP_ID:?}"
[[ $EUID -eq 0 ]] || die "run as root"
command -v pct >/dev/null || die "pct not found: run this on the Proxmox host"
ct_running "$BRAIN_ID" || die "the brain (CT $BRAIN_ID) is not running"

WRAPPER=/usr/local/sbin/hatbot-pct-exec
SUDOERS=/etc/sudoers.d/hatbot-pct-exec

step "1/3 hatbot user"
id hatbot >/dev/null 2>&1 || useradd --create-home --shell /bin/bash hatbot
key=$(pct exec "$BRAIN_ID" -- cat /var/lib/hatbot/.ssh/id_ed25519.pub) ||
  die "no SSH key in the brain; run brain-provision.sh"
install -d -o hatbot -g hatbot -m 700 /home/hatbot/.ssh
printf '%s\n' "$key" >/home/hatbot/.ssh/authorized_keys
chown hatbot:hatbot /home/hatbot/.ssh/authorized_keys
chmod 600 /home/hatbot/.ssh/authorized_keys
ok "hatbot logs in with ${key##* }"

step "2/3 $WRAPPER"
tmp=$(mktemp)
cat >"$tmp" <<EOF
#!/bin/bash
# Installed by Hatbot's infra/pct-exec-setup.sh. Runs one command in one running container, as root
# there. Hatbot reaches it through sudo; its own containers ($BRAIN_ID, $DESKTOP_ID) are refused.
set -euo pipefail
if [[ \$# -ne 2 || ! \$1 =~ ^[0-9]{3,9}\$ ]]; then
  echo "usage: hatbot-pct-exec <container id> <command>" >&2
  exit 2
fi
id=\$1
case "\$id" in
  $BRAIN_ID | $DESKTOP_ID)
    echo "CT \$id is one of Hatbot's own containers; refused." >&2
    exit 3
    ;;
esac
if [[ ! -f /etc/pve/lxc/\$id.conf ]]; then
  echo "CT \$id isn't a container on this host." >&2
  exit 4
fi
if ! pct status "\$id" | grep -q 'status: running'; then
  echo "CT \$id isn't running." >&2
  exit 5
fi
exec pct exec "\$id" -- /bin/sh -c "\$2"
EOF
bash -n "$tmp"
install -o root -g root -m 755 "$tmp" "$WRAPPER"
rm -f "$tmp"
ok "refuses CT $BRAIN_ID and CT $DESKTOP_ID"

step "3/3 sudo rule"
printf 'hatbot ALL=(root) NOPASSWD: %s\n' "$WRAPPER" >"$SUDOERS.new"
chmod 440 "$SUDOERS.new"
visudo -cqf "$SUDOERS.new" || die "the sudo rule didn't parse"
mv "$SUDOERS.new" "$SUDOERS"
ok "hatbot may run $WRAPPER as root, nothing else"

info ""
info "Next: Settings → Plugins → SSH, add this host (user hatbot) and switch on \"Proxmox host\"."
