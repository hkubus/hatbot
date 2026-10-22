# Shared helpers for the setup, deploy and check scripts. Sourced, not executed.
# Only uses tools that ship with Proxmox VE and Debian (bash, perl with JSON::PP, iproute2), plus ssh.
# shellcheck shell=bash

# shellcheck disable=SC2034 # the colours are used by the scripts that source this
if [[ -t 1 ]]; then
  bold=$'\e[1m' dim=$'\e[2m' red=$'\e[31m' grn=$'\e[32m' yel=$'\e[33m' rst=$'\e[0m'
else
  bold='' dim='' red='' grn='' yel='' rst=''
fi

step() { printf '\n%s== %s ==%s\n' "$bold" "$*" "$rst"; }
info() { printf '   %s\n' "$*"; }
ok() { printf '   %sok%s    %s\n' "$grn" "$rst" "$*"; }
warn() { printf '   %swarn%s  %s\n' "$yel" "$rst" "$*" >&2; }
die() {
  printf '%serror:%s %s\n' "$red" "$rst" "$*" >&2
  exit 1
}

# The brain, the desktop and the boxes guest are containers on this Proxmox host (host-setup.sh), reached
# with pct and named by VMID, or Debian machines (ssh-setup.sh), reached over SSH and named by user@host.
# HATBOT_TRANSPORT in host.env says which; installs from before it are Proxmox ones.

# The settings host-setup.sh or ssh-setup.sh saved: /etc/hatbot/host.env for root, otherwise in your
# own config directory, so ssh-setup.sh and deploy.sh can run from a laptop without root.
state_file() {
  if [[ -n ${HATBOT_STATE:-} ]]; then
    printf '%s\n' "$HATBOT_STATE"
  elif ((EUID == 0)); then
    printf '/etc/hatbot/host.env\n'
  else
    printf '%s/hatbot/host.env\n' "${XDG_CONFIG_HOME:-$HOME/.config}"
  fi
}

# load_state: sources host.env and sets BRAIN, DESKTOP and BOXES to what guest_exec takes. DESKTOP may be
# empty over SSH (a brain without a desktop), and BOXES on either (no boxes guest: installs from before
# it, or BOXES_ID=none / BOXES_SSH=none).
load_state() {
  local f
  f=$(state_file)
  # shellcheck source=/dev/null
  source "$f" 2>/dev/null || die "$f not found; run host-setup.sh (Proxmox) or ssh-setup.sh first"
  HATBOT_TRANSPORT=${HATBOT_TRANSPORT:-pct}
  case $HATBOT_TRANSPORT in
    pct)
      [[ $EUID -eq 0 ]] || die "run as root on the Proxmox host"
      BRAIN=${BRAIN_ID:?} DESKTOP=${DESKTOP_ID:?} BOXES=${BOXES_ID:-}
      [[ $BOXES != none ]] || BOXES=''
      ;;
    ssh) BRAIN=${BRAIN_SSH:?} DESKTOP=${DESKTOP_SSH:-} BOXES=${BOXES_SSH:-} ;;
    *) die "HATBOT_TRANSPORT in $f is $HATBOT_TRANSPORT; it should be pct or ssh" ;;
  esac
}

guest_label() {
  if [[ ${HATBOT_TRANSPORT:-pct} == ssh ]]; then printf '%s\n' "$1"; else printf 'CT %s\n' "$1"; fi
}

# guest_exec GUEST COMMAND [ARG...]: runs it as root in the guest, with this stdin. Over SSH as a user
# other than root, through sudo -n. Like pct exec, the arguments arrive as they are, unsplit.
guest_exec() {
  local g=$1
  shift
  if [[ ${HATBOT_TRANSPORT:-pct} != ssh ]]; then
    pct exec "$g" -- "$@"
    return
  fi
  local cmd='' a opts=(-o BatchMode=yes -o ConnectTimeout=10)
  # A terminal's typing belongs to the prompts, not to the remote command.
  [[ -t 0 ]] && opts+=(-n)
  [[ $g == root@* ]] || set -- sudo -n "$@"
  # sshd hands the command line to the login shell, which may be dash: plain single quotes, not %q.
  for a; do cmd+=" '${a//"'"/"'\\''"}'"; done
  # shellcheck disable=SC2029 # quoted above, for the remote shell
  ssh "${opts[@]}" "$g" "$cmd"
}

