#!/usr/bin/env bash
# Hatbot: set up the brain and the desktop on two Debian 13 machines reached over SSH (PLAN.md §9.2), for
# when there's no Proxmox host. Any machines will do: VMs, Incus/LXD containers, cloud servers, spare
# boxes. Use fresh ones, since provisioning replaces their firewall rules. On Proxmox, host-setup.sh does
# more: the containers themselves, a firewall the desktop can't touch, snapshots and backups.
#
# Run from any machine whose SSH key both accept, as root@host or as a user with passwordless sudo:
#   ./ssh-setup.sh --dry-run   check the machines and show the plan, change nothing
#   ./ssh-setup.sh             ask before each change
#   ./ssh-setup.sh --yes       accept all defaults without asking
#
# Safe to re-run. Answers are saved to host.env (/etc/hatbot/ as root, otherwise ~/.config/hatbot/), which
# deploy.sh, verify.sh and reset-login.sh read. Any setting can be preset as an environment variable:
#   BRAIN_SSH, DESKTOP_SSH   user@host of each machine; DESKTOP_SSH=none for a brain without a desktop
#   BRAIN_IP, DESKTOP_IP     the addresses they reach each other on (default: asked of the machines)
#   HATBOT_PUBLIC_IPS        your public IPv4s, space-separated, which the desktop may not reach either
#   FORCE=1                  carry on past the checks for Debian 13 and for existing firewall rules

set -euo pipefail
umask 077

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

STATE=$(state_file)
# shellcheck source=/dev/null
[[ -r $STATE ]] && source "$STATE"
[[ ${HATBOT_TRANSPORT:-ssh} == ssh ]] || die "$STATE is from host-setup.sh; this Hatbot is on Proxmox"
HATBOT_TRANSPORT=ssh

