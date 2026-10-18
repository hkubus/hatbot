#!/usr/bin/env bash
# Tests the guests' firewalls in throwaway network namespaces: a bridge with the desktop, the boxes guest,
# the brain and a gateway that also stands in for the internet (9.9.9.9). First the host's, from
# host-setup.sh, then the desktop's and the boxes guest's own, from desktop-provision.sh and
# boxes-provision.sh, which is all there is without Proxmox (ssh-setup.sh).
# The boxes' and builds' own sandbox (PrivateNetwork, RestrictAddressFamilies) is systemd's, which a
# namespace can't stand in for; verify.sh checks it on the guest.
# Run as root on any Linux box with nft, iproute2, python3, setpriv and envsubst. Touches nothing outside
# the namespaces. Without root, in namespaces of your own (with subordinate IDs in /etc/subuid):
#   unshare --map-auto --map-root-user -nm --propagation private \
#     sh -c 'mount -t tmpfs none /run && mkdir /run/netns && ./test-firewall.sh'

set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NS="hh desk box brain gw"
PIDS=''
cleanup() {
  for n in $NS; do ip netns del "$n" 2>/dev/null; done
  # shellcheck disable=SC2086 # word splitting intended
  [[ -n $PIDS ]] && kill $PIDS 2>/dev/null
}
cleanup
trap cleanup EXIT

# Render the ruleset exactly as host-setup.sh writes it: the boxes guest's block, then the table with it,
# and without it (no boxes guest).
boxes_table=$(awk '/BOXES_TABLE=\$\(cat <<EOF$/ { f = 1; next } f && /^EOF$/ { exit } f' "$HERE/host-setup.sh" |
  BOXES_NAME=hatbot-boxes BOXES_ID=126 BOXES_VETH=veth126i0 BOXES_MAC=bc:24:11:ab:cd:01 \
    BOXES_IP=192.168.55.226 BRAIN_IP=192.168.55.224 envsubst)
host_nft() {
  awk '/^write_file \/etc\/hatbot\/host.nft/ { f = 1; next } f && /^EOF$/ { exit } f' "$HERE/host-setup.sh" |
    DESKTOP_NAME=hatbot-desktop DESKTOP_ID=125 DESKTOP_VETH=veth125i0 DESKTOP_MAC=bc:24:11:ab:cd:ef \
      DESKTOP_IP=192.168.55.225 BRAIN_IP=192.168.55.224 LAN_NET=192.168.55.0/24 PUBLIC_BLOCK=', 5.6.7.8' \
      BOXES_TABLE="$1" envsubst
}
[[ -n $boxes_table ]] || exit 1
rules=$(host_nft "$boxes_table")

for n in $NS; do
  ip netns add "$n"
  ip -n "$n" link set lo up
done
ip -n hh link add br0 type bridge
ip -n hh link set br0 up
ip -n hh addr add 192.168.55.113/24 dev br0
pair() { # pair NS BRIDGE-PORT IP MAC
  ip -n hh link add "$2" type veth peer name eth0 netns "$1"
  ip -n hh link set "$2" master br0 up
  ip -n "$1" link set eth0 address "$4" up
  ip -n "$1" addr add "$3/24" dev eth0
}
pair desk veth125i0 192.168.55.225 bc:24:11:ab:cd:ef
pair box veth126i0 192.168.55.226 bc:24:11:ab:cd:01
pair brain veth124i0 192.168.55.224 bc:24:11:00:00:01
pair gw veth900i0 192.168.55.1 bc:24:11:00:00:02
ip -n gw addr add 9.9.9.9/32 dev lo
# The owner's public address (HATBOT_PUBLIC_IPS) and a benchmarking one, both behind the gateway too.
ip -n gw addr add 5.6.7.8/32 dev lo
ip -n gw addr add 198.18.0.1/32 dev lo
# Other private and special ranges, routed by the gateway as a home router would: another LAN, a VPN,
# CGNAT, and the link-local address cloud metadata services answer on.
for a in 10.0.0.1 172.16.0.1 100.64.0.1 169.254.169.254; do ip -n gw addr add "$a/32" dev lo; done
ip -n desk route add default via 192.168.55.1
ip -n box route add default via 192.168.55.1
ip -n brain route add default via 192.168.55.1
ip netns exec hh nft -f - <<<"$(host_nft '')" || exit 1
ip netns exec hh nft -f - <<<"$rules" || exit 1

