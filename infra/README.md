# infra

Scripts that set up Hatbot on a Proxmox host, or on any two or three Debian 13 machines over SSH.

| Script | Runs | Does |
|---|---|---|
| `host-setup.sh` | on the Proxmox host, as root | the containers on the LAN, the guests' firewall, Proxmox user/roles/token, snapshots, backups; then runs the provision scripts |
| `ssh-setup.sh` | anywhere with ssh | without Proxmox: checks two or three Debian 13 machines (or just a brain), writes the guests' secrets, runs the provision scripts over SSH |
| `brain-provision.sh` | inside `hatbot-brain` | Bun, memory repo, SSH key, firewall |
| `deploy.sh` | where the setup ran | installs the app: `desktop-deploy.sh` puts desktop-agent on the desktop, `boxes-deploy.sh` the boxes agent and the boxes' units on the boxes guest, `brain-deploy.sh` a new release on the brain |
| `hatbot-update.sh` | inside `hatbot-brain`, as root | the Update button in Settings: pulls from git, runs `brain-deploy.sh`, then updates desktop-agent and the boxes agent |
| `desktop-provision.sh` | inside `hatbot-desktop` | `desk` user, Xvnc + XFCE, Chromium, Bun, firewall (in, and out for its programs) |
| `boxes-provision.sh` | inside `hatbot-boxes` | `hatbox` user, Bun, polkit, firewall (in, and out for the agent only) |
| `verify.sh` | where the setup ran | checks isolation, including that box units have no network, and on Proxmox token permissions, snapshots and backups; changes nothing |
| `smoke.sh` | anywhere, with an API token | Settings → Check everything from a shell: the API, desktop, plugins, notifications; changes nothing |
| `pct-exec-setup.sh` | on the Proxmox host, as root | optional: lets Hatbot run commands in your containers (`ssh_pct_exec`) |
| `reset-login.sh` | where the setup ran | forgets the password and authenticator, prints a new setup code |
| `test-firewall.sh` | anywhere, as root | tests the guests' firewalls in throwaway network namespaces |

## Run it

On Proxmox (without it, see "Without Proxmox" below):

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

The third container, `hatbot-boxes`, is optional. It runs the server side of boxes, the small web apps the chat makes: each box's backend in a unit of its own, with no network. Without it, boxes are only pages. `host-setup.sh` asks for its VMID; answer `none` (or run with `BOXES_ID=none`) to leave it out. To add it later, remove `BOXES_ID=none` from `/etc/hatbot/host.env`, then run `host-setup.sh` and `deploy.sh` again.

