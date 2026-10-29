#!/bin/sh
# Builds the Linux app and installs it for this user: the binary, its menu entry and icon, and the
# background service that starts with the graphical session.
set -eu
cd "$(dirname "$0")/.."
cargo build --release -p hatbot
install -Dm755 target/release/hatbot "$HOME/.local/bin/hatbot"
install -Dm644 packaging/ovh.gaycats.Hatbot.desktop "$HOME/.local/share/applications/ovh.gaycats.Hatbot.desktop"
install -Dm644 packaging/ovh.gaycats.Hatbot.svg "$HOME/.local/share/icons/hicolor/scalable/apps/ovh.gaycats.Hatbot.svg"
install -Dm644 packaging/hatbot.service "$HOME/.config/systemd/user/hatbot.service"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now hatbot.service
echo "Installed. Open Hatbot from your launcher, or run: hatbot"