listen() { # listen NS IP PORT
  ip netns exec "$1" python3 -c "
import socket
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('$2', $3)); s.listen(8)
while True:
    c, _ = s.accept(); c.close()" &
  PIDS+=" $!"
}
listen gw 9.9.9.9 443
listen gw 5.6.7.8 443
listen gw 198.18.0.1 443
listen gw 192.168.55.1 443
for a in 10.0.0.1 172.16.0.1 100.64.0.1 169.254.169.254; do listen gw "$a" 80; done
listen hh 192.168.55.113 8006
listen hh 192.168.55.113 22
listen brain 192.168.55.224 8080
listen desk 192.168.55.225 5901
listen desk 192.168.55.225 7070
listen desk 192.168.55.225 22
listen box 192.168.55.226 7071
listen box 192.168.55.226 22
udp_echo() { # udp_echo NS IP PORT
  ip netns exec "$1" python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('$2', $3))
while True:
    d, a = s.recvfrom(512); s.sendto(d, a)" &
  PIDS+=" $!"
}
udp_echo gw 9.9.9.9 53
udp_echo gw 192.168.55.1 53
sleep 0.5

fails=0
report() { # report ok|FAIL text
  [[ $1 == ok ]] || fails=$((fails + 1))
  printf '%-5s %s\n' "$1" "$2"
}
# AS=UID runs the probes as that user.
as() { # as NS COMMAND...
  local ns=$1
  shift
  if [[ -n ${AS:-} ]]; then set -- setpriv --reuid="$AS" --regid="$AS" --clear-groups "$@"; fi
  ip netns exec "$ns" "$@"
}
conn() { # conn NS IP PORT [SRC-IP] [SRC-PORT] -> 0 if it connects
  as "$1" python3 -c "
import socket
s = socket.socket(); s.settimeout(2)
if '${4:-}' or '${5:-}': s.bind(('${4:-}', int('${5:-0}')))
s.connect(('$2', $3))" 2>/dev/null
}
expect_open() { if conn "$@"; then report ok "$1 → $2:$3 open"; else report FAIL "$1 → $2:$3 should be open"; fi; }
expect_closed() { if conn "$@"; then report FAIL "$1 → $2:$3 should be blocked${4:+ (from $4)}${5:+ (port $5)}"; else report ok "$1 → $2:$3 blocked${4:+ (from $4)}${5:+ (port $5)}"; fi; }

expect_open desk 9.9.9.9 443
expect_closed desk 192.168.55.1 443
for a in 10.0.0.1 172.16.0.1 100.64.0.1 169.254.169.254; do expect_closed desk "$a" 80; done
expect_closed desk 5.6.7.8 443
expect_closed desk 198.18.0.1 443
expect_open brain 5.6.7.8 443
expect_closed desk 192.168.55.113 8006
expect_closed desk 192.168.55.113 22
expect_closed desk 192.168.55.224 8080
expect_closed desk 192.168.55.224 8080 '' 5901
expect_closed desk 192.168.55.224 8080 '' 7070
expect_open brain 192.168.55.225 5901
expect_open brain 192.168.55.225 7070
# The desktop only answers the brain from VNC and desktop-agent; replies from anything else are dropped.
expect_closed brain 192.168.55.225 22
expect_open hh 192.168.55.113 8006
expect_open brain 192.168.55.1 443

# UDP: public DNS is the desktop's resolver; the LAN's isn't reachable.
udp() { # udp NS IP PORT -> 0 if the echo comes back
  as "$1" python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
s.sendto(b'hi', ('$2', $3)); s.recvfrom(512)" 2>/dev/null
}
if udp desk 9.9.9.9 53; then report ok "desk → 9.9.9.9:53/udp open"; else report FAIL "desk → 9.9.9.9:53/udp should be open"; fi
if udp desk 192.168.55.1 53; then report FAIL "desk → 192.168.55.1:53/udp should be blocked"; else report ok "desk → 192.168.55.1:53/udp blocked"; fi

# ARP: a guest may only announce its own address. Claiming the brain's would take its traffic.
claim_brain() { # claim_brain NS MAC
  ip netns exec gw ping -c 1 -W 1 192.168.55.224 >/dev/null 2>&1
  sleep 1.2 # past the neighbour table's lock time, so a real announcement would be taken
  ip netns exec "$1" python3 -c "
import socket, struct
mac = bytes.fromhex('${2//:/}'); everyone = bytes.fromhex('ffffffffffff')
ip = socket.inet_aton('192.168.55.224')
arp = struct.pack('!HHBBH6s4s6s4s', 1, 0x0800, 6, 4, 2, mac, ip, everyone, ip)
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW); s.bind(('eth0', 0))
s.send(everyone + mac + bytes.fromhex('0806') + arp)"
  sleep 0.5
  if ip -n gw neigh show 192.168.55.224 | grep -qi "$2"; then
    report FAIL "$1 claimed the brain's address over ARP"
  else
    report ok "$1 can't claim the brain's address over ARP"
  fi
}
claim_brain desk bc:24:11:ab:cd:ef

