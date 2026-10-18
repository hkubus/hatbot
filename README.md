# Hatbot

Self-hosted, always-on personal agent for your homelab, on Proxmox or any two Debian machines. It chats, runs tasks on its own desktop, and asks before risky actions.

- `PLAN.md` is the design and the milestone plan.

## Install

Hatbot runs on two Debian 13 machines: the brain (2 GB of RAM) and the desktop it browses with (1.5 GB). The desktop opens untrusted pages, so it sits apart from the brain and is kept off your LAN. On a Proxmox VE host, `host-setup.sh` creates both as containers and fences the desktop in from the host. Anywhere else, `ssh-setup.sh` sets up two machines you give it over SSH (VMs, Incus containers, cloud servers), and the desktop fences itself in, which is weaker: whoever gets root on it could lift that. The desktop is optional there; without it there are no desktop tasks, page watchers or live view.

You need:

- Either a Proxmox VE 8 (or newer) host with about 4 GB of RAM free, an SSD storage for the disks and a second one for the brain's archive (an HDD pool will do); or two fresh Debian 13 machines on one private network (or a VPN such as WireGuard or Tailscale), that you can reach over SSH as root or as a user with passwordless sudo.
- An Anthropic API key.
- Recommended: an ntfy server (your own, or ntfy.sh) and the ntfy app on your phone, for notifications and approving from the lock screen. Without it, approvals wait in the app.
- Recommended: a domain, with a reverse proxy that serves it over TLS and passes WebSockets. The web app also works over plain http; the iPhone app needs https.
- Optional: Uptime Kuma, for alerts and to hear when the brain itself is down; tokens for the plugins you want (GitHub, Forgejo, Proxmox Backup Server, Home Assistant).

Steps 1 and 2 depend on where it runs.

**On Proxmox**, as root on the host:

1. Get the code: `apt install git && git clone https://github.com/hkubus/hatbot /root/hatbot && cd /root/hatbot/infra`.
2. Set up the containers: `./host-setup.sh --dry-run` shows what it would do; `./host-setup.sh` does it, asking before each change. Then `./verify.sh` checks the desktop's isolation and Hatbot's permissions.

**Elsewhere**, from any machine with git and ssh (your laptop will do):

1. Get the code: `git clone https://github.com/hkubus/hatbot && cd hatbot/infra`.
2. Set up the machines: `./ssh-setup.sh --dry-run` checks them and shows the plan; `./ssh-setup.sh` does it. It asks for each machine's SSH address (`root@192.168.1.20`), and refuses one with firewall rules it would wipe (Docker, ufw). Then `./verify.sh` checks the desktop's isolation.

Then, either way:

3. Point your reverse proxy at `http://<brain IP>:8080`. The setup script prints the IP.
4. Install the app: `./deploy.sh ..` deploys the checkout you're in. It asks for the web app's public URL, your reverse proxy's IP, the API key, your ntfy server and topic, and the repository that **Settings → Updates** pulls from. Update runs that branch's code as root on the brain, so give it only a repository you control (your fork), or none and run `deploy.sh` again to update. Then it prints a setup code: open `https://<your domain>/setup` to set your password and TOTP. You can change the API key and ntfy later in **Settings → Connections**.
5. Plugins: one env file each on the brain, then restart it (`infra/README.md`, "Plugins"). For the dead-man ping, add an Uptime Kuma Push monitor and put its URL in `HATBOT_PING_URL` ("When the brain itself is down").
6. Optional, Proxmox only: `./pct-exec-setup.sh` lets Hatbot run commands in your other containers ("Commands in your containers").
7. In the web app: **Settings → Check everything**, then send a test approval and approve it from your phone's lock screen. For alerts, add an Uptime Kuma trigger under **Schedules & Triggers** and give Kuma its webhook URL.
8. The iPhone app (optional): build your own (`apps/ios/README.md`), or add the maintainer's SideStore source `https://hkubus.github.io/hatbot/source.json`. It needs an `https://` public URL: `deploy.sh` also takes `http://`, which only the web app works with. A fork's iOS workflow uses the repository variable `BUNDLE_PREFIX`, a reverse domain you own.

## Try it locally

Without any of the above: `bun install`, then `ANTHROPIC_API_KEY=… bun --cwd apps/brain dev` and `bun --cwd apps/web dev`, and open `http://localhost:5173/setup` with the setup code the brain prints. Its data goes in `data/`. Desktop tasks, watchers and notifications are off until a desktop and ntfy are set up (`DESKTOP_AGENT_URL`, `NTFY_URL`).

`infra/README.md` explains each step, updates and rollbacks. `bun run licenses` lists the dependencies' licences; Hatbot takes no copyleft ones.

## Licence

MIT (`LICENSE`).
