#!/usr/bin/env bash
# Hatbot: check the setup.
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
on_boxes() { guest_exec "$BOXES" "$@"; }
skip() { printf '   %sskip%s  %s\n' "$yel" "$rst" "$*"; }

if ((PVE)); then
  : "${BRAIN_IP:?}" "${SSD_STORE:?}"
  UPLINK=$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
  LAN_GW=$(ip -4 route show default | awk '{ print $3; exit }')
  HOST_LAN_IP=$(ip -4 -o addr show dev "$UPLINK" | awk '{ print $4; exit }' | cut -d/ -f1)
  if [[ -n $DESKTOP ]]; then
    : "${DESKTOP_IP:?}"
    DESKTOP_MAC=$(pct config "$DESKTOP" | sed -n 's#^net0:.*hwaddr=\([0-9A-Fa-f:]*\).*#\1#p' | tr 'A-F' 'a-f')
  fi
elif [[ -n $DESKTOP ]]; then
  : "${BRAIN_IP:?}" "${DESKTOP_IP:?}"
  LAN_GW=$(on_desktop ip -4 route show default </dev/null | awk '{ print $3; exit }')
fi
[[ -z $BOXES ]] || : "${BRAIN_IP:?}" "${BOXES_IP:?}"

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

# tcp_from host|brain|desktop|desk|boxes|hatbox IP PORT -> succeeds if a TCP connection opens within 4 s.
# desk is the desktop's browsing user, hatbox the boxes agent's; on Proxmox the host's firewall covers all
# of each guest, elsewhere only those users and the sandboxes.
tcp_from() {
  local who=$1 ip=$2 port=$3
  case $who in
    host) timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" 2>/dev/null ;;
    brain) on_brain timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" </dev/null 2>/dev/null ;;
    desktop) on_desktop timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" </dev/null 2>/dev/null ;;
    desk) on_desktop runuser -u desk -- timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" </dev/null 2>/dev/null ;;
    boxes) on_boxes timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" </dev/null 2>/dev/null ;;
    hatbox) on_boxes runuser -u hatbox -- timeout 4 bash -c "exec 3<>/dev/tcp/$ip/$port" </dev/null 2>/dev/null ;;
  esac
}
# What the firewall is meant to stop, and something it lets through to compare with.
if ((PVE)); then FROM=desktop OPEN_FROM=host; else FROM=desk OPEN_FROM=desktop; fi

# blocked "name" IP PORT...: the first port that's open from OPEN_FROM must be closed from FROM, which is
# the guest WHO names. (Probing from there first proves a refusal is the firewall, not a closed port.)
blocked() {
  local name=$1 ip=$2 port who=${WHO:-the desktop}
  shift 2
  for port in "$@"; do
    if tcp_from "$OPEN_FROM" "$ip" "$port"; then
      if tcp_from "$FROM" "$ip" "$port"; then
        result FAIL "$name" "$who reached $ip:$port"
      else
        result OK "$name ($ip:$port open from the $OPEN_FROM's root, closed to $who's programs)"
      fi
      return
    fi
  done
  printf '   %sskip%s  %s (nothing open on %s ports %s to compare against)\n' "$yel" "$rst" "$name" "$ip" "$*"
}

if ((PVE)); then
  step "Containers"
  expect "brain (CT $BRAIN_ID) is running, in pool hatbot" sh -c "pct status $BRAIN_ID | grep -q running &&
    pvesh get /pools/hatbot --output-format json | grep -q '\"vmid\":$BRAIN_ID'"
  if [[ -n $DESKTOP ]]; then
    expect "desktop (CT $DESKTOP) is running, in pool hatbot" sh -c "pct status $DESKTOP | grep -q running &&
      pvesh get /pools/hatbot --output-format json | grep -q '\"vmid\":$DESKTOP'"
  else
    skip "desktop (DESKTOP_ID=none)"
  fi
  if [[ -n $BOXES ]]; then
    expect "boxes guest (CT $BOXES) is running, in pool hatbot" sh -c "pct status $BOXES | grep -q running &&
      pvesh get /pools/hatbot --output-format json | grep -q '\"vmid\":$BOXES'"
  fi