ip -n desk addr add 192.168.55.50/24 dev eth0
expect_closed desk 9.9.9.9 443 192.168.55.50
ip -n desk link set eth0 address bc:24:11:99:99:99
expect_closed desk 9.9.9.9 443 # with a changed MAC
ip -n desk link set eth0 address bc:24:11:ab:cd:ef
ip -n desk addr add fd00::5/64 dev eth0 nodad
ip -n gw addr add fd00::1/64 dev eth0 nodad
if ip netns exec desk ping -6 -c 1 -W 1 fd00::1 >/dev/null 2>&1; then
  report FAIL "desk → IPv6 should be blocked"
else
  report ok "desk → IPv6 blocked"
fi

ip -n desk addr del 192.168.55.50/24 dev eth0

# The boxes guest's port: the same fence, with only its agent's port open to the brain.
echo
expect_open box 9.9.9.9 443
expect_closed box 192.168.55.1 443
for a in 10.0.0.1 172.16.0.1 100.64.0.1 169.254.169.254; do expect_closed box "$a" 80; done
expect_closed box 5.6.7.8 443
expect_closed box 198.18.0.1 443
expect_closed box 192.168.55.113 8006
expect_closed box 192.168.55.113 22
expect_closed box 192.168.55.224 8080
expect_closed box 192.168.55.224 8080 '' 7071
expect_closed box 192.168.55.225 7070
expect_open brain 192.168.55.226 7071
expect_closed brain 192.168.55.226 22
expect_closed desk 192.168.55.226 7071
if udp box 9.9.9.9 53; then report ok "box → 9.9.9.9:53/udp open"; else report FAIL "box → 9.9.9.9:53/udp should be open"; fi
if udp box 192.168.55.1 53; then report FAIL "box → 192.168.55.1:53/udp should be blocked"; else report ok "box → 192.168.55.1:53/udp blocked"; fi
claim_brain box bc:24:11:ab:cd:01
ip -n box addr add 192.168.55.51/24 dev eth0
expect_closed box 9.9.9.9 443 192.168.55.51
ip -n box addr del 192.168.55.51/24 dev eth0
ip -n box link set eth0 address bc:24:11:99:99:98
expect_closed box 9.9.9.9 443 # with a changed MAC
ip -n box link set eth0 address bc:24:11:ab:cd:01
ip -n box addr add fd00::6/64 dev eth0 nodad
if ip netns exec box ping -6 -c 1 -W 1 fd00::1 >/dev/null 2>&1; then
  report FAIL "box → IPv6 should be blocked"
else
  report ok "box → IPv6 blocked"
fi

# The desktop's own firewall, without the host's: desk (uid 1000) and the shell's DynamicUsers reach
# only the internet, and the LAN's resolver on port 53; root's services aren't filtered.
echo
ip netns exec hh nft delete table bridge hatbot
guest=$(awk '/^cat >\/etc\/nftables.conf <<EOF$/ { f = 1; next } f && /^EOF$/ { exit } f' "$HERE/desktop-provision.sh" |
  BRAIN_IP=192.168.55.224 desk_uid=1000 blocked='192.168.55.0/24, 192.168.55.224, 5.6.7.8' \
    dns_rule='ip daddr { 192.168.55.1 } meta l4proto { tcp, udp } th dport 53 accept' \
    ssh_rule='ip saddr != 192.168.55.224 tcp dport { 22 } accept' envsubst)
ip netns exec desk nft -f - <<<"$guest" || exit 1
for AS in 1000 61184; do
  echo "as uid $AS:"
  expect_open desk 9.9.9.9 443
  expect_closed desk 192.168.55.1 443
  for a in 10.0.0.1 169.254.169.254; do expect_closed desk "$a" 80; done
  expect_closed desk 5.6.7.8 443
  expect_closed desk 192.168.55.113 22
  expect_closed desk 192.168.55.224 8080