BRAIN_SSH=${BRAIN_SSH:-}
DESKTOP_SSH=${DESKTOP_SSH:-}
BRAIN_IP=${BRAIN_IP:-}
DESKTOP_IP=${DESKTOP_IP:-}
HATBOT_PUBLIC_IPS=${HATBOT_PUBLIC_IPS:-}
FORCE=${FORCE:-0}

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case $arg in
    -n | --dry-run) DRY_RUN=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help)
      sed -n '2,19p' "$0"
      exit 0
      ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

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
confirm() {
  ((ASSUME_YES)) && return 0
  local ans=''
  read -r -p "   $1 [y/N] " ans || true
  [[ $ans == [yY]* ]]
}
# FORCE=1 turns a refusal into a warning.
refuse() { if ((FORCE)); then warn "$1; continuing because FORCE=1"; else die "$1. Set FORCE=1 to go ahead anyway."; fi; }
is_private() { [[ $1 =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; }

save_state() {
  ((DRY_RUN)) && return
  install -d -m 700 "$(dirname "$STATE")"
  {
    echo "# Written by hatbot infra/ssh-setup.sh; edit and re-run to change."
    local v
    for v in HATBOT_TRANSPORT BRAIN_SSH DESKTOP_SSH BRAIN_IP DESKTOP_IP HATBOT_PUBLIC_IPS; do
      printf '%s=%q\n' "$v" "${!v}"
    done
  } >"$STATE"
  chmod 600 "$STATE"
}

((DRY_RUN)) && printf '%sDry run: nothing will be changed.%s\n' "$yel" "$rst"

# ---------- 1. Preflight (read-only) ----------
step "1/4 Preflight"
command -v ssh >/dev/null || die "ssh not found"
[[ -n $BRAIN_SSH ]] || ask BRAIN_SSH "Brain: SSH address (user@host)" ""
[[ -n $BRAIN_SSH ]] || die "the brain's SSH address is needed"
[[ -n $DESKTOP_SSH ]] || ask DESKTOP_SSH "Desktop: SSH address (user@host; none: no desktop, so no desktop tasks or page watchers)" ""
[[ -n $DESKTOP_SSH && $DESKTOP_SSH != none ]] || DESKTOP_SSH=''
[[ $BRAIN_SSH == *@* && ( -z $DESKTOP_SSH || $DESKTOP_SSH == *@* ) ]] || die "give each machine as user@host"

# check_machine LABEL GUEST: reachable, root, Debian 13 with systemd, and no firewall of someone else's.
check_machine() {
  local label=$1 g=$2 os
  guest_exec "$g" true </dev/null >/dev/null 2>&1 ||
    die "can't run commands on $g over SSH as root (a key login as root, or a user with passwordless sudo)"
  [[ $(guest_exec "$g" id -u </dev/null) == 0 ]] || die "commands on $g don't run as root"
  # shellcheck disable=SC2016 # expands on the machine
  os=$(guest_exec "$g" sh -c '. /etc/os-release && echo "$ID $VERSION_ID"' </dev/null)
  [[ $os == "debian 13" ]] || refuse "$g runs $os; Hatbot's scripts are written for Debian 13"
  guest_exec "$g" test -d /run/systemd/system </dev/null || die "$g doesn't run systemd"
  # Provisioning writes /etc/nftables.conf, whose 'flush ruleset' drops every other rule on the machine:
  # Docker's, ufw's, firewalld's.
  # shellcheck disable=SC2016 # expands on the machine
  if guest_exec "$g" sh -c '! grep -qs "Managed by hatbot" /etc/nftables.conf &&
    { command -v docker || command -v ufw || command -v firewall-cmd ||
      { command -v nft && nft list ruleset | grep -q .; }; } >/dev/null 2>&1' </dev/null; then
    refuse "$g has firewall rules (or Docker, ufw or firewalld) that setting up the $label would wipe; use a fresh machine"
  fi
  ok "$label: $g, $os"
}
check_machine brain "$BRAIN_SSH"
if [[ -n $DESKTOP_SSH ]]; then
  check_machine desktop "$DESKTOP_SSH"
  [[ $(guest_exec "$BRAIN_SSH" cat /etc/machine-id </dev/null) != "$(guest_exec "$DESKTOP_SSH" cat /etc/machine-id </dev/null)" ]] ||
    die "$BRAIN_SSH and $DESKTOP_SSH are the same machine; the desktop browses untrusted sites, so it needs its own"
fi

# Addresses: the desktop's own, and the brain's as the desktop will see it.
if [[ -n $DESKTOP_SSH ]]; then
  if [[ -z $DESKTOP_IP ]]; then
    def=$(guest_exec "$DESKTOP_SSH" ip -4 route get 1.1.1.1 </dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
    ask DESKTOP_IP "The desktop's address, which the brain connects to" "$def"
  fi
  if [[ -z $BRAIN_IP ]]; then
    def=$(guest_exec "$BRAIN_SSH" ip -4 route get "$DESKTOP_IP" </dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
    ask BRAIN_IP "The brain's address, as the desktop sees it" "$def"
  fi
  for ip in "$BRAIN_IP" "$DESKTOP_IP"; do
    [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "$ip isn't an IPv4 address; set BRAIN_IP / DESKTOP_IP"
  done
  [[ $BRAIN_IP != "$DESKTOP_IP" ]] || die "the brain and the desktop need different addresses"
  guest_exec "$DESKTOP_SSH" ip -4 -o addr show </dev/null | grep -qF " $DESKTOP_IP/" ||
    die "$DESKTOP_IP isn't an address of $DESKTOP_SSH"
  # VNC and desktop-agent speak plain TCP: a password and a token, no TLS.
  is_private "$DESKTOP_IP" ||
    refuse "$DESKTOP_IP is a public address, and the brain talks to the desktop unencrypted; put both on a private network or a VPN (WireGuard, Tailscale)"
  ok "brain $BRAIN_IP, desktop $DESKTOP_IP"
fi
for ip in $HATBOT_PUBLIC_IPS; do
  [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] || die "HATBOT_PUBLIC_IPS: $ip isn't an IPv4 address"
done

desktop_plan="none: no desktop tasks, page watchers or live view"
[[ -z $DESKTOP_SSH ]] || desktop_plan="$DESKTOP_SSH ($DESKTOP_IP): Xvnc, XFCE, Chromium; only the brain may connect in, and its programs reach only the internet"
cat <<EOF

   Plan:
     brain    $BRAIN_SSH: Bun, the memory repo, an SSH key for your hosts${DESKTOP_IP:+; drops new connections from $DESKTOP_IP}
     desktop  $desktop_plan
     settings $STATE

   Without Proxmox, the desktop's firewall runs on the desktop itself: something that gets root there
   could lift it. On Proxmox it lives on the host instead.
EOF
if ((DRY_RUN)); then
  printf '\n%sDry run: nothing changed.%s\n' "$yel" "$rst"
  exit 0
fi
confirm "Continue?" || die "stopped"
save_state

# ---------- 2. Brain <-> desktop secrets ----------
step "2/4 Brain ↔ desktop secrets"
if [[ -z $DESKTOP_SSH ]]; then
  info "no desktop"
elif guest_has_file "$BRAIN_SSH" /etc/hatbot/desktop.env && guest_has_file "$DESKTOP_SSH" /etc/hatbot-desktop/secrets.env &&
  guest_exec "$BRAIN_SSH" grep -qx "DESKTOP_AGENT_URL=http://$DESKTOP_IP:7070" /etc/hatbot/desktop.env </dev/null; then
  ok "both sides have them"
else
  agent_token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  vnc_password=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n') # VNC auth uses at most 8 characters; only the brain can reach the port
  push_secret "$BRAIN_SSH" /etc/hatbot/desktop.env <<EOF
DESKTOP_AGENT_URL=http://$DESKTOP_IP:7070
DESKTOP_AGENT_TOKEN=$agent_token
DESKTOP_VNC=$DESKTOP_IP:5901
DESKTOP_VNC_PASSWORD=$vnc_password
EOF
  push_secret "$DESKTOP_SSH" /etc/hatbot-desktop/secrets.env <<EOF
DESKTOP_AGENT_TOKEN=$agent_token
VNC_PASSWORD=$vnc_password
BRAIN_IP=$BRAIN_IP
EOF
  unset agent_token vnc_password
fi

# ---------- 3. Provision ----------
step "3/4 Provision the machines"
provision() { # provision GUEST SCRIPT ENV...
  local g=$1 script=$2
  shift 2
  if confirm "Run $script on $g now? (installs packages, takes a few minutes)"; then
    guest_push "$g" "$HERE/$script" "/root/$script" 700
    guest_exec "$g" env "$@" bash "/root/$script" </dev/null
  else
    info "skipped; run ssh-setup.sh again to do it"
  fi
}
provision "$BRAIN_SSH" brain-provision.sh "DESKTOP_IP=$DESKTOP_IP"
[[ -z $DESKTOP_SSH ]] ||
  provision "$DESKTOP_SSH" desktop-provision.sh "DESKTOP_IP=$DESKTOP_IP" "BRAIN_IP=$BRAIN_IP" "HATBOT_PUBLIC_IPS=$HATBOT_PUBLIC_IPS"

# ---------- 4. Done ----------
step "4/4 Done"
cat <<EOF
   Brain     $BRAIN_SSH${BRAIN_IP:+   $BRAIN_IP}
   Desktop   ${DESKTOP_SSH:-none}${DESKTOP_IP:+   $DESKTOP_IP (internet only)}

   Next:
   1. Check the setup:   $HERE/verify.sh
   2. Install the app:   $HERE/deploy.sh <path to the hatbot checkout>   (see README.md)
   3. Reverse proxy:  your domain (e.g. hatbot.example.com) → http://<the brain's address>:8080 (with WebSockets)
   4. Back up the brain's /var/lib/hatbot and /archive; nothing here does that for you.
EOF
