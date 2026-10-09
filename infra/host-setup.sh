#!/usr/bin/env bash
# Hatbot: one-time Proxmox host setup (PLAN.md §9.2).
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

# ---------- Settings ----------
BRIDGE=${BRIDGE:-vmbr77}                    # private bridge for brain + desktop
NET_PREFIX=${NET_PREFIX:-10.77.0}           # its /24
BRAIN_ID=${BRAIN_ID:-}
DESKTOP_ID=${DESKTOP_ID:-}
SSD_STORE=${SSD_STORE:-}                    # root disks
HDD_STORE=${HDD_STORE:-}                    # /archive on the brain
ARCHIVE_SIZE=${ARCHIVE_SIZE:-200}           # GiB, can be grown later
LAN_BRIDGE=${LAN_BRIDGE:-}                  # bridge for the brain's LAN NIC (default: the uplink)
BRAIN_LAN=${BRAIN_LAN:-dhcp}                # or "192.168.55.40/24,gw=192.168.55.1"
DNS=${DNS:-9.9.9.9 1.1.1.1}                 # the desktop's resolvers (it can't reach LAN DNS)
NTFY_BASE_URL=${NTFY_BASE_URL:-https://ntfy.gaycats.ovh}
FORCE=${FORCE:-0}                           # 1 = continue despite the RAM check

POOL=hatbot
PVE_USER=hatbot@pve
TOKEN_NAME=brain
TOKEN_ID="$PVE_USER!$TOKEN_NAME"
BRAIN_NAME=hatbot-brain
DESKTOP_NAME=hatbot-desktop
BRAIN_MEM=2048
BRAIN_SWAP=512
DESKTOP_MEM=1536
DESKTOP_SWAP=1024
HOST_PRIV_IP=$NET_PREFIX.1
BRAIN_PRIV_IP=$NET_PREFIX.10
DESKTOP_IP=$NET_PREFIX.20

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

# ---------- Helpers ----------
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

# push_secret CTID PATH, content on stdin. Written mode 600; the secret never lands on the host's disk outside a mktemp file.
push_secret() {
  local id=$1 path=$2 tmp
  if ((DRY_RUN)); then
    cat >/dev/null
    printf '   %s+ write secret %s in CT %s (mode 600)%s\n' "$dim" "$path" "$id" "$rst"
    return
  fi
  tmp=$(mktemp)
  cat >"$tmp"
  pct exec "$id" -- install -d -m 750 "$(dirname "$path")"
  pct push "$id" "$tmp" "$path" --perms 600
  rm -f "$tmp"
  ok "wrote $path in CT $id"
}

ct_running() { pct status "$1" 2>/dev/null | grep -q 'status: running'; }
ct_has_file() { ((!DRY_RUN)) && pct exec "$1" -- test -s "$2" 2>/dev/null; }

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
    for v in BRIDGE NET_PREFIX BRAIN_ID DESKTOP_ID SSD_STORE HDD_STORE ARCHIVE_SIZE LAN_BRIDGE BRAIN_LAN DNS NTFY_BASE_URL; do
      printf '%s=%q\n' "$v" "${!v}"
    done
  } >"$STATE"
  chmod 600 "$STATE"
}

((DRY_RUN)) && printf '%sDry run: nothing will be changed.%s\n' "$yel" "$rst"

# ---------- 1. Preflight (read-only) ----------
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
LAN_NET=$(cidr_net "$HOST_LAN_CIDR")
LAN_BRIDGE=${LAN_BRIDGE:-$UPLINK}
[[ -d /sys/class/net/$LAN_BRIDGE/bridge ]] || die "$LAN_BRIDGE is not a Linux bridge; set LAN_BRIDGE to the bridge the brain's LAN NIC should use"
ok "uplink $UPLINK, host $HOST_LAN_CIDR, LAN $LAN_NET, gateway $LAN_GW"

if ip -4 -o addr show | awk -v b="$BRIDGE" -v p="$NET_PREFIX." '$2 != b && index($4, p) == 1 { f = 1 } END { exit !f }'; then
  die "$NET_PREFIX.0/24 is already in use on this host; pick another with NET_PREFIX=10.x.y"
fi
[[ -e /etc/network/interfaces.new ]] && die "there are unapplied network changes (/etc/network/interfaces.new); apply or revert them in the GUI first"
if systemctl is-enabled --quiet nftables 2>/dev/null; then
  warn "nftables.service is enabled; if /etc/nftables.conf starts with 'flush ruleset' it removes Hatbot's rules at boot"
fi

