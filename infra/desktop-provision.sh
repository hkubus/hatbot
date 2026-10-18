#!/usr/bin/env bash
# Hatbot: provision the desktop container (PLAN.md §4.2).
# Runs inside hatbot-desktop as root. host-setup.sh pushes and starts it; safe to re-run.
#   DESKTOP_IP  this container's IP; Xvnc listens only there
#   BRAIN_IP    the brain's IP; the only host allowed to connect in
#   HATBOT_PUBLIC_IPS  optional: your public IPv4s, which the desktop's programs may not reach either
#   SSH_IN      1 when it's managed over SSH (ssh-setup.sh): sshd stays reachable, except from the brain
# Reads VNC_PASSWORD from /etc/hatbot-desktop/secrets.env (written by host-setup.sh).

set -euo pipefail
BUN_VERSION=${BUN_VERSION:-1.4.2}
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8

say() { printf '\n-- %s\n' "$*"; }

# shellcheck source=/dev/null
source /etc/hatbot-desktop/secrets.env
: "${VNC_PASSWORD:?missing in /etc/hatbot-desktop/secrets.env}"
: "${DESKTOP_IP:?set DESKTOP_IP}" "${BRAIN_IP:?set BRAIN_IP}"

say "Packages (XFCE, TigerVNC, Chromium, xdotool, the fonts a desktop usually has)"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl unzip nftables \
  dbus-x11 xfce4 xfce4-terminal tigervnc-standalone-server tigervnc-tools x11-xserver-utils \
  chromium xdotool scrot fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk \
  fonts-liberation2 fonts-dejavu-core fonts-croscore \
  python3 python3-numpy python3-pandas python3-matplotlib python3-openpyxl poppler-utils jq sqlite3 \
  git >/dev/null

say "Bun $BUN_VERSION (for desktop-agent, M2)"
if [[ $(/usr/local/bin/bun --version 2>/dev/null) != "$BUN_VERSION" ]]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v$BUN_VERSION" >/dev/null
fi
/usr/local/bin/bun --version

say "desk user"
id desk >/dev/null 2>&1 || useradd --create-home --shell /bin/bash desk
home=/home/desk
install -d -o desk -g desk -m 700 "$home/.vnc" "$home/.config" "$home/.config/autostart" "$home/chrome-profile" "$home/chrome-profiles"
printf '%s\n' "$VNC_PASSWORD" | vncpasswd -f >"$home/.vnc/passwd"
chown desk:desk "$home/.vnc/passwd"
chmod 600 "$home/.vnc/passwd"
chmod 750 /etc/hatbot-desktop
chmod 600 /etc/hatbot-desktop/secrets.env

# Chromium itself is hatbot-chromium.service, which desktop-deploy.sh installs: a profile per bot.
cat >"$home/.config/autostart/hatbot-no-blanking.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Keep the screen on
Exec=sh -c 'xset s off; xset s noblank; xset -dpms'
X-GNOME-Autostart-enabled=true
EOF
chown -R desk:desk "$home/.config"

say "Display services"
cat >/etc/systemd/system/hatbot-xvnc.service <<EOF
[Unit]
Description=Hatbot desktop: Xvnc :1 (1280x800), reachable only on $DESKTOP_IP
StartLimitIntervalSec=0
After=network-online.target
Wants=network-online.target

[Service]
User=desk
ExecStart=/usr/bin/Xvnc :1 -geometry 1280x800 -depth 24 -rfbport 5901 -interface $DESKTOP_IP -rfbauth /home/desk/.vnc/passwd -SecurityTypes VncAuth -AlwaysShared -AcceptSetDesktopSize=0 -nolisten tcp -nolisten local
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/hatbot-session.service <<'EOF'
[Unit]
Description=Hatbot desktop: XFCE session on :1
StartLimitIntervalSec=0
Requires=hatbot-xvnc.service
After=hatbot-xvnc.service

[Service]
User=desk
Environment=DISPLAY=:1
Environment=XDG_RUNTIME_DIR=/run/hatbot-session
RuntimeDirectory=hatbot-session
RuntimeDirectoryMode=0700
WorkingDirectory=/home/desk
# "$$" is a literal "$" in unit files.
ExecStartPre=/bin/sh -c 'for i in $$(seq 1 20); do [ -S /tmp/.X11-unix/X1 ] && exit 0; sleep 0.5; done; exit 1'
ExecStart=/usr/bin/dbus-launch --exit-with-session /usr/bin/startxfce4
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q hatbot-xvnc hatbot-session
systemctl restart hatbot-xvnc hatbot-session

say "Firewall: only the brain may connect in (VNC 5901, desktop-agent 7070), and SSH if set up over it; the desktop's programs reach only the internet"
# On Proxmox the host also filters the desktop's bridge port (host-setup.sh), which holds even against
# root in here. Elsewhere this output chain is all there is: what browses and runs commands (desk, and
# the shell's and renderer's DynamicUsers, 61184-65519) may open connections to the internet only, not
# to the LAN, the brain, cloud metadata or your public addresses. Root's services (DNS forwarding, DHCP,
# apt) are left alone.
desk_uid=$(id -u desk)
lan_dev=$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
lan_net=$(ip -4 -o addr show dev "$lan_dev" | awk '{ print $4; exit }')
lan_net=$(python3 -c 'import ipaddress, sys; print(ipaddress.ip_interface(sys.argv[1]).network)' "$lan_net")
blocked="$lan_net, $BRAIN_IP"
for ip in ${HATBOT_PUBLIC_IPS:-}; do
  [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] || {
    echo "HATBOT_PUBLIC_IPS: $ip isn't an IPv4 address" >&2
    exit 1
  }
  blocked+=", $ip"
done
# A resolver on the LAN stays reachable, on port 53 only. One on 127.0.0.53 (systemd-resolved) forwards
# as its own user, which this doesn't filter.
dns=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ && $2 !~ /^127\./ { print $2 }' /etc/resolv.conf | paste -sd, - | sed 's/,/, /g')
dns_rule=''
[[ -z $dns ]] || dns_rule="ip daddr { $dns } meta l4proto { tcp, udp } th dport 53 accept"
ssh_rule=''
if [[ ${SSH_IN:-} == 1 ]]; then
  ports=$(/usr/sbin/sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | paste -sd, - | sed 's/,/, /g')
  ssh_rule="ip saddr != $BRAIN_IP tcp dport { ${ports:-22} } accept
    meta nfproto ipv6 tcp dport { ${ports:-22} } accept"
fi
cat >/etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
# Managed by hatbot infra/desktop-provision.sh.
flush ruleset

table inet filter {
  set blocked {
    type ipv4_addr
    flags interval
    auto-merge
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
                 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24,
                 203.0.113.0/24, 224.0.0.0/3, $blocked }
  }

  chain input {
    type filter hook input priority filter; policy drop;
    iif lo accept
    ct state established,related accept
    ip saddr $BRAIN_IP tcp dport { 5901, 7070 } accept
    $ssh_rule
    icmp type echo-request accept
  }

  chain output {
    type filter hook output priority filter; policy accept;
    oif lo accept
    ct state established,related accept
    meta skuid != { $desk_uid, 61184-65519 } accept
    meta nfproto ipv6 counter reject
    $dns_rule
    ip daddr @blocked counter reject
  }
}
EOF
systemctl enable -q nftables
systemctl restart nftables

say "Desktop provisioned"
