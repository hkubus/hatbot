#!/bin/sh
# Builds the Linux app and installs it for you under ~/.local, or for everyone with
# PREFIX=/usr/local (it asks for sudo to copy the files, not to build).
set -eu
cd "$(dirname "$0")"
prefix="${PREFIX:-$HOME/.local}"

cargo build --release --locked

sudo=""
if ! { mkdir -p "$prefix" 2>/dev/null && [ -w "$prefix" ]; }; then
  sudo=sudo
fi
apps="$prefix/share/applications"
icons="$prefix/share/icons/hicolor"
$sudo install -Dm755 target/release/hatbot "$prefix/bin/hatbot"
$sudo install -Dm644 data/icons/ovh.gaycats.Hatbot.svg "$icons/scalable/apps/ovh.gaycats.Hatbot.svg"
# The full path, so the launcher finds it even when $prefix/bin isn't on PATH.
desktop=$(mktemp)
sed "s|^Exec=hatbot|Exec=$prefix/bin/hatbot|" data/ovh.gaycats.Hatbot.desktop >"$desktop"
$sudo install -Dm644 "$desktop" "$apps/ovh.gaycats.Hatbot.desktop"
rm -f "$desktop"
if command -v update-desktop-database >/dev/null; then $sudo update-desktop-database -q "$apps" || true; fi
# Only a cache that's there already: a new one would go stale and hide other apps' icons.
if [ -f "$icons/icon-theme.cache" ] && command -v gtk-update-icon-cache >/dev/null; then
  $sudo gtk-update-icon-cache -qt "$icons" || true
fi

echo "Installed Hatbot in $prefix. Open it from your app launcher, or run $prefix/bin/hatbot."