# Reuse guests from an earlier run, matched by name.
read -r ex_brain_id ex_brain_type ex_brain_node < <(find_guest "$BRAIN_NAME") || true
read -r ex_desk_id ex_desk_type ex_desk_node < <(find_guest "$DESKTOP_NAME") || true
for g in "brain:${ex_brain_id:-}:${ex_brain_type:-}:${ex_brain_node:-}" "desktop:${ex_desk_id:-}:${ex_desk_type:-}:${ex_desk_node:-}"; do
  IFS=: read -r label id type node <<<"$g"
  [[ -z $id ]] && continue
  [[ $type == lxc && $node == "$NODE" ]] || die "a guest named hatbot-$label already exists ($type $id on $node); rename or remove it"
  ok "found existing hatbot-$label (CT $id)"
done
BRAIN_ID=${ex_brain_id:-$BRAIN_ID}
DESKTOP_ID=${ex_desk_id:-$DESKTOP_ID}
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

info "Storages that can hold container disks:"
pvesm status --content rootdir 2>/dev/null |
  awk 'NR > 1 && $3 == "active" { printf "       %-16s %-10s %6d GiB free\n", $1, $2, $6 / 1048576 }'
if [[ -z $SSD_STORE ]]; then
  def=$(pvesm status --content rootdir 2>/dev/null | awk 'NR > 1 && $3 == "active" && $2 ~ /zfspool|lvmthin/ { print $1; exit }')
  ask SSD_STORE "SSD storage for both root disks" "${def:-local-lvm}"
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
    warn "$SSD_STORE is $SSD_TYPE, which can't snapshot containers; nightly desktop snapshots will be skipped"
    ;;
esac
TMPL_STORE=$(pvesm status --content vztmpl 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1; exit }')
[[ -n $TMPL_STORE ]] || die "no storage accepts container templates (content type vztmpl)"
ok "root disks on $SSD_STORE ($SSD_TYPE), /archive on $HDD_STORE (${ARCHIVE_SIZE} GiB), templates on $TMPL_STORE"

need=0
[[ -z ${ex_brain_id:-} ]] && need=$((need + BRAIN_MEM))
[[ -z ${ex_desk_id:-} ]] && need=$((need + DESKTOP_MEM))
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

ask NTFY_BASE_URL "Public URL for ntfy" "$NTFY_BASE_URL"

cat <<EOF

   Plan:
     bridge   $BRIDGE  $HOST_PRIV_IP/24 (host), NAT to $UPLINK, LAN and host blocked for the desktop
     brain    CT $BRAIN_ID  $BRAIN_NAME    2 vCPU, $BRAIN_MEM MiB, 16 GiB on $SSD_STORE, /archive ${ARCHIVE_SIZE} GiB on $HDD_STORE
              eth0 $LAN_BRIDGE ($BRAIN_LAN), eth1 $BRIDGE $BRAIN_PRIV_IP
     desktop  CT $DESKTOP_ID  $DESKTOP_NAME  2 vCPU, $DESKTOP_MEM MiB + $DESKTOP_SWAP MiB swap, 16 GiB on $SSD_STORE
              eth0 $BRIDGE $DESKTOP_IP only, DNS $DNS
     access   user $PVE_USER, roles HatbotOps + HatbotSnapshots, token $TOKEN_ID
EOF
confirm "Continue?" || die "stopped"
save_state

# ---------- 2. Private network ----------
step "2/8 Private network $BRIDGE ($NET_PREFIX.0/24)"
if ip link show "$BRIDGE" >/dev/null 2>&1; then
  ok "$BRIDGE exists"
elif confirm "Create bridge $BRIDGE ($HOST_PRIV_IP/24, no physical ports)?"; then
  run pvesh create "/nodes/$NODE/network" --iface "$BRIDGE" --type bridge --cidr "$HOST_PRIV_IP/24" \
    --autostart 1 --comments "Hatbot private network (brain + desktop)"
  run pvesh set "/nodes/$NODE/network"
else
  die "the bridge is required"
fi

if [[ $(sysctl -n net.ipv4.ip_forward) == 1 ]]; then
  ok "IPv4 forwarding is on"
else
  write_file /etc/sysctl.d/90-hatbot.conf 644 <<<"net.ipv4.ip_forward = 1"
  run sysctl -q -p /etc/sysctl.d/90-hatbot.conf
fi

if ! command -v nft >/dev/null; then
  confirm "Install the nftables package (only the nft command; nftables.service stays disabled)?" || die "nft is required"
  run apt-get install -y --no-install-recommends nftables
  # Never start or stop nftables.service here: its config begins with 'flush ruleset', which would also
  # wipe the Proxmox firewall's rules. Hatbot loads its own table through hatbot-firewall.service.
  run systemctl disable nftables.service
fi

write_file /etc/hatbot/host.nft 600 <<EOF
#!/usr/sbin/nft -f
# Managed by hatbot infra/host-setup.sh. Keeps $DESKTOP_NAME on the internet only.
table inet hatbot
delete table inet hatbot