else
  step "Machines"
  expect "the brain ($BRAIN) answers over SSH" guest_up "$BRAIN"
  if [[ -n $DESKTOP ]]; then
    expect "the desktop ($DESKTOP) answers over SSH" guest_up "$DESKTOP"
  else
    printf '   %sskip%s  desktop (ssh-setup.sh was given none)\n' "$yel" "$rst"
  fi
  [[ -z $BOXES ]] || expect "the boxes guest ($BOXES) answers over SSH" guest_up "$BOXES"
fi

if [[ -n $DESKTOP ]]; then
  step "Network isolation"
  if ((PVE)); then
    expect "firewall table bridge hatbot is loaded" nft list table bridge hatbot
    expect "hatbot-firewall.service is enabled" systemctl is-enabled --quiet hatbot-firewall.service
    expect "the firewall matches the desktop's port (veth${DESKTOP}i0) and MAC ($DESKTOP_MAC)" sh -c \
      "nft list table bridge hatbot | grep -q '\"veth${DESKTOP}i0\"' && nft list table bridge hatbot | grep -qi 'ether saddr != $DESKTOP_MAC'"
  else
    egress_loaded() { on_desktop nft list chain inet filter output </dev/null | grep -q skuid; }
    expect "the desktop's own firewall is loaded" egress_loaded
  fi
  expect "the desktop's programs reach the internet (https://deb.debian.org)" \
    on_desktop runuser -u desk -- curl -fsS -m 10 -o /dev/null https://deb.debian.org/
  ((PVE)) && blocked "desktop can't reach the Proxmox host" "$HOST_LAN_IP" 8006 22
  [[ -z $LAN_GW ]] || blocked "desktop can't reach the LAN gateway" "$LAN_GW" 443 80 53 22
  # Without Proxmox the brain's own firewall turns the whole desktop away, root too.
  if ((PVE)); then
    blocked "desktop can't open connections to the brain" "$BRAIN_IP" 8080 22
  else
    OPEN_FROM=brain FROM=desktop blocked "desktop can't open connections to the brain" "$BRAIN_IP" 8080 22
  fi
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
    expect "desktop has no IPv6 route out" sh -c "! pct exec $DESKTOP -- ip -6 route show default | grep -q ."
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
  if on_desktop test -e /etc/systemd/system/hatbot-desktop-agent.service </dev/null; then
    expect "Chromium is running (sandbox works in the container)" \
      on_desktop pgrep -u desk -f chrome-profile
    expect "Chromium's CDP answers on the desktop's localhost only" \
      on_desktop curl -fsS -m 5 -o /dev/null http://127.0.0.1:9222/json/version
  else
    printf '   %sskip%s  Chromium (not installed yet; deploy.sh installs it)\n' "$yel" "$rst"
  fi
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

step "Boxes guest"
if [[ -z $BOXES ]]; then
  skip "boxes guest (none set up; boxes are only pages)"