If your router forwards ports to the LAN (the web app's reverse proxy, say), the desktop or the boxes guest could come back in through your public address. Block it with `HATBOT_PUBLIC_IPS="203.0.113.7"` (space-separated, IPv4) in `/etc/hatbot/host.env` and re-run `host-setup.sh`. `verify.sh` fails if either can reach the web app's public URL.

## Without Proxmox

`ssh-setup.sh` sets up two or three Debian 13 machines you reach over SSH: VMs (libvirt, VirtualBox, Hyper-V), Incus or LXD containers, cloud servers or spare boxes. Run it from any machine with ssh, such as your laptop, with a key both accept, as `root@host` or as a user with passwordless sudo. Use fresh machines: provisioning writes `/etc/nftables.conf`, whose `flush ruleset` drops other rules, so it refuses machines with Docker, ufw, firewalld or rules of their own (`FORCE=1` goes ahead anyway).

```sh
./ssh-setup.sh --dry-run   # checks the machines, shows the plan, changes nothing
./ssh-setup.sh
./verify.sh
```

It asks for each machine's SSH address, and finds the addresses they reach each other on (`BRAIN_IP`, `DESKTOP_IP`, `BOXES_IP`). Answer `none` for the desktop to run the brain alone: no desktop tasks, page watchers, live view or sandbox. Answer `none` for the boxes guest (`BOXES_SSH`) and boxes are only pages. It asks again on each run, so a boxes guest can be added later. Its answers go to `host.env` (`/etc/hatbot/` as root, otherwise `~/.config/hatbot/`; `HATBOT_STATE` picks another), where `deploy.sh`, `verify.sh` and `reset-login.sh` find them.

What's different from Proxmox:

- **The desktop's fence is on the desktop.** Its nftables output chain lets `desk` (Chromium) and the shell's and renderer's throwaway users reach the internet only: no private ranges, its LAN, the brain, cloud metadata (169.254.169.254) or `HATBOT_PUBLIC_IPS`, and no IPv6. Something that gets root on the desktop could lift it. On Proxmox the host's bridge filter holds even then, so if your hypervisor can filter the desktop's traffic (a VLAN of its own, network ACLs), do that too.
- **The same goes for the boxes guest.** Its output chain lets only the agent's user out, to the internet only; the boxes and their builds get nothing at all.
- **Keep them on a private network**, or a VPN (WireGuard, Tailscale): VNC and the agents speak plain TCP, so `ssh-setup.sh` refuses a public `DESKTOP_IP` or `BOXES_IP`.
- **A LAN DNS resolver** stays reachable from the desktop and the boxes guest, on port 53 only. To keep them off the LAN entirely, point them at public resolvers and run `ssh-setup.sh` again.
- **No Proxmox token, snapshots or backups.** Settings → System → Advanced has no desktop rollback; back up the brain's `/var/lib/hatbot` and `/archive`, and the boxes guest's `/var/lib/private/hatbox-data` (what the boxes save), yourself. The Proxmox plugin still works with a token you write to `/etc/hatbot/proxmox.env` by hand (see `host-setup.sh`, step 4).

Commands below written `pct exec <brain> -- …` are `ssh <brain> …` here.

## Deploy the app

Run this where you ran the setup, for the first install and whenever the host-side scripts change. It deploys the last commit of a checkout:

```sh
./deploy.sh ..                 # the checkout this folder is in
./deploy.sh 124:/root/hatbot   # on Proxmox: the checkout in CT 124
```

The first run asks for:
- the web app's public URL and your reverse proxy's IP,
- the Anthropic API key,
- your ntfy server's URL, topic and access token (the token's user needs write access to the topic). It suggests a random topic: whoever can read the topic sees every notification and can press its Approve buttons, so on your ntfy server allow only your own user to read it,
- the git repository the Update button pulls from: an https URL and a branch (the repository is public, so leave the token empty; a private one needs a token with `read:repository`), and the SSH public key you sign commits with (see "Signed commits only" below).

 Then it prints a setup code. Open `https://<your hatbot host>/setup` and enter the code to set your password and TOTP. The code changes whenever the brain restarts before setup is done. To read the current one, run `pct exec <brain> -- journalctl -u hatbot-brain | grep 'setup code'`.

To change the password or the authenticator, use **Settings → Account → Password and authenticator**; either change signs out every other browser and app. If you've lost them, `./reset-login.sh` forgets both, signs out everything, restarts the brain and prints a new setup code.

Each deploy is a new release in `/var/lib/hatbot/releases` inside the brain, and `/var/lib/hatbot/app` links to the live one. Before switching, the brain stops and its database is copied into the new release (`hatbot.sqlite.before`). If the new release fails its health check, the previous one goes back live with that copy of the database, so a migration it can't read is undone. The last 3 are kept. To change the URL or proxy later, run with `HATBOT_PUBLIC_URL=… HATBOT_TRUSTED_PROXIES=… ./deploy.sh …`; for ntfy, set `NTFY_URL=…`; for updates, `HATBOT_GIT_URL=…`.

## Update from Settings

After that, **Settings → System → Software update → Update** pulls the branch and deploys it: the brain first, then desktop-agent and the boxes agent, each with the same health check and rollback as `deploy.sh`. If the brain goes back to its old version, the guests aren't touched. The page reloads on the new version.

