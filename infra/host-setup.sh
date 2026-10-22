#!/usr/bin/env bash
# Hatbot: one-time Proxmox host setup.
#
# Run as root on the Proxmox host, from a copy of the repo's infra/ folder:
#   ./host-setup.sh --dry-run   show every change, change nothing
#   ./host-setup.sh             ask before each change
#   ./host-setup.sh --yes       accept all defaults without asking
#
# Safe to re-run: each step checks what already exists and skips it.
# Answers are saved to /etc/hatbot/host.env and reused as defaults next time.
# Any setting below can also be preset as an environment variable.

set -euo pipefail
umask 022

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

STATE=/etc/hatbot/host.env
# shellcheck source=/dev/null
[[ -r $STATE ]] && source "$STATE"
[[ ${HATBOT_TRANSPORT:-pct} == pct ]] || die "$STATE is from ssh-setup.sh; this machine's Hatbot isn't on Proxmox"
HATBOT_TRANSPORT=pct

BRAIN_ID=${BRAIN_ID:-}
DESKTOP_ID=${DESKTOP_ID:-}
BOXES_ID=${BOXES_ID:-}                      # none: no boxes guest, so boxes are only pages
BRAIN_IP=${BRAIN_IP:-}                      # default: <LAN prefix>.<VMID + 100>
DESKTOP_IP=${DESKTOP_IP:-}                  # same rule
BOXES_IP=${BOXES_IP:-}                      # same rule
SSD_STORE=${SSD_STORE:-}                    # root disks
HDD_STORE=${HDD_STORE:-}                    # /archive on the brain
ARCHIVE_SIZE=${ARCHIVE_SIZE:-200}           # GiB, can be grown later
LAN_BRIDGE=${LAN_BRIDGE:-}                  # bridge the guests join (default: the uplink)
DNS=${DNS:-9.9.9.9 1.1.1.1}                 # the desktop's and boxes guest's resolvers (they can't reach LAN DNS)
FORCE=${FORCE:-0}                           # 1 = continue despite the RAM check
HATBOT_PUBLIC_IPS=${HATBOT_PUBLIC_IPS:-}    # optional: your public IPv4s (space-separated), so the desktop
                                            # and the boxes can't come back in through them (port forwards,
                                            # hairpin NAT)

POOL=hatbot
PVE_USER=hatbot@pve
TOKEN_NAME=brain
TOKEN_ID="$PVE_USER!$TOKEN_NAME"
BRAIN_NAME=hatbot-brain
DESKTOP_NAME=hatbot-desktop
BOXES_NAME=hatbot-boxes
BRAIN_MEM=2048
BRAIN_SWAP=512
DESKTOP_MEM=1536
DESKTOP_SWAP=1024
BOXES_MEM=768
BOXES_SWAP=512

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case $arg in
    -n | --dry-run) DRY_RUN=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

run() {
  printf '   %s+' "$dim"
  printf ' %q' "$@"
  printf '%s\n' "$rst"
  ((DRY_RUN)) || "$@"
}

# ask VAR "question" DEFAULT
ask() {
  local __var=$1 q=$2 def=${3:-} ans=''
  if ((ASSUME_YES)) || [[ ! -t 0 ]]; then
    printf -v "$__var" '%s' "$def"
    info "$q: $def"
    return
  fi
  read -r -p "   $q [$def]: " ans || true
  printf -v "$__var" '%s' "${ans:-$def}"
}

# confirm "question" -> 0 for yes. Dry runs answer yes so every change is shown.
confirm() {
  ((ASSUME_YES || DRY_RUN)) && return 0
  local ans=''
  read -r -p "   $1 [y/N] " ans || true
  [[ $ans == [yY]* ]]
}

