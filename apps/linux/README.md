# Hatbot for Linux

A native GTK 4 and libadwaita app for Hatbot, written in Rust (PLAN.md §23). It talks to the brain's
API with a bearer token. Notifications still come from the ntfy app.

- `src/core`: the API types, the address rule, streamed text, the chat's pages and folds,
  Markdown and `hatbot://` links.
- `src/net`: the API client, the reconnecting WebSocket and the live desktop's socket, all on
  libsoup and GLib's main loop, and the token in the keyring.
- `src/store.rs`: the live store. It applies the brain's events and tells the views what changed.
- `src/ui`: the windows and widgets, built in code.
- `data`: the desktop file and the icon.

## Install

It needs GTK 4.18, libadwaita 1.7 and libsoup 3.6 or newer (Debian 13, Ubuntu 25.04, Fedora 42,
Arch), Rust 1.88 or newer, and a keyring that speaks the Secret Service: GNOME Keyring, KWallet or
KeePassXC. Debian's and Ubuntu's Rust is older; get it from [rustup](https://rustup.rs) there.

```sh
sudo pacman -S gtk4 libadwaita libsoup3 libsecret rust                         # Arch
sudo apt install libgtk-4-dev libadwaita-1-dev libsoup-3.0-dev libsecret-1-dev  # Debian, Ubuntu
apps/linux/install.sh                 # → ~/.local; PREFIX=/usr/local for everyone
```

Sign in with your Hatbot's https address, your password and a code from your authenticator.

## Develop

```sh
cd apps/linux
cargo run
cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
cargo deny check licenses    # every crate permissive (cargo install cargo-deny)
```

The tests run against a stand-in brain on localhost and need no display.
