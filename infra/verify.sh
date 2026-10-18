#!/usr/bin/env bash
# Hatbot: check the M0 setup (PLAN.md §11, M0 "done when").
# Run where you ran host-setup.sh (as root on the Proxmox host) or ssh-setup.sh. Changes nothing.
# Exit code 1 if any check fails.

set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"
load_state
PVE=0
[[ $HATBOT_TRANSPORT == pct ]] && PVE=1
on_brain() { guest_exec "$BRAIN" "$@"; }
on_desktop() { guest_exec "$DESKTOP" "$@"; }

if ((PVE)); then
  : "${BRAIN_IP:?}" "${DESKTOP_IP:?}" "${SSD_STORE:?}"
  UPLINK=$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
  LAN_GW=$(ip -4 route show default | awk '{ print $3; exit }')
  HOST_LAN_IP=$(ip -4 -o addr show dev "$UPLINK" | awk '{ print $4; exit }' | cut -d/ -f1)
  DESKTOP_MAC=$(pct config "$DESKTOP_ID" | sed -n 's#^net0:.*hwaddr=\([0-9A-Fa-f:]*\).*#\1#p' | tr 'A-F' 'a-f')
elif [[ -n $DESKTOP ]]; then
  : "${BRAIN_IP:?}" "${DESKTOP_IP:?}"
  LAN_GW=$(on_desktop ip -4 route show default </dev/null | awk '{ print $3; exit }')
fi

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

# tcp_from host|desktop|desk IP PORT -> succeeds if a TCP connection opens within 4 s. desk is the
# desktop's browsing user; on Proxmox the host's firewall covers all of the desktop, elsewhere only desk
# and the sandboxes.
tcp_from() {
  local who=$1 ip=$2 port=$3
  case $who in
    host) timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" 2>/dev/null ;;
    desktop) on_desktop timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" </dev/null 2>/dev/null ;;
    desk) on_desktop runuser -u desk -- timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" </dev/null 2>/dev/null ;;
  esac
}
# What the firewall is meant to stop, and something it lets through to compare with.
if ((PVE)); then FROM=desktop OPEN_FROM=host; else FROM=desk OPEN_FROM=desktop; fi

# blocked "name" IP PORT...: the first port that's open from OPEN_FROM must be closed from FROM.
# (Probing from there first proves a refusal is the firewall, not a closed port.)
blocked() {
  local name=$1 ip=$2 port
  shift 2
  for port in "$@"; do
    if tcp_from "$OPEN_FROM" "$ip" "$port"; then
      if tcp_from "$FROM" "$ip" "$port"; then
        result FAIL "$name" "the desktop reached $ip:$port"
      else
        result OK "$name ($ip:$port open from the $OPEN_FROM's root, closed to the desktop's programs)"
      fi
      return
    fi
  done
  printf '   %sskip%s  %s (nothing open on %s ports %s to compare against)\n' "$yel" "$rst" "$name" "$ip" "$*"
}

if ((PVE)); then
  step "Containers"
  expect "brain (CT $BRAIN_ID) is running" sh -c "pct status $BRAIN_ID | grep -q running"
  expect "desktop (CT $DESKTOP_ID) is running" sh -c "pct status $DESKTOP_ID | grep -q running"
  expect "both are in pool hatbot" sh -c "pveum pool list --output-format json | grep -q '\"poolid\":\"hatbot\"' &&
    pvesh get /pools/hatbot --output-format json | grep -q '\"vmid\":$BRAIN_ID' &&
    pvesh get /pools/hatbot --output-format json | grep -q '\"vmid\":$DESKTOP_ID'"
else
  step "Machines"
  expect "the brain ($BRAIN) answers over SSH" guest_up "$BRAIN"
  if [[ -n $DESKTOP ]]; then
    expect "the desktop ($DESKTOP) answers over SSH" guest_up "$DESKTOP"
  else
    printf '   %sskip%s  desktop (ssh-setup.sh was given none)\n' "$yel" "$rst"
  fi
fi

