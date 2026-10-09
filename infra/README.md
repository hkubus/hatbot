# infra

Scripts that set up Hatbot on the Proxmox host (PLAN.md §9).

| Script | Runs | Does |
|---|---|---|
| `host-setup.sh` | on the host, as root | private bridge, firewall, both containers, Proxmox user/roles/token, snapshots, backups; then runs the two provision scripts |
| `brain-provision.sh` | inside `hatbot-brain` | Bun, ntfy, memory repo, SSH key, firewall, `hatbot-brain.service` (not enabled until M1) |
| `desktop-provision.sh` | inside `hatbot-desktop` | `desk` user, Xvnc + XFCE, Chromium, Bun, firewall |
| `verify.sh` | on the host, as root | checks isolation, token permissions, snapshots and backups; changes nothing |

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

## Settings

Set any of these as environment variables, or answer the prompts. Defaults are in the top of `host-setup.sh`.

| Variable | Default | |
|---|---|---|
| `BRIDGE` | `vmbr77` | private bridge |
| `NET_PREFIX` | `10.77.0` | its /24: host `.1`, brain `.10`, desktop `.20` |
| `BRAIN_ID`, `DESKTOP_ID` | next free | VMIDs |
| `SSD_STORE`, `HDD_STORE` | asked | root disks; `/archive` |
| `ARCHIVE_SIZE` | `200` | GiB |
| `BRAIN_LAN` | `dhcp` | or `192.168.55.40/24,gw=192.168.55.1` |
| `DNS` | `9.9.9.9 1.1.1.1` | the desktop's resolvers |
| `NTFY_BASE_URL` | `https://ntfy.gaycats.ovh` | |
| `FORCE` | `0` | `1` continues despite the RAM check |

## Good to know

- The host firewall is its own nftables table, `inet hatbot`, loaded by `hatbot-firewall.service`. It doesn't touch the Proxmox firewall. Don't start or restart `nftables.service` on the host: its `flush ruleset` wipes every table, including Proxmox's.
- The brain's secrets live in `/etc/hatbot/*.env` inside the brain (mode 640, group `hatbot`). The desktop only holds its VNC password and its agent token.
- The ntfy password for your phone is in `/root/ntfy-phone-password.txt` inside the brain.
- To undo: `pct destroy` both containers, `pveum user delete hatbot@pve`, `pveum role delete HatbotOps` and `HatbotSnapshots`, `pveum pool delete hatbot`, disable `hatbot-firewall.service` and `hatbot-desktop-snapshot.timer`, delete `vmbr77` in the node's network settings, and remove `/etc/hatbot` (leave `/etc/sysctl.d/90-hatbot.conf` if anything else on the host needs IP forwarding).
