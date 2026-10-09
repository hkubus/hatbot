#!/usr/bin/env bash
# Tests the desktop firewall from host-setup.sh in throwaway network namespaces: a bridge with the
# desktop, the brain and a gateway that also stands in for the internet (9.9.9.9).
# Run as root on any Linux box with nft, iproute2, python3 and envsubst. Touches nothing outside the namespaces.

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
    DESKTOP_IP=192.168.55.225 BRAIN_IP=192.168.55.224 LAN_NET=192.168.55.0/24 envsubst)

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
ip -n desk route add default via 192.168.55.1
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
listen gw 192.168.55.1 443
listen hh 192.168.55.113 8006
listen brain 192.168.55.224 8081
listen desk 192.168.55.225 5901
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
expect_closed desk 192.168.55.113 8006
expect_closed desk 192.168.55.224 8081
expect_closed desk 192.168.55.224 8081 '' 5901
expect_open brain 192.168.55.225 5901
expect_open hh 192.168.55.113 8006
expect_open brain 192.168.55.1 443

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
