#!/usr/bin/env bash
# Tests the desktop firewall from host-setup.sh in throwaway network namespaces: a bridge with the
# desktop, the brain and a gateway that also stands in for the internet (9.9.9.9).
# Run as root on any Linux box with nft, iproute2, python3 and envsubst. Touches nothing outside the namespaces.
# Without root, in namespaces of your own:
#   unshare -rnm --propagation private sh -c 'mount -t tmpfs none /run && mkdir /run/netns && ./test-firewall.sh'

set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NS="hh desk brain gw"
PIDS=''
cleanup() {
  for n in $NS; do ip netns del "$n" 2>/dev/null; done
  # shellcheck disable=SC2086 # word splitting intended
  [[ -n $PIDS ]] && kill $PIDS 2>/dev/null
}
cleanup
trap cleanup EXIT

# Render the ruleset exactly as host-setup.sh writes it.
rules=$(awk '/^write_file \/etc\/hatbot\/host.nft/ { f = 1; next } f && /^EOF$/ { exit } f' "$HERE/host-setup.sh" |
  DESKTOP_NAME=hatbot-desktop DESKTOP_ID=125 DESKTOP_VETH=veth125i0 DESKTOP_MAC=bc:24:11:ab:cd:ef \
    DESKTOP_IP=192.168.55.225 BRAIN_IP=192.168.55.224 LAN_NET=192.168.55.0/24 PUBLIC_BLOCK=', 5.6.7.8' envsubst)

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
ip -n brain route add default via 192.168.55.1
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
conn() { # conn NS IP PORT [SRC-IP] [SRC-PORT] -> 0 if it connects
  ip netns exec "$1" python3 -c "
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
  ip netns exec "$1" python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
s.sendto(b'hi', ('$2', $3)); s.recvfrom(512)" 2>/dev/null
}
if udp desk 9.9.9.9 53; then report ok "desk → 9.9.9.9:53/udp open"; else report FAIL "desk → 9.9.9.9:53/udp should be open"; fi
if udp desk 192.168.55.1 53; then report FAIL "desk → 192.168.55.1:53/udp should be blocked"; else report ok "desk → 192.168.55.1:53/udp blocked"; fi

# ARP: the desktop may only announce its own address. Claiming the brain's would take its traffic.
ip netns exec gw ping -c 1 -W 1 192.168.55.224 >/dev/null 2>&1
sleep 1.2 # past the neighbour table's lock time, so a real announcement would be taken
ip netns exec desk python3 -c "
import socket, struct
mac = bytes.fromhex('bc2411abcdef'); everyone = bytes.fromhex('ffffffffffff')
ip = socket.inet_aton('192.168.55.224')
arp = struct.pack('!HHBBH6s4s6s4s', 1, 0x0800, 6, 4, 2, mac, ip, everyone, ip)
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW); s.bind(('eth0', 0))
s.send(everyone + mac + bytes.fromhex('0806') + arp)"
sleep 0.5
if ip -n gw neigh show 192.168.55.224 | grep -qi 'bc:24:11:ab:cd:ef'; then
  report FAIL "desk claimed the brain's address over ARP"
else
  report ok "desk can't claim the brain's address over ARP"
fi

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

printf '\n%d failed\n' "$fails"
((fails == 0))