else
  # Like the desktop's: on Proxmox the host's firewall fences the whole guest, elsewhere its own output
  # chain fences the agent's user (the boxes and builds have no network at all).
  if ((PVE)); then
    BOXES_MAC=$(pct config "$BOXES" | sed -n 's#^net0:.*hwaddr=\([0-9A-Fa-f:]*\).*#\1#p' | tr 'A-F' 'a-f')
    expect "the firewall matches the boxes guest's port (veth${BOXES}i0) and MAC ($BOXES_MAC)" sh -c \
      "nft list table bridge hatbot | grep -q '\"veth${BOXES}i0\"' && nft list table bridge hatbot | grep -qi 'ether saddr != $BOXES_MAC'"
    FROM=boxes OPEN_FROM=host boxes_gw=$LAN_GW
  else
    boxes_egress() { on_boxes nft list chain inet filter output </dev/null | grep -q skuid; }
    expect "the boxes guest's own firewall is loaded" boxes_egress
    FROM=hatbox OPEN_FROM=boxes
    boxes_gw=$(on_boxes ip -4 route show default </dev/null | awk '{ print $3; exit }')
  fi
  WHO="the boxes guest"
  if on_boxes id -u hatbox </dev/null >/dev/null 2>&1; then
    expect "the boxes agent's user reaches the internet (https://deb.debian.org)" \
      on_boxes runuser -u hatbox -- curl -fsS -m 10 -o /dev/null https://deb.debian.org/
  else
    skip "the boxes agent's user (none yet; boxes-provision.sh makes it)"
  fi
  ((PVE)) && blocked "boxes guest can't reach the Proxmox host" "$HOST_LAN_IP" 8006 22
  [[ -z $boxes_gw ]] || blocked "boxes guest can't reach the LAN gateway" "$boxes_gw" 443 80 53 22
  if ((PVE)); then
    blocked "boxes guest can't open connections to the brain" "$BRAIN_IP" 8080 22
  else
    OPEN_FROM=brain FROM=boxes blocked "boxes guest can't open connections to the brain" "$BRAIN_IP" 8080 22
  fi
  unset WHO
  # shellcheck disable=SC2016 # expands inside the brain
  public_url=$(on_brain sh -c '. /etc/hatbot/brain.env 2>/dev/null && printf %s "$HATBOT_PUBLIC_URL"' </dev/null 2>/dev/null)
  if [[ -n $public_url ]] && on_boxes id -u hatbox </dev/null >/dev/null 2>&1; then
    if on_boxes runuser -u hatbox -- curl -sS -m 6 -o /dev/null "$public_url" </dev/null 2>/dev/null; then
      result FAIL "boxes guest can't reach the web app at $public_url" \
        "it did; add your public IP to HATBOT_PUBLIC_IPS in $(state_file) and re-run $( ((PVE)) && echo host-setup.sh || echo ssh-setup.sh)"
    else
      result OK "boxes guest can't reach the web app at $public_url"
    fi
  fi
  if ((PVE)); then
    expect "boxes guest has no IPv6 route out" sh -c "! pct exec $BOXES -- ip -6 route show default | grep -q ."
  else
    boxes_no_ipv6() { ! on_boxes runuser -u hatbox -- curl -6 -sS -m 6 -o /dev/null https://deb.debian.org/ </dev/null; }
    expect "the boxes agent's user can't use IPv6" boxes_no_ipv6
  fi
  # The agent connects to each box's socket in a sticky folder that the box's own user writes in. This is
  # what keeps it from following a link a box planted there to another box's socket. It's the kernel's
  # setting, so a container has its host's.
  links=$(on_boxes cat /proc/sys/fs/protected_symlinks </dev/null 2>/dev/null)
  if [[ $links == 1 ]]; then
    result OK "a box can't plant a link to another box's socket (fs.protected_symlinks is 1)"
  else
    where="on the boxes guest"
    ((PVE)) && where="on the Proxmox host, whose setting the containers share"
    result FAIL "a box can't plant a link to another box's socket" \
      "fs.protected_symlinks is ${links:-unreadable}; set it to 1 in /etc/sysctl.d/ $where"
  fi

  if on_boxes test -e /etc/systemd/system/hatbox-agent.service </dev/null; then
    expect "the boxes agent is active" on_boxes systemctl is-active --quiet hatbox-agent
    # shellcheck disable=SC2016 # expands inside the brain
    expect "the boxes agent answers the brain" on_brain sh -c \
      '. /etc/hatbot/boxes.env && printf "Authorization: Bearer %s\n" "$HATBOX_AGENT_TOKEN" | curl -fsS -m 5 -o /dev/null -H @- "$HATBOX_AGENT_URL/health"'
    expect "the polkit rule for the agent is in place" on_boxes test -s /etc/polkit-1/rules.d/50-hatbox.rules
    # What polkit answers for the agent's own process: a box's unit yes, any other unit no.
    agent_pid=$(on_boxes systemctl show -P MainPID hatbox-agent </dev/null 2>/dev/null)
    may() { # may UNIT VERB -> pkcheck's exit code for the agent
      on_boxes pkcheck --action-id org.freedesktop.systemd1.manage-units --process "$agent_pid" \
        --detail unit "$1" --detail verb "$2" </dev/null >/dev/null 2>&1
    }
    if [[ $agent_pid =~ ^[1-9][0-9]*$ ]] && on_boxes sh -c 'command -v pkcheck' </dev/null >/dev/null 2>&1; then
      expect "polkit lets the agent start a box (hatbox@0.service)" may hatbox@0.service start
      may ssh.service stop
      if [[ $? == 1 ]]; then
        result OK "polkit lets the agent run only boxes' units (refused: stop ssh.service)"
      else
        result FAIL "polkit lets the agent run only boxes' units" "it didn't refuse stopping ssh.service"
      fi
    else
      skip "polkit's answers for the agent (the agent isn't running, or there's no pkcheck)"
    fi
    # The units as systemd has them, so a drop-in that loosened one shows up here.
    prop() { on_boxes systemctl show -p "$2" --value "$1" </dev/null 2>/dev/null; }
    sealed() { # sealed UNIT MEMORYMAX -> its own user, no network, in hatbox.slice with that cap
      [[ $(prop "$1" DynamicUser) == yes && $(prop "$1" PrivateNetwork) == yes &&
        $(prop "$1" RestrictAddressFamilies) == AF_UNIX && $(prop "$1" Slice) == hatbox.slice &&
        $(prop "$1" MemoryMax) == "$2" ]]
    }
    expect "a box runs as its own user with no network, 128 MB in hatbox.slice (hatbox@0.service)" \
      sealed hatbox@0.service 134217728
    expect "a build runs as its own user with no network, 256 MB in hatbox.slice (hatbox-build@0.service)" \
      sealed hatbox-build@0.service 268435456
    slice_cap() { [[ $(prop hatbox.slice MemoryMax) == 402653184 ]]; }
    expect "boxes and builds get 384 MB together (hatbox.slice)" slice_cap
    # PrivateNetwork is quietly skipped where systemd can't make a namespace; a running box shows it took.
    running=$(on_boxes systemctl list-units --plain --no-legend --state=running 'hatbox@*.service' </dev/null 2>/dev/null |
      awk '{ print $1; exit }')
    if [[ -n $running ]]; then
      own_net() {
        # shellcheck disable=SC2016 # expands inside the boxes guest
        on_boxes sh -c 'pid=$(systemctl show -P MainPID "$1") && [ "$pid" -gt 0 ] &&
          [ "$(readlink "/proc/$pid/ns/net")" != "$(readlink /proc/1/ns/net)" ]' sh "$1"
      }
      expect "$running runs in a network namespace of its own" own_net "$running"
    else
      skip "a running box's network namespace (no box is running)"
    fi
  else
    skip "the boxes agent (not installed yet; deploy.sh installs it)"
  fi
  expect "the brain holds the boxes agent's token" on_brain test -s /etc/hatbot/boxes.env
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
  [[ -z $DESKTOP ]] || expect "the brain's token can list the desktop's snapshots" on_brain sh -c \
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
if [[ ! -e /usr/local/sbin/hatbot-desktop-snapshot ]]; then
  skip "nightly snapshots (storage $SSD_STORE cannot snapshot)"
else
  [[ -z $DESKTOP ]] ||
    expect "nightly desktop snapshot timer is enabled" systemctl is-enabled --quiet hatbot-desktop-snapshot.timer
  [[ -z $BOXES ]] ||
    expect "nightly boxes guest snapshot timer is enabled" systemctl is-enabled --quiet hatbot-boxes-snapshot.timer
fi
guests=("$BRAIN_ID" ${DESKTOP:+"$DESKTOP"} ${BOXES:+"$BOXES"})
counts=("the brain" "both containers" "all three containers")
what=${counts[${#guests[@]} - 1]}
covered=0
while IFS=$'\t' read -r jid enabled storage _ _ covers; do
  [[ $enabled != 0 && -n $covers && $covers != *0* ]] || continue
  covered=1
  info "backup job $jid → $storage ($(store_type "$storage"))"
done < <(backup_jobs "${guests[@]}")
expect "an enabled backup job covers $what" test "$covered" = 1
expect "/archive is included in backups" sh -c "pct config $BRAIN_ID | grep -E '^mp0:.*mp=/archive' | grep -qv 'backup=0'"

printf '\n   %d passed, %d failed\n' "$pass" "$fail"
((fail == 0))
