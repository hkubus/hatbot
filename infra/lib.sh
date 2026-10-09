# Shared helpers for host-setup.sh, verify.sh and deploy.sh. Sourced, not executed.
# Only uses tools that ship with Proxmox VE (bash, perl with JSON::PP, iproute2).
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

# push_secret CTID PATH, content on stdin. Written mode 600; the secret never lands on the host's disk outside a mktemp file.
push_secret() {
  local id=$1 path=$2 tmp
  if ((${DRY_RUN:-0})); then
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
ct_has_file() { ((!${DRY_RUN:-0})) && pct exec "$1" -- test -s "$2" 2>/dev/null; }

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

# backup_jobs BRAIN_ID DESKTOP_ID -> one tab-separated line per vzdump job:
#   id  enabled  storage  schedule  selection  covers_brain  covers_desktop
backup_jobs() {
  pvesh get /cluster/backup --output-format json | perl -MJSON::PP -e '
    my ($b, $d) = @ARGV;
    my $jobs = decode_json(do { local $/; <STDIN> });
    for my $j (@$jobs) {
      my %ex  = map { $_ => 1 } split /,/, ($j->{exclude} // "");
      my %ids = map { $_ => 1 } split /,/, ($j->{vmid} // "");
      my $sel = $j->{all} ? "all" : defined $j->{pool} ? "pool:$j->{pool}" : "vmid:" . ($j->{vmid} // "");
      my $covers = sub {
        my $id = shift;
        return $j->{all} ? !$ex{$id} : defined $j->{pool} ? $j->{pool} eq "hatbot" : $ids{$id};
      };
      printf "%s\t%s\t%s\t%s\t%s\t%d\t%d\n", $j->{id}, ($j->{enabled} // 1), ($j->{storage} // ""),
        ($j->{schedule} // ""), $sel, ($covers->($b) ? 1 : 0), ($covers->($d) ? 1 : 0);
    }
  ' "$1" "$2"
}
