# Hatbot — Plan

A self-hosted, always-on personal agent built on Claude, running on your Proxmox homelab. It's an alternative to OpenAI Dots and xAI Grok Bot, and it fixes what they get wrong:

- **Memory you can read.** Memory is plain markdown, not hidden.
- **Real isolation.** Each agent's desktop is in its own fenced-off container, unlike Grok Bot's shared VM.
- **No vendor cloud.** It runs on your hardware.
- **Predictable cost.** Spending limits are enforced.

> Status: design agreed 2026-10-09. Nothing is built yet. The clickable UI prototype lives in [`prototype/`](prototype/).

---

## 1. Scope

### v1 is
- One personal agent, **Hatbot**, that you reach through a web app (desktop-first PWA, also usable on the phone).
- A persistent **Linux desktop** (Chromium + terminal) that Hatbot drives with Claude computer use. You can watch it live and take over.
- **One-off tasks** and **recurring/triggered tasks**: schedules, signed webhooks, Uptime Kuma alerts.
- **Homelab ops**: Proxmox status, restarts, SSH to approved hosts, Forgejo/GitHub via bot accounts, plus any MCP server.
- **Teach-by-showing**: you demo a task on the desktop, and Hatbot turns it into a reusable skill.
- **Memory**: a git-tracked markdown folder that Hatbot edits and you can read, diff and revert.

### v1 is not
- Email or calendar. You use Proton Mail and no calendar; this can come later via Proton Bridge.
- Open-ended goals ("grow my newsletter"), or a proactive heartbeat that wakes up and decides on its own what to do.
- More than one agent, or teams of agents. The architecture leaves room for both.
- The native iOS app. The API is designed for it; the app comes after v1.
- Multiple users. It's single-operator by design.

---

## 2. Decisions

| Area | Decision |
|---|---|
| Product shape | Personal agent first; teams later |
| Audience | You first, open-source later (private now, licence chosen at release, **no copyleft dependencies**) |
| Hosting | Self-hosted only, on the Proxmox host `192.168.55.113` (i3-12100F, ~16 GiB RAM, no GPU) |
| Isolation | **Brain** and **desktop** are separate guests |
| Brain guest | New dedicated unprivileged LXC |
| Desktop guest | Unprivileged LXC (`nesting=1`), about 1.5 GiB / 2 vCPU, 1280×800, persistent, nightly ZFS snapshots kept 7 days |
| Network | Both guests on the LAN at `192.168.55.<VMID+100>`. The host filters the desktop's bridge port: internet only, LAN and host blocked, only the brain can reach it |
| Provisioning | A setup script you review and run once on the host; Hatbot then uses a **scoped Proxmox API token** |
| Model provider | Claude only |
| Models | **Opus 5.5** drives the desktop · **Sonnet 5.5** is the brain (chat, planning, tools) · **Haiku 5.5** handles triage and injection screening |
| Agent loop | **Custom loop on the raw Messages API**, with no Agent SDK. Same model quality; we own context, caching and cost |
| Tools | Built-in TypeScript tools, plus an **MCP client** for external servers |
| Billing | API key funded by **Max 20x's included $200/mo API credits**; stop when they run out |
| Spending limits | $10/day · $200/month · $3/task (raisable per task) |
| Autonomy | Mostly autonomous. Payments and credential changes always need approval |
| Untrusted-content rule | Once a task has read untrusted input, outward actions need approval (§6.1) |
| Concurrency | Screen tasks run one at a time; non-screen tasks run in parallel |
| Approvals | The task pauses and frees the screen; auto-cancels after 24h; ntfy Approve/Deny buttons use single-use tokens |
| Takeover | You can take over the desktop; Hatbot can also ask you to (logins, 2FA, captchas) |
| Task model | One-off or recurring/triggered, each with a clear end |
| Chat context | One thread on screen; episodic contexts underneath, starting fresh after a 30-min idle gap (§5.3) |
| Memory | Markdown in git; Hatbot writes freely; every change is a commit; diff and revert in the UI; **not pushed to Forgejo** |
| Schedules/triggers | Hatbot creates them from chat; you can see, pause and edit them all |
| Webhooks | Generic HMAC-signed endpoint + Uptime Kuma |
| Uptime Kuma alerts | Hatbot investigates, may do a safe restart, then reports |
| Homelab permissions | Reads and restarts are free; destructive actions need approval |
| Identity | Own Forgejo/GitHub **bot accounts** |
| Teach-by-showing | Record your takeover session, then Opus writes a markdown skill you review |
| Logs | Full task timelines, **kept forever** (screenshots as WebP on the HDD pool) |
| Backups | **Proxmox Backup Server** backs up both guests, including the archive mount |
| Stack | Bun + Hono + SQLite · React + Vite PWA · MJPEG live view (ffmpeg → WS → canvas) · Radix primitives + CSS variables · Biome · `bun test` |
| Repo | Bun-workspaces monorepo `kubus/hatbot`, private, on Forgejo `git.gaycats.ovh` |
| Exposure | `hatbot.gaycats.ovh`. You handle the tunnel, TLS and reverse proxy; Hatbot serves plain HTTP on the LAN |
| Auth | Single user, password + TOTP; API tokens for the future iOS app |
| Notifications | Your self-hosted **ntfy**, on its own server; the brain publishes to it. No APNs or Web Push, because the iOS app will be a free SideStore sideload |
| Name/persona | Hatbot; concise, first person, no animated avatar |
| Web design | Apple-native (macOS-style), desktop-first, three panes, amber brand accent (§10) |

