#!/usr/bin/env bash
# Hatbot: provision the brain container (PLAN.md §4.1, §7, §9).
# Runs inside the brain as root. host-setup.sh or ssh-setup.sh pushes and starts it; safe to re-run.
# The app and its service unit come later, from deploy.sh.
#   DESKTOP_IP     the desktop's IP; it may not open connections to the brain (empty: no desktop)
#   BOXES_IP       the boxes guest's IP; the same (empty: no boxes guest)

set -euo pipefail
DESKTOP_IP=${DESKTOP_IP:-}
BOXES_IP=${BOXES_IP:-}
BUN_VERSION=${BUN_VERSION:-1.4.2}
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8

say() { printf '\n-- %s\n' "$*"; }

say "Packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git gnupg jq nftables openssh-client openssl sqlite3 unzip >/dev/null

say "Bun $BUN_VERSION"
if [[ $(/usr/local/bin/bun --version 2>/dev/null) != "$BUN_VERSION" ]]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v$BUN_VERSION" >/dev/null
fi
/usr/local/bin/bun --version

say "hatbot user and directories"
id hatbot >/dev/null 2>&1 ||
  useradd --system --create-home --home-dir /var/lib/hatbot --shell /usr/sbin/nologin hatbot
install -d -o hatbot -g hatbot -m 750 /var/lib/hatbot /var/lib/hatbot/app /var/lib/hatbot/memory
install -d -o hatbot -g hatbot -m 750 /archive /archive/screens /archive/transcripts
install -d -o root -g hatbot -m 750 /etc/hatbot
# MCP servers' secrets: the brain reads the names here, and hands a server only those.
[[ -e /etc/hatbot/mcp.env ]] || install -o root -g hatbot -m 640 /dev/null /etc/hatbot/mcp.env
find /etc/hatbot -maxdepth 1 -name '*.env' -exec chown root:hatbot {} + -exec chmod 640 {} +

say "Memory repo (/var/lib/hatbot/memory, never pushed anywhere)"
mem=/var/lib/hatbot/memory
as_hatbot() { runuser -u hatbot -- "$@"; }
if [[ ! -d $mem/.git ]]; then
  as_hatbot git -C "$mem" init -q -b main
  as_hatbot git -C "$mem" config user.name Hatbot
  as_hatbot git -C "$mem" config user.email hatbot@local
  as_hatbot mkdir -p "$mem/projects" "$mem/skills" "$mem/journal"
  as_hatbot touch "$mem/projects/.gitkeep" "$mem/skills/.gitkeep" "$mem/journal/.gitkeep"
  as_hatbot tee "$mem/INDEX.md" >/dev/null <<'EOF'
# Memory index

Always in context. One line per file or folder: what it holds. Keep it current.

- about-you.md: facts about you
- preferences.md: how you like things done
- homelab.md: hosts, services, what healthy looks like, runbooks
- projects/: one file per project
- skills/: reusable procedures
- journal/: notable events, one file per month
EOF
  for f in about-you preferences homelab; do
    title=$(sed 's/-/ /; s/^./\U&/' <<<"$f")
    printf '# %s\n' "$title" | as_hatbot tee "$mem/$f.md" >/dev/null
  done
  as_hatbot git -C "$mem" add -A
  as_hatbot git -C "$mem" commit -q -m "Start memory"
fi
as_hatbot git -C "$mem" log --oneline -1

say "SSH key for managing hosts (M4)"
if [[ ! -f /var/lib/hatbot/.ssh/id_ed25519 ]]; then
  install -d -o hatbot -g hatbot -m 700 /var/lib/hatbot/.ssh
  as_hatbot ssh-keygen -q -t ed25519 -N '' -C hatbot@hatbot-brain -f /var/lib/hatbot/.ssh/id_ed25519
fi
cat /var/lib/hatbot/.ssh/id_ed25519.pub

say "Firewall: the desktop and the boxes guest may only answer, never connect in"
desktop_rule='' boxes_rule=''
[[ -z $DESKTOP_IP ]] || desktop_rule="ip saddr $DESKTOP_IP ct state new counter drop"
[[ -z $BOXES_IP ]] || boxes_rule="ip saddr $BOXES_IP ct state new counter drop"
cat >/etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
# Managed by hatbot infra/brain-provision.sh.
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority filter; policy accept;
    $desktop_rule
    $boxes_rule
  }
}
EOF
systemctl enable -q nftables
systemctl restart nftables

say "Brain provisioned"