- The brain only writes `/var/lib/hatbot/update-request`. `hatbot-update.path` runs `hatbot-update` as root, which reads the git token from `/etc/hatbot/update.env` (root only), so the brain service never holds it.
- desktop-agent receives its new code over its own API; a root service on the desktop (`hatbot-desktop-agent-update.path`) installs it. The first `deploy.sh` run after this feature sets that up. The boxes agent does the same (`hatbox-agent-update.path`); the boxes' units and firewall come only with `deploy.sh`.
- It refuses while a task is running, because the brain restarts.
- It doesn't touch the host. If a commit changes host-side scripts (`host-setup.sh`, `deploy.sh`, `desktop-deploy.sh` and so on), Settings says so; run `deploy.sh` for those.
- Logs: `/var/lib/hatbot-update/last.log` on the brain, `journalctl -u hatbot-desktop-agent-update` on the desktop, and `journalctl -u hatbox-agent-update` on the boxes guest.

### Signed commits only

An update runs the new commit's `brain-deploy.sh` as root on the brain, so whoever can push to the branch can run code there. To deploy only commits you signed with an SSH key, give `deploy.sh` that key's public half when it asks (or run it with `HATBOT_GIT_URL=…` to be asked again). It writes `/etc/hatbot/allowed_signers` on the brain and points `update.env` at it; to do it by hand:

```sh
pct exec <brain> -- sh -c 'echo "you@example.com namespaces=\"git\" ssh-ed25519 AAAA…" > /etc/hatbot/allowed_signers'
pct exec <brain> -- sh -c 'echo HATBOT_UPDATE_SIGNERS=/etc/hatbot/allowed_signers >> /etc/hatbot/update.env'
```

Until there's a key, Check everything warns under "Last update". Sign your commits (`git config gpg.format ssh`, `git config user.signingkey ~/.ssh/id_ed25519.pub`, `git config commit.gpgsign true`). From then on an update whose newest commit fails `git verify-commit` stops before deploying anything, and Settings says why. So does one whose newest commit doesn't come after the live one: a branch moved back to an older signed commit, or rewritten. To deploy that on purpose, run `deploy.sh`. The check is in `hatbot-update` itself, so it starts working after the next update (or deploy) installs this version of it. `deploy.sh` keeps the line when it rewrites `update.env`.

## Commands in your containers (optional)

Proxmox's API can't run commands inside containers, so Hatbot does it over SSH through the host. On the host:

```sh
cd /root/infra && ./pct-exec-setup.sh
```

It adds a `hatbot` Unix user that logs in with the brain's key, installs `/usr/local/sbin/hatbot-pct-exec` (one command in one running container, as root there; Hatbot's own containers are refused) and a sudo rule for that program alone. Then add the host in **Settings → Integrations → Plugins → SSH** (user `hatbot`) and switch on **Proxmox host** (under **More**). Background tasks get `ssh_pct_exec(host, guest, command)`; destructive commands ask first, and a "careful" host asks for everything.

This makes Hatbot root inside your other containers. Leave it out if you'd rather keep Hatbot to starting and stopping them.

## Plugins

Integrations are plugins you switch on in the web app, under **Settings → Integrations → Plugins**. Each plugin's page has fields for the addresses and tokens it needs; save them and the plugin restarts with them. Tokens are kept in `/var/lib/hatbot/secrets.json` on the brain (mode 600) and never shown again, only whether they're set.

Env files in `/etc/hatbot/` on the brain still work, for ones written before or by a script; a value set on the page wins until **Use the host's**. A new env file needs a redeploy of the brain before its unit loads it.

