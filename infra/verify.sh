#!/usr/bin/env bash
# Hatbot: check the M0 setup (PLAN.md §11, M0 "done when").
# Run as root on the Proxmox host after host-setup.sh. Changes nothing. Exit code 1 if any check fails.

set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"
# shellcheck source=/dev/null
source /etc/hatbot/host.env 2>/dev/null || die "/etc/hatbot/host.env not found; run host-setup.sh first"
: "${NET_PREFIX:?}" "${BRAIN_ID:?}" "${DESKTOP_ID:?}" "${SSD_STORE:?}"

BRAIN_PRIV_IP=$NET_PREFIX.10
DESKTOP_IP=$NET_PREFIX.20
HOST_PRIV_IP=$NET_PREFIX.1
UPLINK=$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
LAN_GW=$(ip -4 route show default | awk '{ print $3; exit }')
HOST_LAN_IP=$(ip -4 -o addr show dev "$UPLINK" | awk '{ print $4; exit }' | cut -d/ -f1)
BRAIN_LAN_IP=$(pct exec "$BRAIN_ID" -- ip -4 -o addr show dev eth0 2>/dev/null | awk '{ print $4; exit }' | cut -d/ -f1)

pass=0
fail=0
result() { # result OK|FAIL "name" [detail]
  if [[ $1 == OK ]]; then
    printf '   %sok%s    %s\n' "$grn" "$rst" "$2"
    pass=$((pass + 1))
  else
    printf '   %sFAIL%s  %s%s\n' "$red" "$rst" "$2" "${3:+ ($3)}"
    fail=$((fail + 1))
  fi
}
expect() { # expect "name" command...  -> passes if the command succeeds
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then result OK "$name"; else result FAIL "$name"; fi
}

# tcp_from CTID|host IP PORT -> succeeds if a TCP connection opens within 4 s.
tcp_from() {
  local who=$1 ip=$2 port=$3
  if [[ $who == host ]]; then
    timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" 2>/dev/null
  else
    pct exec "$who" -- timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" 2>/dev/null
  fi
}

# blocked "name" IP PORT...: the first port that's open from the host must be closed from the desktop.
# (Probing from the host first proves a refusal from the desktop is the firewall, not a closed port.)
blocked() {
  local name=$1 ip=$2 port
  shift 2
  for port in "$@"; do
    if tcp_from host "$ip" "$port"; then
      if tcp_from "$DESKTOP_ID" "$ip" "$port"; then
        result FAIL "$name" "desktop reached $ip:$port"
      else
        result OK "$name ($ip:$port open from the host, closed from the desktop)"
      fi
      return
    fi
  done
  printf '   %sskip%s  %s (nothing open on %s ports %s to compare against)\n' "$yel" "$rst" "$name" "$ip" "$*"
}

step "Containers"
expect "brain (CT $BRAIN_ID) is running" sh -c "pct status $BRAIN_ID | grep -q running"
expect "desktop (CT $DESKTOP_ID) is running" sh -c "pct status $DESKTOP_ID | grep -q running"
expect "both are in pool hatbot" sh -c "pveum pool list --output-format json | grep -q '\"poolid\":\"hatbot\"' &&
  pvesh get /pools/hatbot --output-format json | grep -q '\"vmid\":$BRAIN_ID' &&
  pvesh get /pools/hatbot --output-format json | grep -q '\"vmid\":$DESKTOP_ID'"

step "Network isolation"
expect "firewall table inet hatbot is loaded" nft list table inet hatbot
expect "hatbot-firewall.service is enabled" systemctl is-enabled --quiet hatbot-firewall.service
expect "desktop reaches the internet (https://deb.debian.org)" \
  pct exec "$DESKTOP_ID" -- curl -fsS -m 10 -o /dev/null https://deb.debian.org/
blocked "desktop can't reach the Proxmox host on the LAN" "$HOST_LAN_IP" 8006 22
blocked "desktop can't reach the Proxmox host on the private bridge" "$HOST_PRIV_IP" 8006 22
blocked "desktop can't reach the LAN gateway" "$LAN_GW" 443 80 53 22
[[ -n $BRAIN_LAN_IP ]] && blocked "desktop can't reach the brain's LAN address" "$BRAIN_LAN_IP" 8081 22
blocked "desktop can't open connections to the brain's private address" "$BRAIN_PRIV_IP" 8081 22
expect "desktop has no IPv6 route out" sh -c "! pct exec $DESKTOP_ID -- ip -6 route show default | grep -q ."

step "Brain ↔ desktop"
expect "brain reaches the desktop's VNC (RFB handshake on $DESKTOP_IP:5901)" sh -c \
  "pct exec $BRAIN_ID -- timeout 5 bash -c 'exec 3<>/dev/tcp/$DESKTOP_IP/5901; head -c 3 <&3' | grep -q RFB"
