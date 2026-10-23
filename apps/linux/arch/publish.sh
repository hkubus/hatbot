#!/bin/sh
# Builds the Arch package and puts it in Forgejo's pacman repository in place of the last one.
# CI runs it on Arch as a user that isn't root, with FORGEJO_TOKEN allowed to write packages.
set -eu
cd "$(dirname "$0")"
: "${FORGEJO_TOKEN:?Set FORGEJO_TOKEN to a Forgejo token that can write packages.}"
host=git.gaycats.ovh
forgejo="https://$host"
repo="$forgejo/api/packages/kubus/arch/hatbot"
arch=$(uname -m)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

ver=$(makepkg --printsrcinfo | sed -n 's/^\tpkgver = //p')

code=$(curl -sS --retry 5 -o "$work/repo.db" -w '%{http_code}' "$repo/$arch/hatbot.db")
case $code in
200)
  bsdtar -xOf "$work/repo.db" --include 'hatbot-*/desc' >"$work/desc"
  field() { awk -v f="%$1%" '$0 == f { on = 1; next } $0 == "" { on = 0 } on' "$work/desc"; }
  published=$(field VERSION)
  published_file=$(field FILENAME)
  ;;
404) published="" ;;
*)
  echo "Forgejo answered $code for the package database." >&2
  exit 1
  ;;
esac

rel=1
case $published in "$ver"-*) rel=$((${published##*-} + 1)) ;; esac

PKGDEST="$work" BUILDDIR="$work/build" HATBOT_PKGREL=$rel makepkg --noconfirm
pkg=$(echo "$work/hatbot-$ver-$rel-"*.pkg.tar.zst)

# A rebuild of the same commit goes out only when Arch's libraries moved under it.
if [ "$rel" -gt 1 ]; then
  needed() {
    bsdtar -xOf "$1" usr/bin/hatbot >"$work/bin"
    readelf -d "$work/bin" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | sort
  }
  curl -fsS --retry 5 -o "$work/published.pkg.tar.zst" "$repo/$arch/$published_file"
  if [ "$(needed "$work/published.pkg.tar.zst")" = "$(needed "$pkg")" ]; then
    echo "Hatbot $published is up to date."
    exit 0
  fi
fi

netrc="$work/netrc"
(umask 077 && printf 'machine %s login kubus password %s\n' "$host" "$FORGEJO_TOKEN" >"$netrc")
curl -fsS --retry 5 --netrc-file "$netrc" -X PUT -H 'Content-Type: application/octet-stream' \
  --data-binary "@$pkg" "$repo"
echo "Published Hatbot $ver-$rel."

curl -fsS --retry 5 --netrc-file "$netrc" "$forgejo/api/v1/packages/kubus?type=arch&q=hatbot&limit=50" |
  jq -r '.[] | select(.name == "hatbot") | .version' |
  while read -r old; do
    if [ "$old" != "$ver-$rel" ]; then
      curl -fsS --retry 5 --netrc-file "$netrc" -X DELETE "$repo/hatbot/$old/$arch"
      echo "Removed Hatbot $old."
    fi
  done