| Plugin | Needs |
|---|---|
| Proxmox | nothing more: `host-setup.sh` already set it up, with a token that can't change configs or destroy |
| SSH | on each host, a `hatbot` user with the brain's public key (shown on the plugin's page) in `~hatbot/.ssh/authorized_keys`, and sudo rules for what it may do as root. Hosts are added on the plugin's page; each host's key is pinned the first time Hatbot connects |
| Forgejo | Forgejo's address and a token of Hatbot's bot account with read and write access to repositories and issues. Add the bot as a collaborator to the repos it should work on |
| Own code | Hatbot's own repository as `owner/name`, with the Forgejo plugin's address and token. The bot account needs write access to that repository: it pushes `hatbot/…` branches and opens pull requests, which you review and merge. Needs the desktop, whose sandbox runs the tests |
| GitHub | a fine-grained token of Hatbot's bot account with contents, issues and pull requests read/write, and commit statuses, checks and actions read, for the repos it should work on. An API address only for GitHub Enterprise |
| Proxmox Backup Server | its address (`https://<pbs>:8007`), a token ID (`hatbot@pbs!brain`), the token's secret and the TLS fingerprint (Dashboard → Show Fingerprint). Give the token DatastoreAudit and DatastoreBackup on `/datastore`, and Sys.Audit on `/`; deleting a backup also needs DatastorePrune |
| Home Assistant | its address and a long-lived access token (your profile → Security), ideally of a user made for Hatbot |
| Uptime Kuma | its address and an API key (Settings → API Keys). It only reads monitors; alerts still come in as triggers |
| T3 Code | T3 Code on your computer, listening where the brain can reach it (`t3 serve --host 0.0.0.0`, or the desktop app's own server on port 3773), and its address on the plugin's page. **Connect** there sends you to T3 Code to let Hatbot in: allow full access. The sign-in lasts 30 days. Its agents work with full access on that computer, so a task that has read outside content asks you first |
| MCP | servers and the secrets they use are added on the plugin's page; a server's headers or environment use a secret as `${NAME}`. Names set in `/etc/hatbot/mcp.env` work too. A "Command" server runs inside the brain as the `hatbot` user, which can read the brain's other secrets, so only run servers you trust there; prefer HTTP servers running elsewhere |

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
| `BRAIN_ID`, `DESKTOP_ID`, `BOXES_ID` | next free | VMIDs; `BOXES_ID=none` leaves out the boxes guest |
| `BRAIN_IP`, `DESKTOP_IP`, `BOXES_IP` | `192.168.55.<VMID+100>` | static LAN addresses; the script checks they're free |
| `LAN_BRIDGE` | the uplink bridge | bridge the guests join |
| `SSD_STORE`, `HDD_STORE` | asked | root disks; `/archive` |
| `ARCHIVE_SIZE` | `200` | GiB |
| `DNS` | `9.9.9.9 1.1.1.1` | the desktop's and the boxes guest's resolvers |
| `FORCE` | `0` | `1` continues despite the RAM check |

## Good to know

- On Proxmox, the desktop's and the boxes guest's firewall is an nftables table on the host, `bridge hatbot`, loaded by `hatbot-firewall.service`. It filters their ports on the LAN bridge and pins their MACs, so don't change their MACs or NICs in the GUI (verify.sh checks they match). It doesn't touch the Proxmox firewall. Don't start or restart `nftables.service` on the host: its `flush ruleset` wipes every table, including Proxmox's.
- The brain listens on port 8080 on the LAN, for your reverse proxy. Neither guest can reach it, nor open any connection to the brain, over IPv4 or IPv6. Over IPv6 the brain knows them by their MACs and global addresses, as `ssh-setup.sh` found them; run it again if those change.
- The brain's secrets live in `/etc/hatbot/*.env` inside the brain (mode 640, group `hatbot`). The desktop only holds its VNC password and its agent token, and the boxes guest its agent's token (`/etc/hatbox/secrets.env`; the brain has it in `/etc/hatbot/boxes.env`).
- ntfy runs on its own server, not on Hatbot's guests. The brain only publishes to it, with the URL, topic and token `deploy.sh` saved in `/etc/hatbot/ntfy.env`. For instant iPhone notifications, set `upstream-base-url: https://ntfy.sh` on your ntfy server.
- On the boxes guest, the agent is `hatbox-agent.service`, on port 7071, which only the brain reaches. Each box's backend is `hatbox@<id>.service` and its builds `hatbox-build@<id>.service`, all in `hatbox.slice` (384 MB together); a polkit rule lets the agent start and stop only those. What a box saves is in `/var/lib/private/hatbox-data/<id>`, its log in `/var/lib/hatbox/logs/<id>.log`.
- To undo: `pct destroy` the containers, `pveum user delete hatbot@pve`, `pveum role delete HatbotOps` and `HatbotSnapshots`, `pveum pool delete hatbot`, disable `hatbot-firewall.service`, `hatbot-desktop-snapshot.timer` and `hatbot-boxes-snapshot.timer`, run `nft delete table bridge hatbot`, and remove `/etc/hatbot`.