# guest_push GUEST SRC DEST MODE
guest_push() {
  if [[ ${HATBOT_TRANSPORT:-pct} != ssh ]]; then
    pct push "$1" "$2" "$3" --perms "$4"
    return
  fi
  # shellcheck disable=SC2016 # expands in the guest
  guest_exec "$1" sh -c 'umask 077 && cat >"$1.new" && chmod "$2" "$1.new" && mv -f "$1.new" "$1"' sh "$3" "$4" <"$2"
}

# push_secret GUEST PATH, content on stdin. Written mode 600; the secret never lands on this machine's
# disk outside a mktemp file.
push_secret() {
  local id=$1 path=$2 tmp
  if ((${DRY_RUN:-0})); then
    cat >/dev/null
    printf '   %s+ write secret %s in %s (mode 600)%s\n' "$dim" "$path" "$(guest_label "$id")" "$rst"
    return
  fi
  tmp=$(mktemp)
  cat >"$tmp"
  guest_exec "$id" install -d -m 750 "$(dirname "$path")"
  guest_push "$id" "$tmp" "$path" 600
  rm -f "$tmp"
  ok "wrote $path in $(guest_label "$id")"
}

# guest_up GUEST -> 0 if it's running (pct) or answers over SSH.
guest_up() {
  if [[ ${HATBOT_TRANSPORT:-pct} == ssh ]]; then
    guest_exec "$1" true </dev/null >/dev/null 2>&1
  else
    pct status "$1" 2>/dev/null | grep -q 'status: running'
  fi
}
guest_has_file() { ((!${DRY_RUN:-0})) && guest_exec "$1" test -s "$2" </dev/null 2>/dev/null; }

# Prints the values of KEY from a JSON array of objects (or a single object) on stdin.
json_values() {
  perl -MJSON::PP -e '
    my $d = decode_json(do { local $/; <STDIN> });
    $d = [$d] if ref $d eq "HASH";
    print "$_->{$ARGV[0]}\n" for grep { defined $_->{$ARGV[0]} } @$d;
  ' "$1"
}

# find_guest NAME -> "vmid type node" for every guest in the cluster with that name.
find_guest() {
  pvesh get /cluster/resources --type vm --output-format json | perl -MJSON::PP -e '
    my $d = decode_json(do { local $/; <STDIN> });
    for (@$d) { print "$_->{vmid} $_->{type} $_->{node}\n" if ($_->{name} // "") eq $ARGV[0] }
  ' "$1"
}

# vmid_used ID -> exit 0 if any guest in the cluster has that VMID.
vmid_used() {
  pvesh get /cluster/resources --type vm --output-format json | perl -MJSON::PP -e '
    my $d = decode_json(do { local $/; <STDIN> });
    exit((grep { ($_->{vmid} // 0) == $ARGV[0] } @$d) ? 0 : 1);
  ' "$1"
}

# cidr_net 192.168.55.113/24 -> 192.168.55.0/24
cidr_net() {
  perl -e '
    my ($ip, $len) = split m{/}, $ARGV[0];
    my $mask = $len ? (0xffffffff << (32 - $len)) & 0xffffffff : 0;
    my $net = unpack("N", pack("C4", split /\./, $ip)) & $mask;
    print join(".", unpack("C4", pack("N", $net))), "/$len\n";
  ' "$1"
}

# store_type NAME -> storage type (zfspool, lvmthin, dir, pbs, ...), empty if unknown.
store_type() { pvesm status 2>/dev/null | awk -v s="$1" 'NR > 1 && $1 == s { print $2 }'; }

# backup_jobs VMID... -> one tab-separated line per vzdump job, with a column per guest asked about:
#   id  enabled  storage  schedule  selection  covers_1  covers_2 ...
backup_jobs() {
  pvesh get /cluster/backup --output-format json | perl -MJSON::PP -e '
    my @guests = @ARGV;
    my $jobs = decode_json(do { local $/; <STDIN> });
    for my $j (@$jobs) {
      my %ex  = map { $_ => 1 } split /,/, ($j->{exclude} // "");
      my %ids = map { $_ => 1 } split /,/, ($j->{vmid} // "");
      my $sel = $j->{all} ? "all" : defined $j->{pool} ? "pool:$j->{pool}" : "vmid:" . ($j->{vmid} // "");
      my $covers = sub {
        my $id = shift;
        return $j->{all} ? !$ex{$id} : defined $j->{pool} ? $j->{pool} eq "hatbot" : $ids{$id};
      };
      print join("\t", $j->{id}, ($j->{enabled} // 1), ($j->{storage} // ""), ($j->{schedule} // ""), $sel,
        map { $covers->($_) ? 1 : 0 } @guests), "\n";
    }
  ' "$@"
}
