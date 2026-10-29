#!/usr/bin/env bash
# Hatbot: provision the boxes guest.
# Runs inside hatbot-boxes as root. host-setup.sh or ssh-setup.sh pushes and starts it; safe to re-run.
# The agent (apps/hatbox) and the boxes' units come later, from deploy.sh (boxes-deploy.sh).
#   BOXES_IP    this guest's IP; the agent listens only there
#   BRAIN_IP    the brain's IP; the only host allowed to connect in
#   HATBOT_PUBLIC_IPS  optional: your public IPv4s, which the agent may not reach either
#   SSH_IN      1 when it's managed over SSH (ssh-setup.sh): sshd stays reachable, except from the brain
# /etc/hatbox/secrets.env (the agent's token) is written by host-setup.sh or ssh-setup.sh.

set -euo pipefail
BUN_VERSION=${BUN_VERSION:-1.4.2}
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8

say() { printf '\n-- %s\n' "$*"; }

: "${BOXES_IP:?set BOXES_IP}" "${BRAIN_IP:?set BRAIN_IP}"
[[ -s /etc/hatbox/secrets.env ]] || {
  echo "/etc/hatbox/secrets.env is missing; host-setup.sh or ssh-setup.sh writes it" >&2
  exit 1
}

# The agent starts and stops the boxes' units with systemctl, as its own user: that goes over D-Bus, and
# polkit decides. A minimal container may have neither.
say "Packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl unzip nftables dbus polkitd >/dev/null

say "Bun $BUN_VERSION (for the agent and the boxes)"
if [[ $(/usr/local/bin/bun --version 2>/dev/null) != "$BUN_VERSION" ]]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v$BUN_VERSION" >/dev/null
fi
/usr/local/bin/bun --version

say "hatbox user (the agent's)"
# Its home is the agent's StateDirectory, which systemd makes when the agent starts.
id hatbox >/dev/null 2>&1 ||
  useradd --system --no-create-home --home-dir /var/lib/hatbox --shell /usr/sbin/nologin hatbox
chmod 750 /etc/hatbox
chmod 600 /etc/hatbox/secrets.env

say "Firewall: only the brain may connect in (the agent, 7071), and SSH if set up over it; only the agent reaches out, to the internet"
# On Proxmox the host also filters this guest's bridge port (host-setup.sh), which holds even against
# root in here. Elsewhere this output chain is all there is. The agent's user installs the boxes' npm
# packages and makes their fetches, so it may open connections to the internet, but not to the LAN, the
# brain, cloud metadata or your public addresses. Boxes and builds run as DynamicUsers (61184-65519) in
# network namespaces of their own; systemd skips PrivateNetwork where it can't make one, so they're
# refused here too. Root's services (apt, DNS forwarding) are left alone.
hatbox_uid=$(id -u hatbox)
lan_dev=$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
lan_net=$(ip -4 -o addr show dev "$lan_dev" | awk '{ print $4; exit }')
# Perl, not Python: perl-base is essential in Debian, so even a minimal guest has it.
lan_net=$(perl -e '
  my ($ip, $len) = split m{/}, $ARGV[0];
  my $mask = $len ? (0xffffffff << (32 - $len)) & 0xffffffff : 0;
  my $net = unpack("N", pack("C4", split /\./, $ip)) & $mask;
  print join(".", unpack("C4", pack("N", $net))), "/$len\n";
' "$lan_net")
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
# Managed by hatbot plugins/boxes/infra/boxes-provision.sh.
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
    ip saddr $BRAIN_IP tcp dport 7071 accept
    $ssh_rule
    icmp type echo-request accept
    # Neighbour discovery, without which SSH over IPv6 couldn't answer.
    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
  }

  chain output {
    type filter hook output priority filter; policy accept;
    oif lo accept
    ct state established,related accept
    meta skuid 61184-65519 counter reject
    meta skuid != $hatbox_uid accept
    meta nfproto ipv6 counter reject
    $dns_rule
    ip daddr @blocked counter reject
  }
}
EOF
systemctl enable -q nftables
systemctl restart nftables

say "Boxes guest provisioned"
