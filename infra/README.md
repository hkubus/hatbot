# infra

Scripts that set up Hatbot on the Proxmox host (PLAN.md §9).

| Script | Runs | Does |
|---|---|---|
| `host-setup.sh` | on the host, as root | both containers on the LAN, the desktop's firewall, Proxmox user/roles/token, snapshots, backups; then runs the two provision scripts |
| `brain-provision.sh` | inside `hatbot-brain` | Bun, memory repo, SSH key, firewall |
| `deploy.sh` | on the host, as root | installs the app: `desktop-deploy.sh` puts desktop-agent on the desktop, `brain-deploy.sh` a new release on the brain |
| `hatbot-update.sh` | inside `hatbot-brain`, as root | the Update button in Settings: pulls from git, updates desktop-agent, then runs `brain-deploy.sh` |
| `desktop-provision.sh` | inside `hatbot-desktop` | `desk` user, Xvnc + XFCE, Chromium, Bun, firewall |
| `verify.sh` | on the host, as root | checks isolation, token permissions, snapshots and backups; changes nothing |
| `smoke.sh` | anywhere, with an API token | Settings → Check everything from a shell: the API, desktop, plugins, notifications; changes nothing |
| `pct-exec-setup.sh` | on the host, as root | optional: lets Hatbot run commands in your containers (`ssh_pct_exec`) |
| `test-firewall.sh` | anywhere, as root | tests the desktop firewall in throwaway network namespaces |

## Run it

1. Copy this folder to the host. From the host's shell:

   ```sh
   pct exec 124 -- tar -C /root/hatbot -cf - infra | tar -C /root -xf -
   cd /root/infra
   ```

2. See what it would do. Nothing is changed:

   ```sh
   ./host-setup.sh --dry-run
   ```

3. Run it. It asks before each change, and remembers your answers in `/etc/hatbot/host.env`:

   ```sh
   ./host-setup.sh
   ```

4. Check the result:

   ```sh
   ./verify.sh
   ```

Re-running `host-setup.sh` is safe. It finds the containers by name and skips what already exists.

If your router forwards ports to the LAN (the web app's reverse proxy, say), the desktop could come back in through your public address. Block it with `HATBOT_PUBLIC_IPS="203.0.113.7"` (space-separated, IPv4) in `/etc/hatbot/host.env` and re-run `host-setup.sh`. `verify.sh` fails if the desktop can reach the web app's public URL.

## Deploy the app

Run this on the host for the first install, and whenever the host-side scripts change. It deploys the last commit of the checkout in CT 124:

```sh
./deploy.sh 124:/root/hatbot
```

The first run asks for:
- the web app's public URL and your reverse proxy's IP,
- the Anthropic API key,
- your ntfy server's URL, topic and access token (the token's user needs write access to the topic),
- the git repository the Update button pulls from: an https URL and a branch (the repository is public, so leave the token empty; a private one needs a token with `read:repository`).

 Then it prints a setup code. Open `https://<your hatbot host>/setup` and enter the code to set your password and TOTP. The code changes whenever the brain restarts before setup is done. To read the current one, run `pct exec <brain> -- journalctl -u hatbot-brain | grep 'setup code'`.

Each deploy is a new release in `/var/lib/hatbot/releases` inside the brain, and `/var/lib/hatbot/app` links to the live one. Before switching, the brain stops and its database is copied into the new release (`hatbot.sqlite.before`). If the new release fails its health check, the previous one goes back live with that copy of the database, so a migration it can't read is undone. The last 3 are kept. To change the URL or proxy later, run with `HATBOT_PUBLIC_URL=… HATBOT_TRUSTED_PROXIES=… ./deploy.sh …`; for ntfy, set `NTFY_URL=…`; for updates, `HATBOT_GIT_URL=…`.

## Update from Settings

After that, **Settings → Updates → Update** pulls the branch and deploys it: the brain first, then desktop-agent, each with the same health check and rollback as `deploy.sh`. If the brain goes back to its old version, the desktop isn't touched. The page reloads on the new version.