done
AS=1000
if udp desk 192.168.55.1 53; then report ok "desk → 192.168.55.1:53/udp open"; else report FAIL "desk → 192.168.55.1:53/udp should be open"; fi
AS=''
echo "as root:"
expect_open desk 192.168.55.1 443
# IPv6 over TCP: open for root, so the refusal below is the firewall's. The input chain drops neighbour
# discovery, so the neighbours are pinned.
ip -n desk neigh replace fd00::1 lladdr bc:24:11:00:00:02 dev eth0 nud permanent
ip -n gw neigh replace fd00::5 lladdr bc:24:11:ab:cd:ef dev eth0 nud permanent
ip netns exec gw python3 -c "
import socket
s = socket.socket(socket.AF_INET6); s.bind(('fd00::1', 443)); s.listen(8)
while True:
    c, _ = s.accept(); c.close()" &
PIDS+=" $!"
for _ in $(seq 1 20); do ip netns exec gw ss -Hltn 'sport = 443' | grep -q fd00::1 && break; sleep 0.1; done
conn6() { as "$1" python3 -c "
import socket
s = socket.socket(socket.AF_INET6); s.settimeout(2); s.connect(('fd00::1', 443))" 2>/dev/null; }
if conn6 desk; then report ok "desk → [fd00::1]:443 open"; else report FAIL "desk → [fd00::1]:443 should be open"; fi
AS=1000
if conn6 desk; then report FAIL "desk → IPv6 should be blocked (uid 1000)"; else report ok "desk → IPv6 blocked (uid 1000)"; fi
AS=''
expect_open brain 192.168.55.225 7070
expect_closed brain 192.168.55.225 22
expect_closed hh 192.168.55.225 7070
# Set up over SSH, it stays reachable over SSH.
expect_open hh 192.168.55.225 22

# The boxes guest's own firewall, without the host's: only the agent's user (uid 999 here) goes out, to
# the internet and the LAN's resolver on port 53. The boxes' and builds' DynamicUsers get nothing, not even
# the internet (they have no network of their own; this is the second layer). Root's services pass.
echo
boxes=$(awk '/^cat >\/etc\/nftables.conf <<EOF$/ { f = 1; next } f && /^EOF$/ { exit } f' "$HERE/boxes-provision.sh" |
  BRAIN_IP=192.168.55.224 hatbox_uid=999 blocked='192.168.55.0/24, 192.168.55.224, 5.6.7.8' \
    dns_rule='ip daddr { 192.168.55.1 } meta l4proto { tcp, udp } th dport 53 accept' \
    ssh_rule='ip saddr != 192.168.55.224 tcp dport { 22 } accept' envsubst)
ip netns exec box nft -f - <<<"$boxes" || exit 1
AS=999
echo "as uid 999 (the agent):"
expect_open box 9.9.9.9 443
expect_closed box 192.168.55.1 443
for a in 10.0.0.1 172.16.0.1 169.254.169.254; do expect_closed box "$a" 80; done
expect_closed box 5.6.7.8 443
expect_closed box 192.168.55.113 22
expect_closed box 192.168.55.224 8080
if udp box 192.168.55.1 53; then report ok "box → 192.168.55.1:53/udp open"; else report FAIL "box → 192.168.55.1:53/udp should be open"; fi
for AS in 61184 65519; do
  echo "as uid $AS (a box or a build):"
  expect_closed box 9.9.9.9 443
  expect_closed box 192.168.55.1 443
  if udp box 9.9.9.9 53; then report FAIL "box → 9.9.9.9:53/udp should be blocked"; else report ok "box → 9.9.9.9:53/udp blocked"; fi
done
AS=''
echo "as root:"
expect_open box 9.9.9.9 443
expect_open box 192.168.55.1 443
ip -n box neigh replace fd00::1 lladdr bc:24:11:00:00:02 dev eth0 nud permanent
ip -n gw neigh replace fd00::6 lladdr bc:24:11:ab:cd:01 dev eth0 nud permanent
if conn6 box; then report ok "box → [fd00::1]:443 open"; else report FAIL "box → [fd00::1]:443 should be open"; fi
AS=999
if conn6 box; then report FAIL "box → IPv6 should be blocked (uid 999)"; else report ok "box → IPv6 blocked (uid 999)"; fi
AS=''
expect_open brain 192.168.55.226 7071
expect_closed brain 192.168.55.226 22
expect_closed hh 192.168.55.226 7071
expect_open hh 192.168.55.226 22

printf '\n%d failed\n' "$fails"
((fails == 0))