if [[ -n $DESKTOP ]]; then
  step "Network isolation"
  if ((PVE)); then
    expect "firewall table bridge hatbot is loaded" nft list table bridge hatbot
    expect "hatbot-firewall.service is enabled" systemctl is-enabled --quiet hatbot-firewall.service
    expect "the firewall matches the desktop's port (veth${DESKTOP_ID}i0) and MAC ($DESKTOP_MAC)" sh -c \
      "nft list table bridge hatbot | grep -q '\"veth${DESKTOP_ID}i0\"' && nft list table bridge hatbot | grep -qi 'ether saddr != $DESKTOP_MAC'"
  else
    egress_loaded() { on_desktop nft list chain inet filter output </dev/null | grep -q skuid; }
    expect "the desktop's own firewall is loaded" egress_loaded
  fi
  expect "the desktop's programs reach the internet (https://deb.debian.org)" \
    on_desktop runuser -u desk -- curl -fsS -m 10 -o /dev/null https://deb.debian.org/
  ((PVE)) && blocked "desktop can't reach the Proxmox host" "$HOST_LAN_IP" 8006 22
  [[ -z $LAN_GW ]] || blocked "desktop can't reach the LAN gateway" "$LAN_GW" 443 80 53 22
  blocked "desktop can't open connections to the brain" "$BRAIN_IP" 8080 22
  # The web app's public URL usually leads back into the LAN (a port forward on your router); the desktop
  # must not get there. HATBOT_PUBLIC_IPS in host.env blocks those addresses.
  # shellcheck disable=SC2016 # expands inside the brain
  public_url=$(on_brain sh -c '. /etc/hatbot/brain.env 2>/dev/null && printf %s "$HATBOT_PUBLIC_URL"' </dev/null 2>/dev/null)
  if [[ -n $public_url ]]; then
    if on_desktop runuser -u desk -- curl -sS -m 6 -o /dev/null "$public_url" </dev/null 2>/dev/null; then
      result FAIL "desktop can't reach the web app at $public_url" \
        "it did; add your public IP to HATBOT_PUBLIC_IPS in $(state_file) and re-run $( ((PVE)) && echo host-setup.sh || echo ssh-setup.sh)"
    else
      result OK "desktop can't reach the web app at $public_url"
    fi
  else
    printf '   %sskip%s  desktop and the web app (no public URL yet; deploy.sh asks for it)\n' "$yel" "$rst"
  fi
  if ((PVE)); then
    expect "desktop has no IPv6 route out" sh -c "! pct exec $DESKTOP_ID -- ip -6 route show default | grep -q ."
  else
    no_ipv6() { ! on_desktop runuser -u desk -- curl -6 -sS -m 6 -o /dev/null https://deb.debian.org/ </dev/null; }
    expect "the desktop's programs can't use IPv6" no_ipv6
  fi
fi

step "Brain ↔ desktop"
if [[ -n $DESKTOP ]]; then
  vnc_answers() { on_brain timeout 5 bash -c "exec 3<>/dev/tcp/$DESKTOP_IP/5901; head -c 3 <&3" </dev/null | grep -q RFB; }
  expect "brain reaches the desktop's VNC (RFB handshake on $DESKTOP_IP:5901)" vnc_answers
  expect "Xvnc and the XFCE session are active" \
    on_desktop systemctl is-active --quiet hatbot-xvnc hatbot-session
  expect "Chromium is running (sandbox works in the container)" \
    on_desktop pgrep -u desk -f chrome-profile
  expect "Chromium's CDP answers on the desktop's localhost only" \
    on_desktop curl -fsS -m 5 -o /dev/null http://127.0.0.1:9222/json/version
  # shell_exec COMMAND -> the JSON answer of the desktop's shell (desktop_shell), which runs it as its own user.
  shell_exec() {
    on_desktop curl -sS -m 20 --unix-socket /run/hatbot-shell/shell.sock \
      -H 'content-type: application/json' --data-binary @- http://shell/exec 2>/dev/null <<<"{\"command\": \"$1\", \"timeoutS\": 8}"
  }
  # own_ipc UNIT -> succeeds if the unit's process has its own IPC namespace (PrivateIPC), apart from desk's
  # services, so the X shared memory that ffmpeg's screen grabs leave readable to everyone isn't there.
  own_ipc() {
    # shellcheck disable=SC2016 # expands inside the desktop
    on_desktop sh -c 'pid=$(systemctl show -P MainPID "$1") && [ "$pid" -gt 0 ] &&
      [ "$(readlink "/proc/$pid/ns/ipc")" != "$(readlink /proc/1/ns/ipc)" ]' sh "$1"
  }
  if on_desktop test -S /run/hatbot-shell/shell.sock; then
    for probe in "Chromium's DevTools (127.0.0.1:9222)|exec 3<>/dev/tcp/127.0.0.1/9222" \
      "desktop-agent ($DESKTOP_IP:7070)|exec 3<>/dev/tcp/$DESKTOP_IP/7070" \
      "the screen (:1)|DISPLAY=:1 xdotool getdisplaygeometry" \
      "the renderer's socket|cd /run/hatbot-render"; do
      out=$(shell_exec "${probe#*|}")
      if [[ -z $out ]]; then
        result FAIL "the desktop shell answers" "no reply on /run/hatbot-shell/shell.sock"
      elif grep -q '"exitCode":0' <<<"$out"; then
        result FAIL "the desktop shell can't reach ${probe%%|*}" "it did; run deploy.sh"
      else
        result OK "the desktop shell can't reach ${probe%%|*}"
      fi
    done
    # shellcheck disable=SC2016 # expands inside the desktop
    expect "only desktop-agent's user reaches the shell's socket" \
      on_desktop sh -c '[ "$(stat -c "%a %G" /run/hatbot-shell)" = "750 desk" ]'
    expect "the desktop shell can't attach desk's shared memory (the screen grabs)" own_ipc hatbot-desktop-shell
  else
    printf '   %sskip%s  desktop shell (not running; deploy.sh installs it)\n' "$yel" "$rst"
  fi
  # The renderer's Chromium loads whatever a page asks for; only the loopback rule keeps it off DevTools.
  if on_desktop test -S /run/hatbot-render/render.sock; then
    # shellcheck disable=SC2016 # expands inside the desktop
    uid=$(on_desktop sh -c 'ps -o uid= -p "$(systemctl show -P MainPID hatbot-render)"' 2>/dev/null | tr -d ' ')
    if [[ $uid =~ ^[0-9]+$ ]] && ((uid >= 61184 && uid <= 65519)); then
      result OK "the renderer runs as a user the loopback rule covers (uid $uid)"
    else
      result FAIL "the renderer runs as a user the loopback rule covers" "uid ${uid:-unknown}"
    fi
    renders() { on_desktop curl -sS -m 30 -X POST --unix-socket /run/hatbot-render/render.sock http://render/check </dev/null | grep -q '"ok":true'; }
    expect "the renderer runs a page's scripts" renders
    # shellcheck disable=SC2016 # expands inside the desktop
    expect "only desktop-agent's user reaches the renderer's socket" \
      on_desktop sh -c '[ "$(stat -c "%a %G" /run/hatbot-render)" = "750 desk" ]'
    expect "the renderer can't attach desk's shared memory (the screen grabs)" own_ipc hatbot-render
  else
    printf '   %sskip%s  renderer (not running; deploy.sh installs it)\n' "$yel" "$rst"
  fi
  if on_desktop test -e /etc/systemd/system/hatbot-desktop-agent.service; then
    # shellcheck disable=SC2016 # expands inside the brain
    expect "desktop-agent answers the brain" on_brain sh -c \
      '. /etc/hatbot/desktop.env && printf "Authorization: Bearer %s\n" "$DESKTOP_AGENT_TOKEN" | curl -fsS -m 5 -o /dev/null -H @- "$DESKTOP_AGENT_URL/health"'
  else
    printf '   %sskip%s  desktop-agent (not installed yet; deploy.sh installs it)\n' "$yel" "$rst"
  fi
  expect "the brain holds the desktop secrets" on_brain test -s /etc/hatbot/desktop.env
else
  printf '   %sskip%s  desktop (ssh-setup.sh was given none)\n' "$yel" "$rst"
fi

step "Brain"
if on_brain grep -qs '^NTFY_URL=http' /etc/hatbot/ntfy.env; then
  # shellcheck disable=SC2016 # expands inside the brain
  expect "the brain reaches your ntfy server" on_brain sh -c \
    '. /etc/hatbot/ntfy.env && curl -fsS -m 5 -o /dev/null "$NTFY_URL/v1/health"'
else
  printf '   %sskip%s  ntfy (not configured yet; deploy.sh asks for it)\n' "$yel" "$rst"
fi
expect "the memory repo exists" on_brain test -d /var/lib/hatbot/memory/.git

if ((PVE)); then
  expect "the brain holds the Proxmox token" on_brain test -s /etc/hatbot/proxmox.env
  # "Roll back desktop" lists snapshots with this token (the brain pins the certificate itself).
  # shellcheck disable=SC2016 # expands inside the brain
  expect "the brain's token can list the desktop's snapshots" on_brain sh -c \
    '. /etc/hatbot/proxmox.env && printf "Authorization: PVEAPIToken=%s=%s\n" "$PROXMOX_TOKEN_ID" "$PROXMOX_TOKEN_SECRET" | curl -fsSk -m 5 -o /dev/null -H @- "$PROXMOX_URL/api2/json/nodes/$PROXMOX_NODE/lxc/$HATBOT_DESKTOP_ID/snapshot"'
fi

if ((!PVE)); then
  printf '\n   %d passed, %d failed\n' "$pass" "$fail"
  ((fail == 0))
  exit
fi

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