table inet hatbot {
  # Everything the desktop must never reach: private and special ranges, plus this LAN.
  set blocked {
    type ipv4_addr
    flags interval
    auto-merge
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
                 192.168.0.0/16, 224.0.0.0/3, $LAN_NET }
  }

  chain forward {
    type filter hook forward priority filter - 5; policy accept;
    iifname "$BRIDGE" ip daddr $NET_PREFIX.0/24 accept
    iifname "$BRIDGE" ip daddr @blocked counter drop
    iifname "$BRIDGE" meta nfproto ipv6 counter drop
  }

  # The desktop can't open connections to the host itself, on any of its addresses.
  chain input {
    type filter hook input priority filter - 5; policy accept;
    iifname "$BRIDGE" ct state established,related accept
    iifname "$BRIDGE" ip saddr $DESKTOP_IP counter drop
  }

  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr $NET_PREFIX.0/24 oifname "$UPLINK" masquerade
  }
}
EOF

write_file /etc/systemd/system/hatbot-firewall.service 644 <<'EOF'
[Unit]
Description=Hatbot firewall (desktop isolation and NAT)
Documentation=file:///etc/hatbot/host.nft
DefaultDependencies=no
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/hatbot/host.nft
ExecStop=/usr/sbin/nft delete table inet hatbot

[Install]
WantedBy=multi-user.target
EOF
run systemctl daemon-reload
run systemctl enable hatbot-firewall.service
run systemctl restart hatbot-firewall.service

# ---------- 3. Containers ----------
step "3/8 Containers"
if pveum pool list --output-format json | json_values poolid | grep -qx "$POOL"; then
  ok "pool $POOL exists"
else
  run pveum pool add "$POOL" --comment "Hatbot's own guests (it may snapshot these)"
fi

if [[ -z ${ex_brain_id:-} || -z ${ex_desk_id:-} ]]; then
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
  if [[ $BRAIN_LAN == dhcp ]]; then brain_ip=ip=dhcp; else brain_ip=ip=$BRAIN_LAN; fi
  run pct create "$BRAIN_ID" "$TMPL_VOL" --hostname "$BRAIN_NAME" \
    --description "Hatbot brain. Created by infra/host-setup.sh." \
    --unprivileged 1 --features nesting=1 --cores 2 --memory "$BRAIN_MEM" --swap "$BRAIN_SWAP" \
    --rootfs "$SSD_STORE:16" --mp0 "$HDD_STORE:$ARCHIVE_SIZE,mp=/archive,backup=1" \
    --net0 "name=eth0,bridge=$LAN_BRIDGE,$brain_ip" \
    --net1 "name=eth1,bridge=$BRIDGE,ip=$BRAIN_PRIV_IP/24" \
    --onboot 1 --startup order=10 --timezone host --pool "$POOL" --tags hatbot
fi

if [[ -n ${ex_desk_id:-} ]]; then
  ok "$DESKTOP_NAME exists (CT $DESKTOP_ID)"
else
  run pct create "$DESKTOP_ID" "$TMPL_VOL" --hostname "$DESKTOP_NAME" \
    --description "Hatbot desktop. Browses untrusted sites: internet only, no LAN, no secrets. Created by infra/host-setup.sh." \
    --unprivileged 1 --features nesting=1 --cores 2 --memory "$DESKTOP_MEM" --swap "$DESKTOP_SWAP" \
    --rootfs "$SSD_STORE:16" \
    --net0 "name=eth0,bridge=$BRIDGE,ip=$DESKTOP_IP/24,gw=$HOST_PRIV_IP" --nameserver "$DNS" \
    --onboot 1 --startup order=20 --timezone host --pool "$POOL" --tags hatbot
fi

for id in "$BRAIN_ID" "$DESKTOP_ID"; do
  if ((!DRY_RUN)) && ct_running "$id"; then ok "CT $id running"; else run pct start "$id"; fi
done
if ((!DRY_RUN)); then
  wait_ct "$BRAIN_ID"
  wait_ct "$DESKTOP_ID"
  ok "both containers have network and DNS"
fi

# ---------- 4. Proxmox API access ----------
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
# Read and power control on every guest. No config, allocate or destroy rights anywhere (PLAN.md §9.3).
set_role HatbotOps "VM.Audit,VM.PowerMgmt,Sys.Audit,Datastore.Audit"
# Snapshots only on Hatbot's own guests, granted through the pool.
set_role HatbotSnapshots "VM.Audit,VM.Snapshot,VM.Snapshot.Rollback"
run pveum acl modify / --users "$PVE_USER" --roles HatbotOps
run pveum acl modify "/pool/$POOL" --users "$PVE_USER" --roles HatbotSnapshots