---

## 3. Architecture

```
                         internet
                            │
            your tunnel / VPS → your reverse proxy (TLS)
                            │  hatbot.gaycats.ovh
────────────────────────────┼──────────────────────────────── LAN 192.168.55.0/24 (vmbr0)
                            │
              ┌─────────────┴──────────────┐        ┌──────────────────────┐
              │  hatbot-brain  (LXC)       │        │ Proxmox host         │
              │                            │  API   │  (scoped token)      │
              │  Hono API + WS  :8080      │◀──────▶│                      │
              │  Web PWA (static)          │        └──────────────────────┘
              │  Agent runtime (loops)     │  SSH   ┌──────────────────────┐
              │  Scheduler / triggers      │───────▶│ approved hosts       │
              │  Tool host + MCP client    │        └──────────────────────┘
              │  SQLite · memory/ (git)    │──▶ Claude API (api.anthropic.com)
              │  /archive (HDD mount)      │──▶ Forgejo / GitHub (bot accounts)
              └────────────────────────────┘
                 both guests on vmbr0 at 192.168.55.<VMID+100>
              ┌────────────────────────────┐
              │  hatbot-desktop (LXC)      │──▶ internet only (host filters its
              │                            │    bridge port: no LAN, no host)
              │  Xvnc :1 (1280×800) + XFCE │
              │  Chromium (CDP :9222 local)│
              │  desktop-agent daemon :7070│  ◀── only reachable from the brain
              └────────────────────────────┘
```

**Why it's split this way.** The desktop browses untrusted sites. If it's compromised, it gets the cookies and files on the desktop, and nothing else:
- no API key
- no memory
- no Proxmox token
- no SSH keys
- no LAN access

Everything valuable lives in the brain, and the brain only ever sees *pixels and text* coming from the desktop.

---

## 4. Components