expect "Xvnc and the XFCE session are active" \
  pct exec "$DESKTOP_ID" -- systemctl is-active --quiet hatbot-xvnc hatbot-session
expect "Chromium is running (sandbox works in the container)" \
  pct exec "$DESKTOP_ID" -- pgrep -u desk -f chrome-profile
expect "Chromium's CDP answers on the desktop's localhost only" \
  pct exec "$DESKTOP_ID" -- curl -fsS -m 5 -o /dev/null http://127.0.0.1:9222/json/version
expect "ntfy is running on the brain" pct exec "$BRAIN_ID" -- systemctl is-active --quiet ntfy
expect "the brain holds the Proxmox token" pct exec "$BRAIN_ID" -- test -s /etc/hatbot/proxmox.env
expect "the brain holds the desktop secrets" pct exec "$BRAIN_ID" -- test -s /etc/hatbot/desktop.env
expect "the memory repo exists" pct exec "$BRAIN_ID" -- test -d /var/lib/hatbot/memory/.git

step "Token permissions (hatbot@pve!brain)"
perms=$(pveum user token permissions hatbot@pve brain --output-format json 2>/dev/null)
if [[ -z $perms ]]; then
  result FAIL "read the token's effective permissions"
else
  report=$(perl -MJSON::PP -e '
    my $p = decode_json($ARGV[0]);
    my $has = sub { my ($path, $priv) = @_; $p->{$path} && exists $p->{$path}{$priv} };
    my @bad;
    for my $path (sort keys %$p) {
      for my $priv (sort keys %{ $p->{$path} }) {
        push @bad, "$priv on $path"
          if $priv =~ /^(VM\.(Config|Allocate|Migrate|Clone|Console|Backup|Monitor)|Sys\.(Modify|PowerMgmt|Console|Incoming)|Datastore\.(Allocate|AllocateSpace|AllocateTemplate)|Permissions\.Modify|Pool\.Allocate|User\.Modify|Realm\.|Group\.|SDN\.(Allocate|Use)|Mapping\.(Modify|Use))/;
      }
    }
    print "power:",    ($has->("/", "VM.PowerMgmt") || $has->("/vms", "VM.PowerMgmt")) ? 1 : 0, "\n";
    print "audit:",    ($has->("/", "VM.Audit") && $has->("/", "Sys.Audit")) ? 1 : 0, "\n";
    print "snapshot:", ($has->("/pool/hatbot", "VM.Snapshot") && $has->("/pool/hatbot", "VM.Snapshot.Rollback")) ? 1 : 0, "\n";
    print "bad:", join(", ", @bad), "\n";
  ' "$perms")
  expect "can start/stop/restart guests" grep -qx power:1 <<<"$report"
  expect "can read guest and node status" grep -qx audit:1 <<<"$report"
  expect "can snapshot and roll back its own guests" grep -qx snapshot:1 <<<"$report"
  bad=$(sed -n 's/^bad://p' <<<"$report")
  if [[ -z $bad ]]; then
    result OK "has no config, allocate, console or admin rights"
  else
    result FAIL "has rights it shouldn't" "$bad"
  fi

  other=$(pvesh get /cluster/resources --type vm --output-format json | perl -MJSON::PP -e '
    my $d = decode_json(do { local $/; <STDIN> });
    for (@$d) { if (($_->{pool} // "") ne "hatbot") { print $_->{vmid}; last } }')
  if [[ -n $other ]]; then
    if pveum user token permissions hatbot@pve brain --path "/vms/$other" --output-format json 2>/dev/null | grep -q 'VM.Snapshot'; then
      result FAIL "can't snapshot guests outside the pool" "has VM.Snapshot on /vms/$other"
    else
      result OK "can't snapshot guests outside the pool (checked /vms/$other)"
    fi
  fi
fi

step "Snapshots and backups"
if [[ -e /etc/systemd/system/hatbot-desktop-snapshot.timer ]]; then
  expect "nightly desktop snapshot timer is enabled" systemctl is-enabled --quiet hatbot-desktop-snapshot.timer
else
  printf '   %sskip%s  nightly snapshots (storage %s cannot snapshot)\n' "$yel" "$rst" "$SSD_STORE"
fi
covered=0
while IFS=$'\t' read -r jid enabled storage _ _ cb cd; do
  [[ $enabled != 0 && $cb == 1 && $cd == 1 ]] || continue
  covered=1
  info "backup job $jid → $storage ($(store_type "$storage"))"
done < <(backup_jobs "$BRAIN_ID" "$DESKTOP_ID")
expect "an enabled backup job covers both containers" test "$covered" = 1
expect "/archive is included in backups" sh -c "pct config $BRAIN_ID | grep -E '^mp0:.*mp=/archive' | grep -qv 'backup=0'"

printf '\n   %d passed, %d failed\n' "$pass" "$fail"
((fail == 0))
