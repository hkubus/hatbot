# Hatbot

Self-hosted, always-on personal agent on Proxmox. It chats, runs tasks on its own desktop, and asks before risky actions.

- `PLAN.md` is the design and the milestone plan.
- `prototype/` is a clickable static mock of the web UI. Open `prototype/index.html` in a browser or serve the folder (`python3 -m http.server`).

## Install

You need:

- A Proxmox VE 8 (or newer) host with about 4 GB of RAM free. Hatbot runs in two Debian 13 containers: the brain (2 GB) and the desktop it browses with (1.5 GB). Their disks go on an SSD storage, and the brain's archive on a second one (an HDD pool will do).
- An Anthropic API key.
- An ntfy server (your own, or ntfy.sh) and the ntfy app on your phone, for notifications and approvals.
- A domain, with a reverse proxy that serves it over TLS and passes WebSockets.
- Optional: Uptime Kuma, for alerts and to hear when the brain itself is down; tokens for the plugins you want (GitHub, Forgejo, Proxmox Backup Server, Home Assistant).

On the Proxmox host, as root:

1. Get the code: `apt install git && git clone https://github.com/hkubus/hatbot /root/hatbot && cd /root/hatbot/infra`.
2. Set up the containers: `./host-setup.sh --dry-run` shows what it would do; `./host-setup.sh` does it, asking before each change. Then `./verify.sh` checks the desktop's isolation and Hatbot's permissions.
3. Point your reverse proxy at `http://<brain IP>:8080`. `host-setup.sh` prints the IP.
4. Install the app: `git -C /root/hatbot archive -o /root/hatbot.tar HEAD && ./deploy.sh /root/hatbot.tar`. It asks for the web app's public URL, your reverse proxy's IP, the API key, your ntfy server and topic, and the repository that **Settings → Updates** pulls from. Then it prints a setup code: open `https://<your domain>/setup` to set your password and TOTP.
5. Plugins: one env file each on the brain, then restart it (`infra/README.md`, "Plugins"). For the dead-man ping, add an Uptime Kuma Push monitor and put its URL in `HATBOT_PING_URL` ("When the brain itself is down").
6. Optional: `./pct-exec-setup.sh` lets Hatbot run commands in your other containers ("Commands in your containers").
7. In the web app: **Settings → Check everything**, then send a test approval and approve it from your phone's lock screen. For alerts, add an Uptime Kuma trigger under **Schedules & Triggers** and give Kuma its webhook URL.
8. The iPhone app (optional): add the SideStore source `https://hkubus.github.io/hatbot/source.json`, or build your own (`apps/ios/README.md`). It needs an `https://` public URL: `deploy.sh` also takes `http://`, which only the web app works with. A fork's iOS workflow uses the repository variable `BUNDLE_PREFIX`, a reverse domain you own.

`infra/README.md` explains each step, updates and rollbacks. `bun run licenses` lists the dependencies' licences; Hatbot takes no copyleft ones.

## Licence

MIT (`LICENSE`).
