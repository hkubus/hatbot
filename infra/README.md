# infra

Scripts that set up Hatbot on the Proxmox host (PLAN.md §9).

| Script | Runs | Does |
|---|---|---|
| `host-setup.sh` | on the host, as root | both containers on the LAN, the desktop's firewall, Proxmox user/roles/token, snapshots, backups; then runs the two provision scripts |
| `brain-provision.sh` | inside `hatbot-brain` | Bun, ntfy, memory repo, SSH key, firewall |
| `deploy.sh` | on the host, as root | installs the app on the brain as a new release; runs `brain-deploy.sh` inside it |
| `desktop-provision.sh` | inside `hatbot-desktop` | `desk` user, Xvnc + XFCE, Chromium, Bun, firewall |
| `verify.sh` | on the host, as root | checks isolation, token permissions, snapshots and backups; changes nothing |
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

## Deploy the app

Run this on the host for the first install and for every update. It deploys the last commit of the checkout in CT 124:

```sh
./deploy.sh 124:/root/hatbot
```

The first run asks for the web app's public URL, your reverse proxy's IP and the Anthropic API key. Then it prints a setup code. Open `https://<your hatbot host>/setup` and enter the code to set your password and TOTP. The code changes whenever the brain restarts before setup is done. To read the current one, run `pct exec <brain> -- journalctl -u hatbot-brain | grep 'setup code'`.

Each deploy is a new release in `/var/lib/hatbot/releases` inside the brain, and `/var/lib/hatbot/app` links to the live one. If the new release fails its health check, the previous one goes back live. The last 3 are kept. To change the URL or proxy later, run with `HATBOT_PUBLIC_URL=… HATBOT_TRUSTED_PROXIES=… ./deploy.sh …`.

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
| `NTFY_BASE_URL` | `https://ntfy.gaycats.ovh` | |
| `FORCE` | `0` | `1` continues despite the RAM check |

## Good to know

- The desktop's firewall is an nftables table on the host, `bridge hatbot`, loaded by `hatbot-firewall.service`. It filters the desktop's port on the LAN bridge and pins its MAC, so don't change the desktop's MAC or NIC in the GUI (verify.sh checks they match). It doesn't touch the Proxmox firewall. Don't start or restart `nftables.service` on the host: its `flush ruleset` wipes every table, including Proxmox's.
- The brain listens on port 8080 on the LAN, for your reverse proxy. The desktop can't reach it.
- The brain's secrets live in `/etc/hatbot/*.env` inside the brain (mode 640, group `hatbot`). The desktop only holds its VNC password and its agent token.
- The ntfy password for your phone is in `/root/ntfy-phone-password.txt` inside the brain.
- To undo: `pct destroy` both containers, `pveum user delete hatbot@pve`, `pveum role delete HatbotOps` and `HatbotSnapshots`, `pveum pool delete hatbot`, disable `hatbot-firewall.service` and `hatbot-desktop-snapshot.timer`, run `nft delete table bridge hatbot`, and remove `/etc/hatbot`.