- The brain only writes `/var/lib/hatbot/update-request`. `hatbot-update.path` runs `hatbot-update` as root, which reads the git token from `/etc/hatbot/update.env` (root only), so the brain service never holds it.
- desktop-agent receives its new code over its own API; a root service on the desktop (`hatbot-desktop-agent-update.path`) installs it. The first `deploy.sh` run after this feature sets that up.
- It refuses while a task is running, because the brain restarts.
- It doesn't touch the host. If a commit changes host-side scripts (`host-setup.sh`, `deploy.sh`, `desktop-deploy.sh` and so on), Settings says so; run `deploy.sh` on the host for those.
- Logs: `/var/lib/hatbot-update/last.log` on the brain, and `journalctl -u hatbot-desktop-agent-update` on the desktop.

### Signed commits only (optional)

An update runs the new commit's `brain-deploy.sh` as root on the brain, so whoever can push to the branch can run code there. To deploy only commits you signed with an SSH key, put the key in an allowed signers file on the brain and point `update.env` at it:

```sh
pct exec <brain> -- sh -c 'echo "you@example.com namespaces=\"git\" ssh-ed25519 AAAA…" > /etc/hatbot/allowed_signers'
pct exec <brain> -- sh -c 'echo HATBOT_UPDATE_SIGNERS=/etc/hatbot/allowed_signers >> /etc/hatbot/update.env'
```

Sign your commits (`git config gpg.format ssh`, `git config user.signingkey ~/.ssh/id_ed25519.pub`, `git config commit.gpgsign true`). From then on an update whose newest commit fails `git verify-commit` stops before deploying anything, and Settings says why. The check is in `hatbot-update` itself, so it starts working after the next update (or deploy) installs this version of it. `deploy.sh` keeps the line when it rewrites `update.env`.

## Commands in your containers (optional)

Proxmox's API can't run commands inside containers, so Hatbot does it over SSH through the host. On the host:

```sh
cd /root/infra && ./pct-exec-setup.sh
```

It adds a `hatbot` Unix user that logs in with the brain's key, installs `/usr/local/sbin/hatbot-pct-exec` (one command in one running container, as root there; Hatbot's own brain and desktop are refused) and a sudo rule for that program alone. Then add the host in **Settings → Plugins → SSH** (user `hatbot`) and switch on **Proxmox host**. Background tasks get `ssh_pct_exec(host, guest, command)`; destructive commands ask first, and a "careful" host asks for everything.

This makes Hatbot root inside your other containers. Leave it out if you'd rather keep Hatbot to starting and stopping them.

## Plugins

Integrations are plugins you switch on in the web app, under **Settings → Plugins** (PLAN.md §4.5). Their secrets live in env files inside the brain; create them readable by the service, then restart it:

```sh
pct exec <brain> -- sh -c 'install -m 640 -g hatbot /dev/stdin /etc/hatbot/forgejo.env <<EOF
FORGEJO_URL=https://git.example.com
FORGEJO_TOKEN=…
EOF
systemctl restart hatbot-brain'
```

| Plugin | Needs |
|---|---|
| Proxmox | nothing more: `host-setup.sh` already wrote `/etc/hatbot/proxmox.env` |
| SSH | on each host, a `hatbot` user with the brain's public key (shown on the plugin's page) in `~hatbot/.ssh/authorized_keys`, and sudo rules for what it may do as root. Hosts are added on the plugin's page; each host's key is pinned the first time Hatbot connects |
| Forgejo | `/etc/hatbot/forgejo.env` with `FORGEJO_URL` and `FORGEJO_TOKEN`: a token of Hatbot's bot account with read and write access to repositories and issues. Add the bot as a collaborator to the repos it should work on |
| GitHub | `/etc/hatbot/github.env` with `GITHUB_TOKEN`: a fine-grained token of Hatbot's bot account with contents, issues and pull requests read/write, and commit statuses, checks and actions read, for the repos it should work on. `GITHUB_API_URL` only for GitHub Enterprise |
| Proxmox Backup Server | `/etc/hatbot/pbs.env` with `PBS_URL` (`https://<pbs>:8007`), `PBS_TOKEN_ID` (`hatbot@pbs!brain`), `PBS_TOKEN_SECRET` and `PBS_TLS_FINGERPRINT` (Dashboard → Show Fingerprint). Give the token DatastoreAudit and DatastoreBackup on `/datastore`, and Sys.Audit on `/`; deleting a backup also needs DatastorePrune |
| Home Assistant | `/etc/hatbot/homeassistant.env` with `HOMEASSISTANT_URL` and `HOMEASSISTANT_TOKEN`: a long-lived access token (your profile → Security), ideally of a user made for Hatbot |
| Uptime Kuma | `/etc/hatbot/uptimekuma.env` with `UPTIME_KUMA_URL` and `UPTIME_KUMA_API_KEY` (Settings → API Keys). It only reads monitors; alerts still come in as triggers |
| MCP | servers are added on the plugin's page. Secrets they need go in `/etc/hatbot/mcp.env` and are referenced as `${NAME}` in headers or environment. A "Command" server runs inside the brain as the `hatbot` user, which can read the brain's other secrets, so only run servers you trust there; prefer HTTP servers running elsewhere |

