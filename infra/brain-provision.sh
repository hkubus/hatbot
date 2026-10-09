#!/usr/bin/env bash
# Hatbot: provision the brain container (PLAN.md §4.1, §7, §9).
# Runs inside hatbot-brain as root. host-setup.sh pushes and starts it; safe to re-run.
#   NTFY_BASE_URL  public URL of ntfy (e.g. https://ntfy.gaycats.ovh)
#   DESKTOP_IP     the desktop's private IP; it may not open connections to the brain

set -euo pipefail
NTFY_BASE_URL=${NTFY_BASE_URL:?set NTFY_BASE_URL}
DESKTOP_IP=${DESKTOP_IP:-10.77.0.20}
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

say "ntfy"
if ! command -v ntfy >/dev/null; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL -o /etc/apt/keyrings/ntfy.gpg https://archive.ntfy.sh/apt/keyring.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/ntfy.gpg] https://archive.ntfy.sh/apt stable main" \
    >/etc/apt/sources.list.d/ntfy.list
  apt-get update -qq
  apt-get install -y -qq ntfy >/dev/null
fi
install -d -o ntfy -g ntfy -m 750 /var/cache/ntfy /var/lib/ntfy
cat >/etc/ntfy/server.yml <<EOF
# Managed by hatbot infra/brain-provision.sh.
base-url: "$NTFY_BASE_URL"
listen-http: ":8081"
behind-proxy: true
cache-file: "/var/cache/ntfy/cache.db"
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"
enable-signup: false
web-root: disable
# iOS wake-ups go through ntfy.sh; only a "fetch now" ping with a hashed topic leaves this box.
upstream-base-url: "https://ntfy.sh"
EOF
systemctl enable -q ntfy
systemctl restart ntfy
for _ in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:8081/v1/health && break; sleep 0.5; done

ntfy_has_user() { ntfy user list 2>/dev/null | grep -q "^user $1 "; }
if ! ntfy_has_user hatbot; then
  NTFY_PASSWORD=$(openssl rand -hex 24) ntfy user add --role=admin hatbot >/dev/null
fi
if ! grep -qs '^NTFY_TOKEN=' /etc/hatbot/ntfy.env; then
  token=$(ntfy token add hatbot 2>&1 | grep -o 'tk_[A-Za-z0-9]*' | head -1)
  [[ -n $token ]] || { echo "could not create an ntfy token" >&2; exit 1; }
  umask 027
  printf 'NTFY_URL=http://127.0.0.1:8081\nNTFY_TOPIC=hatbot\nNTFY_TOKEN=%s\n' "$token" >/etc/hatbot/ntfy.env
  chown root:hatbot /etc/hatbot/ntfy.env
  umask 022
fi
if ! ntfy_has_user phone; then
  pw=$(openssl rand -base64 18 | tr -d '/+=')
  NTFY_PASSWORD=$pw ntfy user add phone >/dev/null
  ntfy access phone hatbot read-only >/dev/null
  (umask 077 && printf '%s\n' "$pw" >/root/ntfy-phone-password.txt)
  echo "ntfy user 'phone' created; password saved in /root/ntfy-phone-password.txt"
fi

say "Firewall: the desktop may only answer, never connect in"
cat >/etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
# Managed by hatbot infra/brain-provision.sh.
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "eth1" ip saddr $DESKTOP_IP ct state new counter drop
  }
}
EOF
systemctl enable -q nftables
systemctl restart nftables

say "Service unit (enabled in M1, once the app is deployed)"
cat >/etc/systemd/system/hatbot-brain.service <<'EOF'
[Unit]
Description=Hatbot brain
After=network-online.target ntfy.service
Wants=network-online.target

[Service]
User=hatbot
Group=hatbot
WorkingDirectory=/var/lib/hatbot/app/apps/brain
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

say "Brain provisioned"