# write_file PATH MODE, content on stdin. Skips the write when the file is unchanged.
write_file() {
  local path=$1 mode=$2 tmp
  if ((DRY_RUN)); then
    printf '   %s+ write %s (mode %s)%s\n' "$dim" "$path" "$mode" "$rst"
    sed 's/^/       | /'
    return
  fi
  tmp=$(mktemp)
  cat >"$tmp"
  if [[ -f $path ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    ok "$path unchanged"
    return
  fi
  install -D -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  ok "wrote $path"
}

wait_ct() {
  local id=$1 _
  for _ in $(seq 1 45); do
    pct exec "$id" -- getent hosts deb.debian.org >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "CT $id has no working network or DNS after 90 s"
}

save_state() {
  ((DRY_RUN)) && return
  install -d -m 700 /etc/hatbot
  {
    echo "# Written by hatbot infra/host-setup.sh; edit and re-run to change."
    local v
    for v in HATBOT_TRANSPORT BRAIN_ID DESKTOP_ID BOXES_ID BRAIN_IP DESKTOP_IP BOXES_IP SSD_STORE HDD_STORE ARCHIVE_SIZE LAN_BRIDGE DNS HATBOT_PUBLIC_IPS; do
      printf '%s=%q\n' "$v" "${!v}"
    done
  } >"$STATE"
  chmod 600 "$STATE"
}

((DRY_RUN)) && printf '%sDry run: nothing will be changed.%s\n' "$yel" "$rst"

step "1/8 Preflight"
[[ $EUID -eq 0 ]] || die "run as root on the Proxmox host"
command -v pveversion >/dev/null || die "pveversion not found; this is not a Proxmox VE host"
for c in pct pvesh pveum pveam pvesm ip perl openssl systemctl; do
  command -v "$c" >/dev/null || die "missing command: $c"
done
PVE_VER=$(pveversion | sed -n 's#^pve-manager/\([0-9.]*\).*#\1#p')
((${PVE_VER%%.*} >= 8)) || die "Proxmox VE 8 or newer required (found $PVE_VER)"
NODE=$(hostname)
[[ -d /etc/pve/nodes/$NODE ]] || die "node $NODE not found under /etc/pve/nodes"
ok "Proxmox VE $PVE_VER on node $NODE"

UPLINK=$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
LAN_GW=$(ip -4 route show default | awk '{ print $3; exit }')
[[ -n $UPLINK ]] || die "no IPv4 default route"
HOST_LAN_CIDR=$(ip -4 -o addr show dev "$UPLINK" | awk '{ print $4; exit }')
HOST_LAN_IP=${HOST_LAN_CIDR%/*}
LAN_LEN=${HOST_LAN_CIDR#*/}
LAN_NET=$(cidr_net "$HOST_LAN_CIDR")
LAN_BRIDGE=${LAN_BRIDGE:-$UPLINK}
[[ -d /sys/class/net/$LAN_BRIDGE/bridge ]] || die "$LAN_BRIDGE is not a Linux bridge; set LAN_BRIDGE to the bridge the guests should join"
ok "uplink $UPLINK, host $HOST_LAN_CIDR, LAN $LAN_NET, gateway $LAN_GW"
if systemctl is-enabled --quiet nftables 2>/dev/null; then
  warn "nftables.service is enabled; if /etc/nftables.conf starts with 'flush ruleset' it removes Hatbot's rules at boot"
fi

# Reuse guests from an earlier run, matched by name.
read -r ex_brain_id ex_brain_type ex_brain_node < <(find_guest "$BRAIN_NAME") || true
read -r ex_desk_id ex_desk_type ex_desk_node < <(find_guest "$DESKTOP_NAME") || true
read -r ex_boxes_id ex_boxes_type ex_boxes_node < <(find_guest "$BOXES_NAME") || true
for g in "brain:${ex_brain_id:-}:${ex_brain_type:-}:${ex_brain_node:-}" "desktop:${ex_desk_id:-}:${ex_desk_type:-}:${ex_desk_node:-}" \
  "boxes:${ex_boxes_id:-}:${ex_boxes_type:-}:${ex_boxes_node:-}"; do
  IFS=: read -r label id type node <<<"$g"
  [[ -z $id ]] && continue
  [[ $type == lxc && $node == "$NODE" ]] || die "a guest named hatbot-$label already exists ($type $id on $node); rename or remove it"
  ok "found existing hatbot-$label (CT $id)"
done
BRAIN_ID=${ex_brain_id:-$BRAIN_ID}
DESKTOP_ID=${ex_desk_id:-$DESKTOP_ID}
BOXES_ID=${ex_boxes_id:-$BOXES_ID}
if [[ -z $BRAIN_ID ]]; then
  ask BRAIN_ID "VMID for $BRAIN_NAME" "$(pvesh get /cluster/nextid | tr -d '"')"
fi
if [[ -z $DESKTOP_ID ]]; then
  n=$((BRAIN_ID + 1))
  while vmid_used "$n"; do n=$((n + 1)); done
  ask DESKTOP_ID "VMID for $DESKTOP_NAME" "$n"
fi
[[ -z ${ex_brain_id:-} ]] && vmid_used "$BRAIN_ID" && die "VMID $BRAIN_ID is already used by another guest"
[[ -z ${ex_desk_id:-} ]] && vmid_used "$DESKTOP_ID" && die "VMID $DESKTOP_ID is already used by another guest"
[[ $BRAIN_ID != "$DESKTOP_ID" ]] || die "brain and desktop need different VMIDs"
# The boxes guest is optional: without it boxes are only pages. BOXES is its VMID, empty without one.
if [[ -z $BOXES_ID ]]; then
  n=$((DESKTOP_ID + 1))
  while vmid_used "$n" || [[ $n == "$BRAIN_ID" ]]; do n=$((n + 1)); done
  ask BOXES_ID "VMID for $BOXES_NAME, which runs boxes' backends (none: boxes are only pages)" "$n"
fi
[[ $BOXES_ID == none || $BOXES_ID =~ ^[1-9][0-9]*$ ]] || die "BOXES_ID is $BOXES_ID; give a VMID, or none for no boxes guest"
BOXES=''
[[ $BOXES_ID == none ]] || BOXES=$BOXES_ID
if [[ -n $BOXES ]]; then
  [[ -z ${ex_boxes_id:-} ]] && vmid_used "$BOXES" && die "VMID $BOXES is already used by another guest"
  [[ $BOXES != "$BRAIN_ID" && $BOXES != "$DESKTOP_ID" ]] || die "the boxes guest needs a VMID of its own"
fi

# LAN addresses: kept from existing guests, otherwise <LAN prefix>.<VMID + 100>.
ct_ip() { pct config "$1" 2>/dev/null | sed -n 's#^net0:.*[,:]ip=\([0-9.]*\)/.*#\1#p'; }
ct_mac() { pct config "$1" 2>/dev/null | sed -n 's#^net0:.*hwaddr=\([0-9A-Fa-f:]*\).*#\1#p' | tr 'A-F' 'a-f'; }
pick_ip() { # pick_ip VAR VMID EXISTING
  local __var=$1 id=$2 existing=$3 ip
  if [[ -n $existing ]]; then
    ip=$(ct_ip "$id")
    [[ -n $ip ]] || die "CT $id has no static IPv4 address on net0; set one, or remove the CT and re-run"
  else
    ip=${!__var:-${HOST_LAN_IP%.*}.$((id + 100))}
    [[ $(cidr_net "$ip/$LAN_LEN") == "$LAN_NET" && ${ip##*.} -ge 1 && ${ip##*.} -le 254 ]] ||
      die "$ip is not a usable address in $LAN_NET; set $__var"
    if ping -c 1 -W 1 "$ip" >/dev/null 2>&1 || ip neigh show "$ip" | grep -qE 'REACHABLE|STALE|DELAY|PERMANENT'; then
      die "$ip is already in use on the LAN; set $__var"
    fi
  fi
  printf -v "$__var" '%s' "$ip"
}
pick_ip BRAIN_IP "$BRAIN_ID" "${ex_brain_id:-}"
pick_ip DESKTOP_IP "$DESKTOP_ID" "${ex_desk_id:-}"
[[ $BRAIN_IP != "$DESKTOP_IP" ]] || die "brain and desktop need different IPs"
[[ $BRAIN_IP != "$HOST_LAN_IP" && $DESKTOP_IP != "$HOST_LAN_IP" && $DESKTOP_IP != "$LAN_GW" && $BRAIN_IP != "$LAN_GW" ]] ||
  die "a guest IP clashes with the host or the gateway; set BRAIN_IP / DESKTOP_IP"
if [[ -n $BOXES ]]; then
  pick_ip BOXES_IP "$BOXES" "${ex_boxes_id:-}"
  [[ $BOXES_IP != "$BRAIN_IP" && $BOXES_IP != "$DESKTOP_IP" ]] || die "the boxes guest needs an IP of its own; set BOXES_IP"
  [[ $BOXES_IP != "$HOST_LAN_IP" && $BOXES_IP != "$LAN_GW" ]] ||
    die "the boxes guest's IP clashes with the host or the gateway; set BOXES_IP"
else
  BOXES_IP=''
fi
ok "brain $BRAIN_IP, desktop $DESKTOP_IP${BOXES:+, boxes $BOXES_IP} (/$LAN_LEN, gateway $LAN_GW)"

# The host firewall matches the desktop and the boxes guest by bridge port and MAC, so the MACs are fixed
# up front.
DESKTOP_VETH=veth${DESKTOP_ID}i0
if [[ -n ${ex_desk_id:-} ]]; then
  DESKTOP_MAC=$(ct_mac "$DESKTOP_ID")
  [[ -n $DESKTOP_MAC ]] || die "can't read the MAC of CT $DESKTOP_ID"
else
  DESKTOP_MAC=bc:24:11:$(openssl rand -hex 3 | sed 's/../&:/g; s/:$//')
fi
BOXES_VETH=veth${BOXES}i0 BOXES_MAC=''
if [[ -n ${ex_boxes_id:-} ]]; then
  BOXES_MAC=$(ct_mac "$BOXES")
  [[ -n $BOXES_MAC ]] || die "can't read the MAC of CT $BOXES"
elif [[ -n $BOXES ]]; then
  BOXES_MAC=bc:24:11:$(openssl rand -hex 3 | sed 's/../&:/g; s/:$//')
fi

info "Storages that can hold container disks:"
pvesm status --content rootdir 2>/dev/null |
  awk 'NR > 1 && $3 == "active" { printf "       %-16s %-10s %6d GiB free\n", $1, $2, $6 / 1048576 }'
if [[ -z $SSD_STORE ]]; then
  def=$(pvesm status --content rootdir 2>/dev/null | awk 'NR > 1 && $3 == "active" && $2 ~ /zfspool|lvmthin/ { print $1; exit }')
  ask SSD_STORE "SSD storage for the root disks" "${def:-local-lvm}"
fi
[[ -z $HDD_STORE ]] && ask HDD_STORE "HDD storage for the brain's /archive" ""
[[ -n $HDD_STORE ]] || die "set HDD_STORE to the HDD pool for /archive"
for s in "$SSD_STORE" "$HDD_STORE"; do
  pvesm status --content rootdir 2>/dev/null | awk -v s="$s" 'NR > 1 && $1 == s { f = 1 } END { exit !f }' ||
    die "storage $s doesn't exist or can't hold container disks"
done
SSD_TYPE=$(store_type "$SSD_STORE")
case $SSD_TYPE in
  zfspool | lvmthin | rbd | btrfs) SNAP_OK=1 ;;
  *)
    SNAP_OK=0
    warn "$SSD_STORE is $SSD_TYPE, which can't snapshot containers; nightly desktop${BOXES:+ and boxes} snapshots will be skipped"
    ;;
esac
TMPL_STORE=$(pvesm status --content vztmpl 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1; exit }')
[[ -n $TMPL_STORE ]] || die "no storage accepts container templates (content type vztmpl)"
ok "root disks on $SSD_STORE ($SSD_TYPE), /archive on $HDD_STORE (${ARCHIVE_SIZE} GiB), templates on $TMPL_STORE"

need=0
[[ -z ${ex_brain_id:-} ]] && need=$((need + BRAIN_MEM))
[[ -z ${ex_desk_id:-} ]] && need=$((need + DESKTOP_MEM))
[[ -n $BOXES && -z ${ex_boxes_id:-} ]] && need=$((need + BOXES_MEM))
if ((need > 0)); then
  avail=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
  arc=0
  [[ -r /proc/spl/kstat/zfs/arcstats ]] && arc=$(awk '$1 == "size" { print int($3 / 1048576) }' /proc/spl/kstat/zfs/arcstats)
  if ((avail < need + 512)); then
    msg="not enough free RAM: the new guests need ${need} MiB plus 512 MiB headroom, ${avail} MiB is available"
    ((arc > 0)) && msg+=" (ZFS ARC holds ${arc} MiB and shrinks under pressure)"
    if ((FORCE)); then warn "$msg; continuing because FORCE=1"; else die "$msg. Free some RAM or set FORCE=1."; fi
  else
    ok "RAM: ${avail} MiB available, ${need} MiB needed"
  fi
fi

boxes_plan="     boxes    none (BOXES_ID=none): boxes are only pages"
if [[ -n $BOXES ]]; then
  boxes_plan="     boxes    CT $BOXES  $BOXES_NAME    2 vCPU, $BOXES_MEM MiB + $BOXES_SWAP MiB swap, 8 GiB on $SSD_STORE
              $BOXES_IP/$LAN_LEN on $LAN_BRIDGE (MAC $BOXES_MAC), DNS $DNS"
fi
fenced="the desktop's bridge port"
[[ -z $BOXES ]] || fenced="the desktop's and the boxes guest's bridge ports"
cat <<EOF

   Plan:
     brain    CT $BRAIN_ID  $BRAIN_NAME    2 vCPU, $BRAIN_MEM MiB, 16 GiB on $SSD_STORE, /archive ${ARCHIVE_SIZE} GiB on $HDD_STORE
              $BRAIN_IP/$LAN_LEN on $LAN_BRIDGE
     desktop  CT $DESKTOP_ID  $DESKTOP_NAME  2 vCPU, $DESKTOP_MEM MiB + $DESKTOP_SWAP MiB swap, 16 GiB on $SSD_STORE
              $DESKTOP_IP/$LAN_LEN on $LAN_BRIDGE (MAC $DESKTOP_MAC), DNS $DNS
$boxes_plan
     firewall the host filters $fenced: internet only, no LAN, no host, no IPv6
     access   user $PVE_USER, roles HatbotOps + HatbotSnapshots, token $TOKEN_ID
EOF
confirm "Continue?" || die "stopped"
save_state

step "2/8 Containers"
if pveum pool list --output-format json | json_values poolid | grep -qx "$POOL"; then
  ok "pool $POOL exists"
else
  run pveum pool add "$POOL" --comment "Hatbot's own guests (it may snapshot these)"
fi

if [[ -z ${ex_brain_id:-} || -z ${ex_desk_id:-} || ( -n $BOXES && -z ${ex_boxes_id:-} ) ]]; then
  TMPL=$(pveam list "$TMPL_STORE" 2>/dev/null | grep -o 'debian-13-standard_[^ ]*' | sort -V | tail -1 || true)
  if [[ -z $TMPL ]]; then
    ((DRY_RUN)) || pveam update >/dev/null
    TMPL=$(pveam available --section system | awk '{ print $2 }' | grep '^debian-13-standard_' | sort -V | tail -1 || true)
    [[ -n $TMPL ]] || die "no debian-13-standard template available from pveam"
    run pveam download "$TMPL_STORE" "$TMPL"
  fi
  TMPL_VOL="$TMPL_STORE:vztmpl/$TMPL"
  ok "template $TMPL_VOL"
fi

if [[ -n ${ex_brain_id:-} ]]; then
  ok "$BRAIN_NAME exists (CT $BRAIN_ID)"
else
  run pct create "$BRAIN_ID" "$TMPL_VOL" --hostname "$BRAIN_NAME" \
    --description "Hatbot brain. Created by infra/host-setup.sh." \
    --unprivileged 1 --features nesting=1 --cores 2 --memory "$BRAIN_MEM" --swap "$BRAIN_SWAP" \
    --rootfs "$SSD_STORE:16" --mp0 "$HDD_STORE:$ARCHIVE_SIZE,mp=/archive,backup=1" \
    --net0 "name=eth0,bridge=$LAN_BRIDGE,ip=$BRAIN_IP/$LAN_LEN,gw=$LAN_GW" \
    --onboot 1 --startup order=10 --timezone host --pool "$POOL" --tags hatbot
fi

if [[ -n ${ex_desk_id:-} ]]; then
  ok "$DESKTOP_NAME exists (CT $DESKTOP_ID)"
else
  run pct create "$DESKTOP_ID" "$TMPL_VOL" --hostname "$DESKTOP_NAME" \
    --description "Hatbot desktop. Browses untrusted sites: internet only, no LAN, no secrets. Its MAC is pinned in the host firewall (/etc/hatbot/host.nft); don't change it. Created by infra/host-setup.sh." \
    --unprivileged 1 --features nesting=1 --cores 2 --memory "$DESKTOP_MEM" --swap "$DESKTOP_SWAP" \
    --rootfs "$SSD_STORE:16" \
    --net0 "name=eth0,bridge=$LAN_BRIDGE,hwaddr=$DESKTOP_MAC,ip=$DESKTOP_IP/$LAN_LEN,gw=$LAN_GW" --nameserver "$DNS" \
    --onboot 1 --startup order=20 --timezone host --pool "$POOL" --tags hatbot
fi

if [[ -z $BOXES ]]; then
  info "no $BOXES_NAME (BOXES_ID=none)"
elif [[ -n ${ex_boxes_id:-} ]]; then
  ok "$BOXES_NAME exists (CT $BOXES)"
else
  # nesting=1, as the desktop has: the box units' sandboxing (a mount namespace each, PrivateDevices,
  # ProtectKernelTunables) needs mounts that an unprivileged container's AppArmor profile only allows with
  # it, and Proxmox warns that Debian 13's systemd needs it anyway.
  run pct create "$BOXES" "$TMPL_VOL" --hostname "$BOXES_NAME" \
    --description "Hatbot boxes guest. Runs the backends of boxes, code a bot wrote: internet only for its agent, no LAN, no secrets but the agent's token. Its MAC is pinned in the host firewall (/etc/hatbot/host.nft); don't change it. Created by infra/host-setup.sh." \
    --unprivileged 1 --features nesting=1 --cores 2 --memory "$BOXES_MEM" --swap "$BOXES_SWAP" \
    --rootfs "$SSD_STORE:8" \
    --net0 "name=eth0,bridge=$LAN_BRIDGE,hwaddr=$BOXES_MAC,ip=$BOXES_IP/$LAN_LEN,gw=$LAN_GW" --nameserver "$DNS" \
    --onboot 1 --startup order=20 --timezone host --pool "$POOL" --tags hatbot
fi

step "3/8 Guest firewall"
if ! command -v nft >/dev/null; then
  confirm "Install the nftables package (only the nft command; nftables.service stays disabled)?" || die "nft is required"
  run apt-get install -y --no-install-recommends nftables
  # Never start or stop nftables.service here: its config begins with 'flush ruleset', which would also
  # wipe the Proxmox firewall's rules. Hatbot loads its own table through hatbot-firewall.service.
  run systemctl disable nftables.service
fi

PUBLIC_BLOCK=''
for ip in $HATBOT_PUBLIC_IPS; do
  [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] || die "HATBOT_PUBLIC_IPS: $ip isn't an IPv4 address"
  PUBLIC_BLOCK+=", $ip"
done

# The boxes guest runs code a bot wrote, so its port gets the same fence, in a second block of the same
# table. Only the brain reaches its agent (7071). It goes right after the table's closing brace, blank
# lines included, so without a boxes guest host.nft stays as it was.
BOXES_TABLE=''
if [[ -n $BOXES ]]; then
  BOXES_TABLE=$(cat <<EOF


# $BOXES_NAME (CT $BOXES_ID): the same fence, with only the brain reaching its agent.
table bridge hatbot {
  chain boxes_prerouting {
    type filter hook prerouting priority filter - 5; policy accept;
    iifname "$BOXES_VETH" ether saddr != $BOXES_MAC counter drop
  }

  chain forward {
    iifname "$BOXES_VETH" jump from_boxes
  }

  chain input {
    iifname "$BOXES_VETH" ether type arp jump boxes_arp
    iifname "$BOXES_VETH" counter drop
  }

  chain from_boxes {
    ether saddr != $BOXES_MAC counter drop
    ether type arp jump boxes_arp
    ether type != ip counter drop
    ip saddr != $BOXES_IP counter drop
    # Replies to the brain (the boxes agent). A bare SYN would be the guest opening a connection.
    ip daddr $BRAIN_IP tcp sport 7071 tcp flags & (syn | ack) != syn accept
    ip daddr @blocked counter drop
    accept
  }

  chain boxes_arp {
    arp saddr ether != $BOXES_MAC counter drop
    arp saddr ip != $BOXES_IP counter drop
    accept
  }
}
EOF
  )
fi

# Filters frames at the desktop's port on the bridge, before they reach the LAN or the host.
# Stateless on purpose: bridge conntrack (nf_conntrack_bridge) could interfere with the Proxmox firewall.
# The interface name also matches when the NIC sits behind a Proxmox firewall bridge (fwbr), since that
# bridge forwards from the same veth.
write_file /etc/hatbot/host.nft 600 <<EOF
#!/usr/sbin/nft -f
# Managed by hatbot infra/host-setup.sh. Keeps $DESKTOP_NAME (CT $DESKTOP_ID) on the internet only.
table bridge hatbot
delete table bridge hatbot

table bridge hatbot {
  # Everything the desktop must never reach: private and special ranges (benchmarking, the TEST-NETs),
  # multicast, broadcast, this LAN, and your own public addresses if set (HATBOT_PUBLIC_IPS).
  set blocked {
    type ipv4_addr
    flags interval
    auto-merge
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
                 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24,
                 203.0.113.0/24, 224.0.0.0/3, $LAN_NET$PUBLIC_BLOCK }
  }

  # The bridge learns a frame's source MAC before forward or input see it, so a frame claiming another
  # machine's MAC is dropped here, or it would draw that machine's traffic to the desktop.
  chain desktop_prerouting {
    type filter hook prerouting priority filter - 5; policy accept;
    iifname "$DESKTOP_VETH" ether saddr != $DESKTOP_MAC counter drop
  }

  chain forward {
    type filter hook forward priority filter - 5; policy accept;
    iifname "$DESKTOP_VETH" jump from_desktop
  }

  # Frames for the host itself: only ARP, so the desktop can't open anything on the host.
  chain input {
    type filter hook input priority filter - 5; policy accept;
    iifname "$DESKTOP_VETH" ether type arp jump desktop_arp
    iifname "$DESKTOP_VETH" counter drop
  }

  chain from_desktop {
    ether saddr != $DESKTOP_MAC counter drop
    ether type arp jump desktop_arp
    ether type != ip counter drop
    ip saddr != $DESKTOP_IP counter drop
    # Replies to the brain (VNC, desktop-agent). A bare SYN would be the desktop opening a connection.
    ip daddr $BRAIN_IP tcp sport { 5901, 7070 } tcp flags & (syn | ack) != syn accept
    ip daddr @blocked counter drop
    accept
  }

  # No ARP spoofing: the desktop may only announce its own address.
  chain desktop_arp {
    arp saddr ether != $DESKTOP_MAC counter drop
    arp saddr ip != $DESKTOP_IP counter drop
    accept
  }
}$BOXES_TABLE
EOF

# No ExecStop: stopping the unit must not open the desktop up. Remove with 'nft delete table bridge hatbot'.
write_file /etc/systemd/system/hatbot-firewall.service 644 <<'EOF'
[Unit]
Description=Hatbot firewall (keeps hatbot-desktop and hatbot-boxes off the LAN)
Documentation=file:///etc/hatbot/host.nft
DefaultDependencies=no
Before=network-pre.target pve-guests.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/hatbot/host.nft
ExecReload=/usr/sbin/nft -f /etc/hatbot/host.nft

[Install]
WantedBy=multi-user.target
EOF
run systemctl daemon-reload
run systemctl enable hatbot-firewall.service
run systemctl restart hatbot-firewall.service
if ((!DRY_RUN)); then
  nft list table bridge hatbot >/dev/null 2>&1 || die "the firewall didn't load; the desktop stays off"
  [[ $(ct_mac "$DESKTOP_ID") == "$DESKTOP_MAC" ]] || die "CT $DESKTOP_ID's MAC isn't $DESKTOP_MAC; the firewall wouldn't match it"
  [[ -z $BOXES || $(ct_mac "$BOXES") == "$BOXES_MAC" ]] || die "CT $BOXES's MAC isn't $BOXES_MAC; the firewall wouldn't match it"
fi

for id in "$BRAIN_ID" "$DESKTOP_ID" ${BOXES:+"$BOXES"}; do
  if ((!DRY_RUN)) && guest_up "$id"; then ok "CT $id running"; else run pct start "$id"; fi
done
if ((!DRY_RUN)); then
  for id in "$BRAIN_ID" "$DESKTOP_ID" ${BOXES:+"$BOXES"}; do wait_ct "$id"; done
  ok "the containers have network and DNS"
fi

step "4/8 Proxmox API access ($TOKEN_ID)"
if pveum user list --output-format json | json_values userid | grep -qx "$PVE_USER"; then
  ok "user $PVE_USER exists"
else
  run pveum user add "$PVE_USER" --comment "Hatbot agent; API token only, no password"
fi

set_role() {
  if pveum role list --output-format json | json_values roleid | grep -qx "$1"; then
    run pveum role modify "$1" --privs "$2"
  else
    run pveum role add "$1" --privs "$2"
  fi
}
# Read and power control on every guest. No config, allocate or destroy rights anywhere.
set_role HatbotOps "VM.Audit,VM.PowerMgmt,Sys.Audit,Datastore.Audit"
# Snapshots only on Hatbot's own guests, granted through the pool.
set_role HatbotSnapshots "VM.Audit,VM.Snapshot,VM.Snapshot.Rollback"
run pveum acl modify / --users "$PVE_USER" --roles HatbotOps
run pveum acl modify "/pool/$POOL" --users "$PVE_USER" --roles HatbotSnapshots

have_token=0
pveum user token list "$PVE_USER" --output-format json 2>/dev/null | json_values tokenid | grep -qx "$TOKEN_NAME" && have_token=1
if ((have_token)) && guest_has_file "$BRAIN_ID" /etc/hatbot/proxmox.env; then
  ok "token exists and the brain has its secret"
else
  if ((have_token)); then
    confirm "Token $TOKEN_ID exists but the brain has no copy of its secret. Replace it?" || die "the brain needs the token secret"
    run pveum user token remove "$PVE_USER" "$TOKEN_NAME"
  fi
  if ((DRY_RUN)); then
    run pveum user token add "$PVE_USER" "$TOKEN_NAME" --privsep 1 --comment "$BRAIN_NAME"
    push_secret "$BRAIN_ID" /etc/hatbot/proxmox.env </dev/null
  else
    secret=$(pveum user token add "$PVE_USER" "$TOKEN_NAME" --privsep 1 --comment "$BRAIN_NAME" --output-format json |
      perl -MJSON::PP -e 'print decode_json(do { local $/; <STDIN> })->{value}')
    [[ -n $secret ]] || die "token creation returned no secret"
    cert=/etc/pve/local/pveproxy-ssl.pem
    [[ -f $cert ]] || cert=/etc/pve/local/pve-ssl.pem
    fingerprint=$(openssl x509 -in "$cert" -noout -fingerprint -sha256 | cut -d= -f2)
    push_secret "$BRAIN_ID" /etc/hatbot/proxmox.env <<EOF
PROXMOX_URL=https://$HOST_LAN_IP:8006
PROXMOX_NODE=$NODE
PROXMOX_TOKEN_ID=$TOKEN_ID
PROXMOX_TOKEN_SECRET=$secret
PROXMOX_TLS_FINGERPRINT=$fingerprint
HATBOT_POOL=$POOL
HATBOT_BRAIN_ID=$BRAIN_ID
HATBOT_DESKTOP_ID=$DESKTOP_ID
EOF
    unset secret
  fi
fi
# A privilege-separated token gets the intersection of its own ACLs and the user's.
run pveum acl modify / --tokens "$TOKEN_ID" --roles HatbotOps
run pveum acl modify "/pool/$POOL" --tokens "$TOKEN_ID" --roles HatbotSnapshots

step "5/8 Brain ↔ guest secrets"
if guest_has_file "$BRAIN_ID" /etc/hatbot/desktop.env && guest_has_file "$DESKTOP_ID" /etc/hatbot-desktop/secrets.env; then
  ok "both sides have them"
else
  agent_token=$(openssl rand -hex 32)
  vnc_password=$(openssl rand -hex 4) # VNC auth uses at most 8 characters; only the brain can reach the port
  push_secret "$BRAIN_ID" /etc/hatbot/desktop.env <<EOF
DESKTOP_AGENT_URL=http://$DESKTOP_IP:7070
DESKTOP_AGENT_TOKEN=$agent_token
DESKTOP_VNC=$DESKTOP_IP:5901
DESKTOP_VNC_PASSWORD=$vnc_password
EOF
  push_secret "$DESKTOP_ID" /etc/hatbot-desktop/secrets.env <<EOF
DESKTOP_AGENT_TOKEN=$agent_token
VNC_PASSWORD=$vnc_password
BRAIN_IP=$BRAIN_IP
EOF
  unset agent_token vnc_password
fi
# The boxes agent's token. Its URL changes with the guest's address, so a new address means a new pair.
if [[ -z $BOXES ]]; then
  info "no boxes guest"
elif guest_has_file "$BRAIN_ID" /etc/hatbot/boxes.env && guest_has_file "$BOXES" /etc/hatbox/secrets.env &&
  guest_exec "$BRAIN_ID" grep -qx "HATBOX_AGENT_URL=http://$BOXES_IP:7071" /etc/hatbot/boxes.env </dev/null; then
  ok "the brain and the boxes guest have theirs"
else
  hatbox_token=$(openssl rand -hex 32)
  push_secret "$BRAIN_ID" /etc/hatbot/boxes.env <<EOF
HATBOX_AGENT_URL=http://$BOXES_IP:7071
HATBOX_AGENT_TOKEN=$hatbox_token
EOF
  push_secret "$BOXES" /etc/hatbox/secrets.env <<EOF
HATBOX_AGENT_TOKEN=$hatbox_token
EOF
  unset hatbox_token
fi

step "6/8 Provision the containers"
provision() { # provision CTID SCRIPT ENV...
  local id=$1 script=$2
  shift 2
  if confirm "Run $script inside CT $id now? (installs packages, takes a few minutes)"; then
    run pct push "$id" "$HERE/$script" "/root/$script" --perms 700
    run pct exec "$id" -- env "$@" bash "/root/$script"
  else
    info "skipped; later: pct push $id $HERE/$script /root/$script && pct exec $id -- env $* bash /root/$script"
  fi
}
provision "$BRAIN_ID" brain-provision.sh "DESKTOP_IP=$DESKTOP_IP" "BOXES_IP=$BOXES_IP" \
  "DESKTOP_MAC=$DESKTOP_MAC" "BOXES_MAC=$BOXES_MAC"
provision "$DESKTOP_ID" desktop-provision.sh "DESKTOP_IP=$DESKTOP_IP" "BRAIN_IP=$BRAIN_IP" "HATBOT_PUBLIC_IPS=$HATBOT_PUBLIC_IPS"
[[ -z $BOXES ]] ||
  provision "$BOXES" boxes-provision.sh "BOXES_IP=$BOXES_IP" "BRAIN_IP=$BRAIN_IP" "HATBOT_PUBLIC_IPS=$HATBOT_PUBLIC_IPS"

step "7/8 Nightly snapshots"
if ((!SNAP_OK)); then
  warn "skipped: $SSD_STORE ($SSD_TYPE) can't snapshot containers"
else
  write_file /usr/local/sbin/hatbot-desktop-snapshot 755 <<'EOF'
#!/usr/bin/env bash
# Managed by hatbot infra/host-setup.sh. Snapshots a CT (the desktop, the boxes guest) and keeps the
# newest $KEEP nightlies.
set -euo pipefail
id=${1:?usage: hatbot-desktop-snapshot CTID}
keep=${KEEP:-7}
name="nightly_$(date +%Y%m%d)"
if ! pct listsnapshot "$id" | grep -qw "$name"; then
  pct snapshot "$id" "$name" --description "Hatbot nightly snapshot"
fi
pct listsnapshot "$id" | grep -o 'nightly_[0-9]\{8\}' | sort -u | head -n -"$keep" |
  while read -r old; do pct delsnapshot "$id" "$old"; done
EOF
  write_file /etc/systemd/system/hatbot-desktop-snapshot.service 644 <<EOF
[Unit]
Description=Hatbot: nightly snapshot of $DESKTOP_NAME (CT $DESKTOP_ID)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hatbot-desktop-snapshot $DESKTOP_ID
EOF
  write_file /etc/systemd/system/hatbot-desktop-snapshot.timer 644 <<'EOF'
[Unit]
Description=Hatbot: nightly desktop snapshot

[Timer]
OnCalendar=*-*-* 04:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  # The boxes guest holds the boxes' data, so it gets the same, half an hour later.
  if [[ -n $BOXES ]]; then
    write_file /etc/systemd/system/hatbot-boxes-snapshot.service 644 <<EOF
[Unit]
Description=Hatbot: nightly snapshot of $BOXES_NAME (CT $BOXES)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hatbot-desktop-snapshot $BOXES
EOF
    write_file /etc/systemd/system/hatbot-boxes-snapshot.timer 644 <<'EOF'
[Unit]
Description=Hatbot: nightly boxes guest snapshot

[Timer]
OnCalendar=*-*-* 04:30
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  fi
  run systemctl daemon-reload
  run systemctl enable --now hatbot-desktop-snapshot.timer
  [[ -z $BOXES ]] || run systemctl enable --now hatbot-boxes-snapshot.timer
fi

step "8/8 Backups (PBS)"
guests=("$BRAIN_ID" "$DESKTOP_ID" ${BOXES:+"$BOXES"})
what="both containers"
((${#guests[@]} == 2)) || what="all three containers"
mapfile -t jobs < <(backup_jobs "${guests[@]}")
covered=0
for j in "${jobs[@]}"; do
  # covers: a 1 or 0 per guest, tab-separated.
  IFS=$'\t' read -r jid enabled storage schedule sel covers <<<"$j"
  info "job $jid: storage $storage ($(store_type "$storage")), $schedule, $sel$([[ $enabled == 0 ]] && echo ', disabled')"
  [[ $enabled != 0 && -n $covers && $covers != *0* ]] && covered=1
done
if ((covered)); then
  ok "an enabled backup job already covers $what"
else
  mapfile -t candidates < <(printf '%s\n' "${jobs[@]}" | awk -F'\t' '$2 != 0 && $5 ~ /^vmid:/ { print $1 }')
  if ((${#candidates[@]})); then
    ask JOB "Add $what to which backup job? (empty = skip)" "${candidates[0]}"
    if [[ -n $JOB ]]; then
      cur=$(printf '%s\n' "${jobs[@]}" | awk -F'\t' -v j="$JOB" '$1 == j { sub(/^vmid:/, "", $5); print $5 }')
      [[ -n $cur ]] || die "job $JOB not found or doesn't select guests by VMID"
      new=$(printf '%s\n' "${cur//,/$'\n'}" "${guests[@]}" | sort -un | paste -sd,)
      confirm "Set job $JOB to back up: $new?" && run pvesh set "/cluster/backup/$JOB" --vmid "$new"
    fi
  else
    cts=$(printf 'CT %s, ' "${guests[@]}")
    warn "no backup job selects guests by VMID; add ${cts%, } to your PBS job in Datacenter → Backup"
  fi
fi

step "Done"
boxes_done=none
[[ -z $BOXES ]] || boxes_done="CT $BOXES   $BOXES_IP (internet only, for its agent)"
cat <<EOF
   Brain     CT $BRAIN_ID   $BRAIN_IP
   Desktop   CT $DESKTOP_ID   $DESKTOP_IP (internet only)
   Boxes     $boxes_done

   Next:
   1. Check isolation and permissions:   $HERE/verify.sh
   2. Install the app:   $HERE/deploy.sh <path to the hatbot checkout>   (see README.md)
   3. Reverse proxy:  your domain (e.g. hatbot.example.com) → http://$BRAIN_IP:8080 (with WebSockets)
   4. Before M4: add the brain's SSH key (/var/lib/hatbot/.ssh/id_ed25519.pub) to a "hatbot" user on hosts it may manage.
EOF