have_token=0
pveum user token list "$PVE_USER" --output-format json 2>/dev/null | json_values tokenid | grep -qx "$TOKEN_NAME" && have_token=1
if ((have_token)) && ct_has_file "$BRAIN_ID" /etc/hatbot/proxmox.env; then
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

# ---------- 5. Brain <-> desktop secrets ----------
step "5/8 Brain ↔ desktop secrets"
if ct_has_file "$BRAIN_ID" /etc/hatbot/desktop.env && ct_has_file "$DESKTOP_ID" /etc/hatbot-desktop/secrets.env; then
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
BRAIN_IP=$BRAIN_PRIV_IP
EOF
  unset agent_token vnc_password
fi

# ---------- 6. Provision inside the containers ----------
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
provision "$BRAIN_ID" brain-provision.sh "NTFY_BASE_URL=$NTFY_BASE_URL" "DESKTOP_IP=$DESKTOP_IP"
provision "$DESKTOP_ID" desktop-provision.sh "DESKTOP_IP=$DESKTOP_IP" "BRAIN_IP=$BRAIN_PRIV_IP"

# ---------- 7. Nightly desktop snapshots ----------
step "7/8 Nightly desktop snapshots"
if ((!SNAP_OK)); then
  warn "skipped: $SSD_STORE ($SSD_TYPE) can't snapshot containers"
else
  write_file /usr/local/sbin/hatbot-desktop-snapshot 755 <<'EOF'
#!/usr/bin/env bash
# Managed by hatbot infra/host-setup.sh. Snapshots the desktop CT and keeps the newest $KEEP nightlies.
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
  run systemctl daemon-reload
  run systemctl enable --now hatbot-desktop-snapshot.timer
fi

# ---------- 8. Backups ----------
step "8/8 Backups (PBS)"
mapfile -t jobs < <(backup_jobs "$BRAIN_ID" "$DESKTOP_ID")
covered=0
for j in "${jobs[@]}"; do
  IFS=$'\t' read -r jid enabled storage schedule sel cb cd <<<"$j"
  info "job $jid: storage $storage ($(store_type "$storage")), $schedule, $sel$([[ $enabled == 0 ]] && echo ', disabled')"
  [[ $enabled != 0 && $cb == 1 && $cd == 1 ]] && covered=1
done
if ((covered)); then
  ok "an enabled backup job already covers both containers"
else
  mapfile -t candidates < <(printf '%s\n' "${jobs[@]}" | awk -F'\t' '$2 != 0 && $5 ~ /^vmid:/ { print $1 }')
  if ((${#candidates[@]})); then
    ask JOB "Add both containers to which backup job? (empty = skip)" "${candidates[0]}"
    if [[ -n $JOB ]]; then
      cur=$(printf '%s\n' "${jobs[@]}" | awk -F'\t' -v j="$JOB" '$1 == j { sub(/^vmid:/, "", $5); print $5 }')
      [[ -n $cur ]] || die "job $JOB not found or doesn't select guests by VMID"
      new=$(printf '%s\n' "${cur//,/$'\n'}" "$BRAIN_ID" "$DESKTOP_ID" | sort -un | paste -sd,)
      confirm "Set job $JOB to back up: $new?" && run pvesh set "/cluster/backup/$JOB" --vmid "$new"
    fi
  else
    warn "no backup job selects guests by VMID; add CT $BRAIN_ID and CT $DESKTOP_ID to your PBS job in Datacenter → Backup"
  fi
fi

# ---------- Done ----------
step "Done"
brain_lan_ip='<brain LAN IP>'
((DRY_RUN)) || brain_lan_ip=$(pct exec "$BRAIN_ID" -- ip -4 -o addr show dev eth0 | awk '{ print $4; exit }' | cut -d/ -f1)
ntfy_host=${NTFY_BASE_URL#*://}
cat <<EOF
   Brain     CT $BRAIN_ID   $brain_lan_ip (LAN), $BRAIN_PRIV_IP (private)
   Desktop   CT $DESKTOP_ID   $DESKTOP_IP (private, internet only)

   Next:
   1. Check isolation and permissions:   $HERE/verify.sh
   2. Reverse proxy:  hatbot.gaycats.ovh → http://$brain_lan_ip:8080 (with WebSockets)
                      ${ntfy_host%%/*} → http://$brain_lan_ip:8081
EOF
[[ $BRAIN_LAN == dhcp ]] && info "   The brain uses DHCP: give it a reservation so the proxy target doesn't move."
cat <<EOF
   3. ntfy iOS app: subscribe to topic "hatbot" on $NTFY_BASE_URL as user "phone"
      (the password is in /root/ntfy-phone-password.txt inside the brain).
   4. Before M4: add the brain's SSH key (/var/lib/hatbot/.ssh/id_ed25519.pub) to a "hatbot" user on hosts it may manage.
EOF
