#!/usr/bin/env bash
# Hatbot: let it run commands inside your containers (the SSH plugin's ssh_pct_exec).
# Run as root on the Proxmox host after host-setup.sh. Safe to re-run. It sets up:
#   - a `hatbot` Unix user here that logs in with the brain's SSH key,
#   - the "hatbot" tag on Hatbot's own brain and desktop (host-setup.sh tags them when it creates
#     them; older ones get it here),
#   - /usr/local/sbin/hatbot-pct-exec, which runs one command in one running container and refuses
#     Hatbot's own: any container tagged "hatbot", and the brain's and desktop's IDs as of now,
#   - a sudo rule for that program and nothing else.
# Then add this host in Settings → Plugins → SSH with "Proxmox host" switched on.

set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"
# shellcheck source=/dev/null
source /etc/hatbot/host.env 2>/dev/null || die "/etc/hatbot/host.env not found; run host-setup.sh first"
[[ ${HATBOT_TRANSPORT:-pct} == pct ]] || die "Hatbot wasn't set up by host-setup.sh; this is for Proxmox installs"
: "${BRAIN_ID:?}" "${DESKTOP_ID:?}"
[[ $EUID -eq 0 ]] || die "run as root"
command -v pct >/dev/null || die "pct not found: run this on the Proxmox host"
guest_up "$BRAIN_ID" || die "the brain (CT $BRAIN_ID) is not running"

WRAPPER=/usr/local/sbin/hatbot-pct-exec
SUDOERS=/etc/sudoers.d/hatbot-pct-exec

step "1/4 hatbot user"
id hatbot >/dev/null 2>&1 || useradd --create-home --shell /bin/bash hatbot
key=$(pct exec "$BRAIN_ID" -- cat /var/lib/hatbot/.ssh/id_ed25519.pub) ||
  die "no SSH key in the brain; run brain-provision.sh"
install -d -o hatbot -g hatbot -m 700 /home/hatbot/.ssh
printf '%s\n' "$key" >/home/hatbot/.ssh/authorized_keys
chown hatbot:hatbot /home/hatbot/.ssh/authorized_keys
chmod 600 /home/hatbot/.ssh/authorized_keys
ok "hatbot logs in with ${key##* }"

# The wrapper refuses by this tag, so a brain or desktop made again under another ID stays refused.
# The brain's token can't change tags (that needs VM.Config.Options).
step "2/4 the hatbot tag"
for ct in "$BRAIN_ID" "$DESKTOP_ID"; do
  if ! tags=$(pct config "$ct" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p'); then
    warn "CT $ct not found; not tagged"
    continue
  fi
  if [[ ";${tags//[, ]/;};" == *";hatbot;"* ]]; then
    ok "CT $ct is tagged hatbot"
  else
    pct set "$ct" --tags "${tags:+$tags;}hatbot"
    ok "tagged CT $ct hatbot"
  fi
done

step "3/4 $WRAPPER"
tmp=$(mktemp)
cat >"$tmp" <<EOF
#!/bin/bash
# Installed by Hatbot's infra/pct-exec-setup.sh. Runs one command in one running container, as root
# there. Hatbot reaches it through sudo. Its own containers are refused: any tagged "hatbot", and
# $BRAIN_ID and $DESKTOP_ID, the brain's and the desktop's when this was installed.
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
conf=/etc/pve/lxc/\$id.conf
if [[ ! -f \$conf ]]; then
  echo "CT \$id isn't a container on this host." >&2
  exit 4
fi
# The tags of its current config; the [snapshot] sections after it have their own.
tags=\$(sed -n '/^\[/q; s/^tags:[[:space:]]*//p' "\$conf")
if [[ ";\${tags//[, ]/;};" == *";hatbot;"* ]]; then
  echo "CT \$id is tagged hatbot, one of Hatbot's own containers; refused." >&2
  exit 3
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
ok "refuses containers tagged hatbot, and CT $BRAIN_ID and CT $DESKTOP_ID"

step "4/4 sudo rule"
# Proxmox VE doesn't ship sudo.
if ! command -v visudo >/dev/null; then
  apt-get install -y -qq --no-install-recommends sudo >/dev/null || die "couldn't install sudo"
  ok "installed sudo"
fi
printf 'hatbot ALL=(root) NOPASSWD: %s\n' "$WRAPPER" >"$SUDOERS.new"
chmod 440 "$SUDOERS.new"
visudo -cf "$SUDOERS.new" >/dev/null || {
  rm -f "$SUDOERS.new"
  die "the sudo rule didn't parse"
}
mv "$SUDOERS.new" "$SUDOERS"
ok "hatbot may run $WRAPPER as root, nothing else"

info ""
info "Next: Settings → Plugins → SSH, add this host (user hatbot) and switch on \"Proxmox host\"."