### 4.1 `apps/brain` — Bun + Hono
- **HTTP API + WebSocket**: REST for resources, plus one WS per client for live events (task updates, chat streaming, approvals). The live view has its own WS. See §8.
- **Agent runtime**: the custom loop (§5).
- **Scheduler**: cron expressions and one-shot timers, stored in SQLite and run in-process with catch-up on restart.
- **Trigger ingress**: `POST /hooks/:id`, checked by HMAC signature, plus an Uptime Kuma adapter.
- **Tool host**: the built-in tools (§5.5) and an MCP client (stdio + streamable HTTP).
- **Policy engine**: trust tracking, approval gates, spend enforcement (§6).
- **Live-view relay**: JPEG frames from desktop-agent out to the browser, and your pointer and key events in while you have control. M5 records these input events for teach-by-showing. (noVNC was the first plan; it's MPL-2.0, so the view is our own MJPEG stream.)
- **Notifier**: publishes to ntfy, including action buttons.
- **Storage**: SQLite (WAL) on SSD; `memory/` git repo on SSD; `/archive` (screenshots, raw transcripts) on the HDD mount.

### 4.2 `apps/desktop-agent` — tiny Bun daemon inside the desktop LXC
- `POST /screenshot`: captures the X display (1280×800) and returns lossless WebP.
- `POST /action`: runs the computer-use actions (click, drag, type, key, scroll, hold_key, mouse down/up, cursor_position, wait) through `xdotool`.
- `POST /zoom`: crops a region at full resolution.
- `GET /context`: the current Chromium URL and title, read through CDP on localhost. Used for logging and the trust tracking in §6.1.
- `POST /inspect`: the element under a point (or the focused one), for the consequential-click check in §6.1.
- `POST /lock` / `/unlock`: input lock used during takeover.
- `WS /live`: an MJPEG stream (ffmpeg x11grab, 5 fps) while someone watches, and your input while you have control.
- Auth: a shared bearer secret. The desktop's firewall only accepts the brain, and the host's bridge filter drops the desktop's replies to anyone else.
- Services: `Xvnc :1` (TigerVNC, 1280×800), XFCE (lightweight), Chromium with a persistent profile, `desktop-agent`. All managed by systemd.

### 4.3 `apps/web` — React + Vite PWA
Desktop-first, three panes. Design spec in §10; visual reference in `prototype/`.

### 4.4 `packages/shared`
Shared API types and zod schemas for the brain, web and the future iOS app, which will consume an OpenAPI document generated from them.

### 4.5 `infra/`
- `host-setup.sh`: the one-time Proxmox setup script (§9).
- the provisioning scripts for both guests, `verify.sh`, and `deploy.sh`, which installs the app and its systemd unit.

---

## 5. Agent runtime

### 5.1 Concepts
- **Thread**: the single chat with you. It's what you see.
- **Task**: a unit of work with a clear end.
  - **Origin**: `chat`, `schedule`, `webhook`, or `alert`.
  - **Lane**: `screen` (needs the desktop) or `background`.
  - **States**: `queued → running → waiting_approval | waiting_takeover → running → done | failed | cancelled`
- **Run context**: one Messages-API conversation. Every task gets its own, and the thread gets *episodes* (§5.3).

### 5.2 The loop (custom, raw Messages API)
```
build context (system + memory index + task)  →  call model (stream)
  → for each tool_use: policy check (§6) → execute | park for approval
  → append tool_result  → spend check  → repeat until end_turn / limit
```
- **Streaming**: responses stream to the UI through the WS.
- **Ordering**: tool calls in one turn run in order. Read-only background tools may run in parallel.
- **Prompt caching**:
  - Cache markers go on the tools, the system prompt, and the end of the latest turn.
  - The thread uses the **1-hour cache**, so the 30-minute episode window stays cheap.
  - Tasks use the 5-minute cache.
- **Long tasks**: rely on server-side **context editing** (`clear_tool_uses`) and **compaction**. We never edit history client-side: on the 5.5 models that breaks cached reasoning and is rejected.
- **Limits**: hard caps per task on turns, wall-clock time and dollars.

### 5.3 Episodic chat thread
- **During an active conversation** (last message under 30 minutes ago), keep appending to the same cached context.
- **After 30 minutes idle**, the next message starts a new episode containing:
  - the system prompt
  - the memory index
  - a rolling **thread summary** (updated by Haiku at the end of each episode)
  - the last ~10 messages
  - your new message
- **`search_history(query, range?)`**: a full-text search over the thread in SQLite (FTS5). Hatbot pulls in older messages only when it needs them.
- **Tasks started from chat** run in their own contexts and post **cards** back into the thread (§10.4). The thread never carries a 30-step browser transcript.
- **Durable facts** go to memory, not the thread.

### 5.4 Model routing
| Job | Model | Notes |
|---|---|---|
| Chat, planning, non-screen tools | `claude-sonnet-5-5` | Default brain |
| Desktop driving (`run_desktop_task`) | `claude-opus-5-5`, effort `medium` | Native `computer_toolset_20260801`. Best screenshot reading |
| Injection screening, thread summaries, alert triage | `claude-haiku-5-5`, effort `low` | $0.10/$0.50 per 1M tokens up to 100k-token prompts, 5x above (whole request). Thinks by default |
| Teach-by-showing skill writing | `claude-opus-5-5` | Infrequent |

Chat requests opt into server-side fallback (`fallbacks: "default"`): if the model refuses, the API retries on a fallback model, and the spend ledger bills each model that ran at its own rates.

Later, run a small test on real tasks to see whether Sonnet 5.5 can drive the desktop well enough to save money. Check tool versions and model IDs against the live docs at implementation time.

### 5.5 Built-in tools (brain)
| Tool | Lane | Default policy |
|---|---|---|
| `run_desktop_task(goal, success_criteria)` | screen | Starts the Opus computer-use subloop; queued per §5.6 |
| `request_takeover(reason)` | screen | Pauses and notifies you (logins, 2FA, captchas) |
| `memory_*` (list/read/write/search) | bg | Free; every write is a git commit |
| `search_history` | bg | Free |
| `schedule_*` / `trigger_*` (create/list/update/delete) | bg | Free; everything visible in the UI |
| `web_fetch` / `web_search` | bg | Free; output is **untrusted** |
| `proxmox_*` (status, list, start/stop/restart, snapshot of own guests) | bg | Read and restart free; anything else needs approval |
| `ssh_exec(host, cmd)` | bg | Allowlisted hosts, as the `hatbot` user; destructive patterns need approval |
| `forge_*` (Forgejo/GitHub: read, comment, open PR) | bg | Merge, force-push and delete need approval |
| `notify(message, priority)` | bg | Free |
| MCP tools | bg | Default **ask**; set allow/ask/block per tool |

The `run_desktop_task` **subloop** uses Opus with the computer toolset against the desktop-agent daemon:
- Screenshots go to `/archive` as WebP and into the task timeline.
- The subloop returns a structured summary to the parent.

### 5.6 Scheduling and lanes
- **Screen lane**: a single FIFO queue. While a screen task waits for approval or takeover, it **releases** the lane. When it resumes, it takes a fresh screenshot and re-checks the state before doing anything.
- **Background lane**: a worker pool, with a concurrency of 3 by default.
- **Scheduled and trigger tasks**: enter the same queues. If a schedule fires while its previous run is still going, the new run is skipped (one run at a time per schedule).

---

## 6. Safety model

### 6.1 Trust tracking
Every piece of content entering a context is labelled **trusted** or **untrusted**.

**Trusted:**
- your chat messages
- memory files
- Uptime Kuma alerts
- command output from your hosts
- Proxmox API data

**Untrusted:**
- web pages, screenshots and page text
- `web_fetch` / `web_search` results
- Forgejo/GitHub issue, PR and comment text
- generic webhook payloads (each trigger can be marked trusted)
- MCP tool output (unless the server is marked trusted)

Once a task has read **any untrusted content**, it is *tainted*. In a tainted task, these **outward actions** need your approval:
- sending or posting
- submitting forms that send personal data
- deleting
- buying
- changing remote state (SSH writes, Proxmox power actions, forge writes)

Untainted tasks stay fully autonomous. **Always approval, tainted or not:** payments, credential and account-security changes, and anything matching a destructive pattern.

How it's enforced:
- **Screen actions**: Opus requests consequential steps through a small `confirm_intent(kind, summary)` tool before submitting. The policy engine also flags clicks on buttons such as *submit, pay, buy, delete, send, confirm*, using the screen text and CDP.
- **Defence in depth**:
  - Untrusted text only ever enters through tool results, labelled with its source and JSON-encoded.
  - The system prompt states the untrusted-content policy.
  - Haiku 5.5 screens untrusted text and flags `injection_suspected`; a flag adds an extra approval and a warning badge.
  - Anthropic's built-in computer-use injection checks stay on.

### 6.2 Approvals
- **An approval contains**: the action, its arguments or a preview, *why* Hatbot wants to do it, the untrusted sources that tainted the task, a screenshot if relevant, and the cost so far.
- **Where you approve**: in the web UI (inline card + side panel), or with ntfy action buttons.
- **ntfy buttons**: carry a **single-use, short-lived signed token** (HMAC over approval ID + decision + expiry). Payments and credential approvals only show *Open in Hatbot*.
- **Waiting**: the task pauses and frees the screen lane. It auto-cancels after **24h** and notifies you.

### 6.3 Spending
- **Price table**: per-model prices live in config. Cost = `usage` × price, recorded per request, task and day.
- **Before each request**: estimate the input cost. Refuse if it would exceed the per-task ($3), daily ($10) or monthly ($200) limit.
- **When a limit is hit**: the task pauses as `waiting_budget` and you're notified. You can raise a single task's limit from its card.
- **Credits**: the Max 20x API credits are the only funding source, so the provider stops requests at $0 as a backstop.

### 6.4 Isolation
- **Network**: both guests sit on the LAN bridge with static IPs. The host's nftables table `bridge hatbot` filters frames at the desktop's bridge port (`veth<ID>i0`), where the desktop can't touch it. It allows only the desktop's own MAC and IP (no spoofing, no ARP poisoning), drops IPv6 and non-IP traffic, drops everything to private ranges (including `192.168.55.0/24`) and to the host itself, and lets through only replies to the brain on 5901/7070. Inside the brain, nftables also drops new connections from the desktop. `infra/test-firewall.sh` tests the ruleset in network namespaces.
- **Secrets**: the desktop holds no secrets except its browser profile.
- **Brain secrets**: in `/etc/hatbot/secrets.env` (mode 600), loaded at start, never sent to the model.
- **Proxmox token**: privilege-separated, with a custom role (§9.3).
- **SSH**: a dedicated `hatbot` user on each allowlisted host, with a key per host and restricted sudo rules where needed.

### 6.5 Kill switch
- **Pause all** (in the UI and as an ntfy action) stops all loops, empties the queues and locks the desktop's input.
- **Resume** is a deliberate click.

---

## 7. Data

### 7.1 SQLite (SSD, WAL)
`messages` (thread; FTS5 index), `episodes`, `tasks`, `task_steps` (tool calls, results metadata, screenshot refs), `approvals`, `schedules`, `triggers`, `spend_ledger`, `sessions` (auth), `api_tokens`, `settings`, `mcp_servers`, `skills_index`.

### 7.2 Memory repo (`/var/lib/hatbot/memory`, git, SSD)
```
INDEX.md            ← always in context: short map of what's where (Hatbot keeps it current)
about-you.md        ← facts about you
preferences.md      ← how you like things done
homelab.md          ← hosts, services, what "healthy" looks like, runbooks
projects/<name>.md  ← per-project notes
skills/<name>.md    ← reusable procedures (from teach-by-showing or written after tasks)
journal/YYYY-MM.md  ← notable events, short
```
- **Commits**: every write is a commit authored `Hatbot <hatbot@local>`, with a message that names the task. Your edits from the UI are committed as you.
- **UI**: lists commits, shows diffs, and reverts a commit with one click.
- **Not pushed to any remote.** Backed up by PBS.

### 7.3 Archive (`/archive`, HDD pool mount)
- **Screenshots**: `screens/YYYY/MM/DD/<task>/<step>.webp`.
- **Raw transcripts**: compressed API request/response JSON.
- **Retention**: kept forever, and included in PBS backups.

---

## 8. API (for web and the future iOS app)
REST + JSON under `/api/v1`. One WebSocket at `/api/v1/stream` for events. A generated OpenAPI spec lives in `packages/shared`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login` (password + TOTP) → session cookie (web) or bearer token (apps) · `POST /auth/logout` · `GET/POST/DELETE /tokens` |
| Thread | `GET /thread/messages?before=` · `POST /thread/messages` (streams the reply over WS) |
| Tasks | `GET /tasks?status=` · `GET /tasks/:id` (+ steps) · `POST /tasks/:id/cancel` · `GET /tasks/:id/screens/:stepId` (a raised budget is an approval) |
| Approvals | `GET /approvals?pending` · `POST /approvals/:id` `{decision}` · `POST /approvals/:id/token-decision` (ntfy) |
| Desktop | `GET /desktop/status` · `POST /desktop/takeover` · `POST /desktop/handback` · `WS /desktop/live` (frames + input) · `GET /desktop/snapshots` · `POST /desktop/rollback` |
| Schedules/triggers | CRUD at `/schedules`, `/triggers` |
| Hooks | `POST /hooks/:id` (HMAC) · `POST /hooks/kuma/:id` |
| Memory | `GET /memory/tree` · `GET/PUT /memory/file?path=` · `GET /memory/log` · `GET /memory/diff/:sha` · `POST /memory/revert/:sha` |
| Spend | `GET /spend/summary` · `GET /spend/daily?days=30` |
| Teach | `POST /teach/start` · `POST /teach/stop` → draft skill · `POST /teach/:id/save` |
| Admin | `POST /pause-all` · `POST /resume` · `GET/PUT /settings` · `GET/POST /update` · CRUD `/mcp-servers` |

**WS events**: `message.created`, `message.delta`, `message.progress`, `message.done`, `task.updated`, `task.step`, `task.progress`, `approval.created`, `approval.resolved`, `desktop.state`, `spend.updated`, `memory.committed`, `paused`.

---

## 9. Infrastructure

### 9.1 Guests
| Guest | Type | vCPU | RAM | Disk | NICs |
|---|---|---|---|---|---|
| `hatbot-brain` | unprivileged LXC, Debian 13 | 2 | 2 GiB | 16 GB SSD + `/archive` mount on the HDD pool | `vmbr0`, static `192.168.55.<VMID+100>` |
| `hatbot-desktop` | unprivileged LXC, Debian 13, `nesting=1` | 2 | 1.5 GiB (+1 GiB swap) | 16 GB SSD | `vmbr0`, static `192.168.55.<VMID+100>`, MAC pinned in the host firewall |

The setup script checks the host's free RAM before creating anything, and stops with a clear message if there isn't enough.

### 9.2 `infra/host-setup.sh` (you review it, then run it once on the host)
How to run it: `infra/README.md`. Start with `--dry-run`. Settings are saved to `/etc/hatbot/host.env`, so re-runs reuse them.
1. **Preflight**: Proxmox version, uplink and LAN, that both guest IPs are free, free RAM, storages (SSD and HDD, confirmed by you), the template, whether the VMIDs are free. Re-runs find existing guests by name.
2. **Guests**: create both LXCs in pool `hatbot`, tagged `hatbot`, with static LAN IPs; add the `/archive` mount point (on the HDD storage, `backup=1`).
3. **Desktop firewall**: write the `bridge hatbot` table (§6.4) to `/etc/hatbot/host.nft` and load it with `hatbot-firewall.service`, which runs before `pve-guests.service`. Only then start the guests. The Proxmox firewall is left alone, and the script never starts or stops `nftables.service`, because its `flush ruleset` would wipe the Proxmox firewall.
4. **Proxmox access**: create the `hatbot@pve` user, the roles in §9.3 and the privilege-separated token `hatbot@pve!brain`. The token and the host's TLS fingerprint go to the brain's `/etc/hatbot/proxmox.env`.
5. **Desktop secrets**: generate the VNC password and the desktop-agent token, and write them to both guests.
6. **Provisioning**: push and run `infra/brain-provision.sh` and `infra/desktop-provision.sh` inside the guests.
7. **Snapshots**: a systemd timer on the host (`hatbot-desktop-snapshot.timer`, 04:00) snapshots `hatbot-desktop` and keeps 7. Skipped if the SSD storage can't snapshot (`dir`, for example).
8. **Backups**: check which PBS/vzdump jobs cover both guests; offer to add them to a job that lists VMIDs, or print what to change.
9. **Finish**: print a summary and the reverse-proxy targets. Then run `infra/verify.sh`.

The app itself is installed by `infra/deploy.sh`, run on the host for the first install. It sends a `git archive` of a commit to the brain, which installs it as a new release under `/var/lib/hatbot/releases`, builds the web app, writes and restarts `hatbot-brain.service`, and goes back to the previous release if the health check fails. The first run asks for the public URL, the reverse proxy's IP, the Anthropic API key, ntfy and the git repository to update from. After that, **Settings → Update** does the same from git: the brain writes a request file, `hatbot-update` (root, on the brain) fetches with a token the brain service can't read, sends desktop-agent its new code, and runs the new commit's `brain-deploy.sh`. Host-side scripts still change only through `deploy.sh`.

### 9.3 Proxmox roles
- **`HatbotOps` on `/`**: `VM.Audit`, `VM.PowerMgmt`, `Sys.Audit`, `Datastore.Audit`. Hatbot can see and start/stop/restart every guest.
- **`HatbotSnapshots` on `/pool/hatbot`**: `VM.Audit`, `VM.Snapshot`, `VM.Snapshot.Rollback`. Only Hatbot's own guests.
- **Never**: config change, allocate, console, migrate, or destroy rights. `infra/verify.sh` checks this.

### 9.4 Exposure (you own this part)
- **Your reverse proxy** → `http://<brain-LAN-IP>:8080` for `hatbot.gaycats.ovh`. It must pass WebSockets (`/api/v1/stream`, `/api/v1/desktop/live`). Hatbot trusts `X-Forwarded-*` from your proxy's IP only (`HATBOT_TRUSTED_PROXIES`, asked by `deploy.sh`).
- **ntfy** runs on your own server, separate from Hatbot. The brain publishes to it with a token whose user may write to Hatbot's topic (`deploy.sh` asks for the URL, topic and token). Set `upstream-base-url: https://ntfy.sh` on that server so iPhone notifications arrive instantly; only a "wake up and fetch" ping passes through ntfy.sh, never the message content.
- **Public paths needed**: the UI, the API, and `/api/v1/hooks/*` for webhooks.

### 9.5 Prerequisites (you)
- Max 20x with API credits linked to a Console org, plus an API key.
- Bot accounts: `hatbot` on Forgejo (and GitHub if wanted), added as collaborators to chosen repos.
- A `hatbot` user and SSH key on each allowlisted host.
- An Uptime Kuma webhook notification pointing at Hatbot.
- The ntfy iOS app subscribed to Hatbot's topic.

---

## 10. Web design spec
The visual reference is the clickable prototype in [`prototype/`](prototype/). Open `prototype/index.html`.

### 10.1 Direction
- **Look**: Apple-native, macOS-app style, **desktop-first**.
- **Layout**: three panes: **sidebar · chat · side panel (live view / details)**. Each pane collapses.
- **Theme**: follows the system's light/dark setting, with a manual override (System / Light / Dark).
- **Materials**: translucent sidebar and toolbars (`backdrop-filter`), gentle spring motion, `prefers-reduced-motion` respected.

### 10.2 Tokens
| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | `#E8820C` | `#FF9F2E` | Hatbot brand: logo, send button, user bubbles (tinted), selection |
| `--attention` | `#007AFF` | `#0A84FF` | **Needs you**: approve buttons, pending badges, takeover border |
| `--danger` | `#FF3B30` | `#FF453A` | Deny, destructive, errors |
| `--success` | `#34C759` | `#30D158` | Done, healthy |
- **Fonts** (self-hosted variable woff2, both OFL-1.1, same on every platform):
  - Inter for UI chrome: sidebar, toolbar, titles, buttons, labels, tables.
  - Noto Sans (`--font-text`) for reading text: chat messages, card bodies, the composer.
  - Mono is `ui-monospace, "SF Mono", Menlo`.
- **Chat messages**: no avatar or sender name; the timestamp sits under each message (left for Hatbot, right for you).
- **Icons**: **Lucide**. SF Symbols aren't licensed for the web. The brand mark is a minimal line-drawn hat.
- **Components**: built on unstyled **Radix** primitives (dialog, popover, dropdown, tabs, switch, tooltip) styled with CSS variables. No Tailwind.

### 10.3 Layout
- **Desktop (≥ 900px)**:
  - **Sidebar** (240px): Chat, Tasks (with a count of what needs you), Live, Schedules & Triggers, Memory, Spend, Settings.
  - **Centre**: a toolbar with the title, status and *Pause all*, then the content.
  - **Side panel** (420px, toggled from the toolbar): **Live**. Task details are their own page (`/tasks/:id`).
- **Phone (< 900px)**:
  - A single column with an iOS-style **bottom tab bar** (Chat, Tasks, Live, Memory, Settings). Spend opens from Settings.
  - Live is a full page; a Keyboard button opens the phone's keyboard during takeover.

### 10.4 Chat cards
- **Task**: title, origin, lane, model, steps, cost, status, live thumbnail while running.
- **Approval**: what Hatbot wants to do, why, which untrusted source tainted the task, a preview, **Approve** (blue) and **Deny**.
- **Alert**: an Uptime Kuma event, followed by what Hatbot found and did.
- **Memory change**: file, diff, **Revert**.
- **Schedule created**: name, cadence, origin, toggle.

Markdown and code blocks render fully.

### 10.5 Live view
- **Watch-only by default.**
- **Take over**: a blue 2px border and a banner, *"You're in control — Hatbot is paused"*, with **Hand back**.
- **When Hatbot asks**: the panel shows its reason ("Captcha on example.com") and you get an ntfy push.
- **Teach mode**: a red recording dot and *"Recording — show Hatbot how"*, with **Stop & create skill**.

---

## 11. Milestones

Each milestone ends with a working, demo-able system.

### M0 — Setup
- [x] `git init`, monorepo skeleton (Bun workspaces, Biome, tsconfig, `bun test`), private repo `kubus/hatbot` on Forgejo
- [ ] CI via Forgejo Actions, if a runner exists
- [x] `infra/host-setup.sh` written
- [x] … reviewed with you, then run on the host
- [x] `infra/brain-provision.sh` (Bun, git, memory repo, firewall) and `infra/desktop-provision.sh` (Xvnc, XFCE, Chromium; desktop-agent itself comes in M2)
- [x] `infra/verify.sh`: brain reaches the desktop; desktop can't reach the LAN or the host; token permissions are correct; snapshots and backups are set up
- [x] `verify.sh` passes on the host
- **Done when**: both guests are up, isolated, and backed up by PBS.

### M1 — Brain core + UI shell
- [x] Hono API, SQLite schema + migrations, password + TOTP auth, API tokens
- [x] Custom agent loop (Sonnet), streaming, caching, spend ledger + limits
- [x] Episodic thread (§5.3), `search_history`, thread summaries (Haiku)
- [x] Memory repo + tools + UI (tree, editor, history, diff, revert)
- [x] Web PWA built from the prototype: shell, chat, Memory, Spend, Settings
- [x] Pause all
- [x] `infra/deploy.sh`: releases, health check, rollback
- [x] Update from git with a button in Settings (`infra/hatbot-update.sh`)
- [ ] Deployed and tried from a phone and a laptop
- **Done when**: you can chat with Hatbot from a phone and laptop, it remembers things in markdown, and spending is enforced.

### M2 — Desktop + safety
- [x] desktop-agent daemon; `run_desktop_task` subloop on Opus with `computer_toolset_20260801`
- [x] Tasks: chat cards, Tasks view, task timelines + archive writer (from M1; tasks first exist here)
- [x] Screen-lane queue, release on wait, re-check screen on resume
- [x] Live view (MJPEG, relayed by the brain); Take over / Hand back; `request_takeover`
- [x] Trust tracking, approval gates, `confirm_intent`, Haiku injection screening
- [x] ntfy notifier (publishing to your ntfy server) + signed action buttons
- [x] Nightly desktop snapshots + "Roll back desktop" in Settings (Proxmox API, pinned TLS fingerprint)
- [ ] Tried live: "book a table at X" with an approval from the lock screen
- **Done when**: "book a table at X" works end to end, with an approval from your lock screen.

### M3 — Triggers
- [ ] Scheduler (cron + one-shot), agent-created schedules from chat, Schedules & Triggers UI
- [ ] Generic HMAC webhooks (per-trigger secret, trusted/untrusted flag)
- [ ] Uptime Kuma adapter
- **Done when**: "every morning at 8, check X" runs unattended and reports back.

### M4 — Homelab tools + MCP
- [ ] `proxmox_*` tools using the scoped token
- [ ] `ssh_exec` with allowlist + destructive-pattern gate
- [ ] `forge_*` for Forgejo + GitHub bot accounts
- [ ] Uptime Kuma alert handling: investigate → safe restart → report
- [ ] MCP client + per-tool allow/ask/block UI
- **Done when**: a Kuma "down" alert at 3am is fixed or diagnosed before you wake up.

### M5 — Teach-by-showing
- [ ] Record mode in takeover (live-view input events + screenshots + CDP URL/title)
- [ ] Opus turns a recording into a draft `skills/<name>.md` with placeholders → you review and save
- [ ] Skills index in the memory INDEX; Hatbot picks a skill up when a task matches
- **Done when**: you demo a chore once and Hatbot repeats it on a schedule.

### After v1
Native iOS app (SwiftUI, SideStore, ntfy) · email via Proton Bridge · more than one agent · a heartbeat that acts on its own · open-source release (choose a licence, docs, one-command installer).

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Prompt injection while running autonomously with persistent sessions | Trust tracking + approvals, Haiku screening, Anthropic's checks, desktop isolation, takeover for logins only |
| Unprivileged LXC shares the host kernel with a browser on untrusted sites | Chromium sandbox on (`nesting=1`), no LAN, no secrets on the desktop, nightly snapshots; can move to a KVM VM later if RAM allows |
| RAM pressure on a 16 GiB host | Small guests, swap on the desktop, preflight check, one screen lane |
| Cost overruns from screenshot-heavy tasks | Spending limits, 1280×800, caching, server-side context clearing, Sonnet test for desktop work |
| API and tool versions change (fast-moving platform) | Model IDs and tool versions live in config; check against live docs at each milestone |
| Sites block automation / captchas | `request_takeover` flow |
| "Keep forever" archive growth | WebP screenshots, HDD pool, PBS deduplication; monitor size in Spend/Settings |

---

## 13. Assumptions to confirm during M0
1. The thread uses the 1-hour prompt cache, so the 30-minute idle window stays cheap.
2. ntfy runs on your own server with its own public hostname, and the brain reaches it; webhooks use `hatbot.gaycats.ovh/api/v1/hooks/*`.
3. The desktop LXC uses `nesting=1` for Chromium's sandbox.
4. Guest sizes: brain 2 GiB, desktop 1.5 GiB / 2 vCPU. The preflight checks real free RAM first.
5. Skills live in the memory repo under `skills/`.
6. The roles are as described in §9.3.