The brain's unit loads these env files from the first deploy after they were added; redeploy the brain once for `pbs.env`, `homeassistant.env` and `uptimekuma.env`.

## When the brain itself is down

Check everything and the heartbeat run inside the brain, so they can't tell you it's down. Instead the brain pings a monitor outside it once a minute, and the monitor tells you when the pings stop. In Uptime Kuma:

1. **Notification:** Settings → Notifications → Setup Notification, type **ntfy**, with your ntfy server, topic and token. It must go to ntfy directly, not to Hatbot's Kuma trigger, because Hatbot is what's down.
2. **Monitor:** Add New Monitor, type **Push**, heartbeat interval **60** seconds, retries **2**, with that notification on. Copy its push URL.
3. **The brain:** put the URL in `/etc/hatbot/secrets.env` and restart:

   ```sh
   pct exec <brain> -- sh -c 'echo "HATBOT_PING_URL=https://kuma.example/api/push/…?status=up&msg=OK&ping=" >> /etc/hatbot/secrets.env; systemctl restart hatbot-brain'
   ```

The brain sends `status=up` while its database answers and `status=down` with the error when it doesn't, and keeps pinging while paused. Treat the URL as a secret: whoever has it can say "up" for the brain. Settings → Check everything shows the last ping. Any other dead-man service that takes a GET with `status` and `msg` works too.

## Settings

Set any of these as environment variables, or answer the prompts. Defaults are in the top of `host-setup.sh`.

| Variable | Default | |
|---|---|---|
| `BRAIN_ID`, `DESKTOP_ID` | next free | VMIDs |
| `BRAIN_IP`, `DESKTOP_IP` | `192.168.55.<VMID+100>` | static LAN addresses; the script checks they're free |
| `LAN_BRIDGE` | the uplink bridge | bridge both guests join |
| `SSD_STORE`, `HDD_STORE` | asked | root disks; `/archive` |
| `ARCHIVE_SIZE` | `200` | GiB |
| `DNS` | `9.9.9.9 1.1.1.1` | the desktop's resolvers |
| `FORCE` | `0` | `1` continues despite the RAM check |

## Good to know

- The desktop's firewall is an nftables table on the host, `bridge hatbot`, loaded by `hatbot-firewall.service`. It filters the desktop's port on the LAN bridge and pins its MAC, so don't change the desktop's MAC or NIC in the GUI (verify.sh checks they match). It doesn't touch the Proxmox firewall. Don't start or restart `nftables.service` on the host: its `flush ruleset` wipes every table, including Proxmox's.
- The brain listens on port 8080 on the LAN, for your reverse proxy. The desktop can't reach it.
- The brain's secrets live in `/etc/hatbot/*.env` inside the brain (mode 640, group `hatbot`). The desktop only holds its VNC password and its agent token.
- ntfy runs on its own server, not on Hatbot's guests. The brain only publishes to it, with the URL, topic and token `deploy.sh` saved in `/etc/hatbot/ntfy.env`. For instant iPhone notifications, set `upstream-base-url: https://ntfy.sh` on your ntfy server.
- To undo: `pct destroy` both containers, `pveum user delete hatbot@pve`, `pveum role delete HatbotOps` and `HatbotSnapshots`, `pveum pool delete hatbot`, disable `hatbot-firewall.service` and `hatbot-desktop-snapshot.timer`, run `nft delete table bridge hatbot`, and remove `/etc/hatbot`.
