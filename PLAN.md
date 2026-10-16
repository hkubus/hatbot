# Hatbot — Plan

A self-hosted, always-on personal agent built on Claude, running on your Proxmox homelab. It's an alternative to OpenAI Dots and xAI Grok Bot, and it fixes what they get wrong:

- **Memory you can read.** Memory is plain markdown, not hidden.
- **Real isolation.** Each agent's desktop is in its own fenced-off container, unlike Grok Bot's shared VM.
- **No vendor cloud.** It runs on your hardware.
- **Predictable cost.** Spending limits are enforced.

> Status: design agreed 2026-10-09. M0–M5, the iOS app, more than one bot (§14) and looking after things (§15) are built. M4 onwards is not yet deployed or tried live, and the iOS app awaits its first install. Next is the owner's deploy and live run (`HANDOFF.md`). The clickable UI prototype lives in [`prototype/`](prototype/).

---

## 1. Scope

### v1 is
- One personal agent, **Hatbot**, that you reach through a web app (desktop-first PWA, also usable on the phone).
- A persistent **Linux desktop** (Chromium + terminal) that Hatbot drives with Claude computer use. You can watch it live and take over.
- **One-off tasks** and **recurring/triggered tasks**: schedules, signed webhooks, Uptime Kuma alerts.
- **Homelab ops**: Proxmox status, restarts, SSH to approved hosts, Forgejo/GitHub via bot accounts, plus any MCP server.
- **Teach-by-showing**: you demo a task on the desktop, and Hatbot turns it into a reusable skill.
- **Memory**: a git-tracked markdown folder that Hatbot edits and you can read, diff and revert.
- A native **iOS app** (SwiftUI, sideloaded with SideStore) for chat, tasks, approvals and the live view (§4.7).
- **More than one bot**, each with its own role, chat, memory folder and browser profile, handing work to each other (§14).
- **Looking after things**: a heartbeat that looks for problems and acts on them with your instructions, watchers, Check everything and a weekly report (§15).

### v1 is not
- Email or calendar. You use Proton Mail and no calendar; this can come later via Proton Bridge.
- Open-ended goals ("grow my newsletter"). The heartbeat follows your instructions about problems it finds; it doesn't set goals of its own.
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
| Models | **Haiku 5.5** by default for chat, background tasks and the desktop (each can be switched to Opus in Settings), and for triage, summaries and injection screening · **Opus 5.5** for `ask_opus`, desktop tasks Haiku fails, and teach-by-showing · no Sonnet or Fable (§5.4) |
| Agent loop | **Custom loop on the raw Messages API**, with no Agent SDK. Same model quality; we own context, caching and cost |
| Tools | Built-in TypeScript tools; integrations (Proxmox, SSH, Forgejo, MCP) are **plugins** that ship with Hatbot and are switched on in Settings (§4.5) |
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
| Repo | Bun-workspaces monorepo `kubus/hatbot`, public, on Forgejo `git.gaycats.ovh`; Forgejo push-mirrors it to GitHub `hkubus/hatbot` (deploy key), where CI runs |
| Exposure | `hatbot.gaycats.ovh`. You handle the tunnel, TLS and reverse proxy; Hatbot serves plain HTTP on the LAN |
| Auth | Single user, password + TOTP; API tokens for the iOS app |
| Notifications | Your self-hosted **ntfy**, on its own server; the brain publishes to it. No APNs or Web Push, because the iOS app is a free SideStore sideload |
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
- **Scheduler**: cron expressions (via `croner`, MIT) and one-shot times in the brain's time zone, stored in SQLite and checked every 10 s in-process. A run missed while the brain was down or paused happens once when it's back; runs at most every 5 minutes.
- **Trigger ingress**: `POST /hooks/:id`, checked by HMAC signature (`X-Hatbot-Signature: t=…,v1=…` over `t.body`, or the `X-Hub-Signature-256` / `X-Forgejo-Signature` that GitHub and Forgejo send), with replays dropped. Uptime Kuma can't sign, so `/hooks/kuma/:id` takes the trigger's secret in the URL (`?token=`, what the setup panel shows) or as a bearer token, and accepts every way Kuma sends: JSON, form data, or GET. Kuma's Test message sends you a notification. Every hook logs what it did with the request.
- **Tool host**: the built-in tools (§5.5) and the plugins' tools (§4.5).
- **Policy engine**: trust tracking, approval gates, spend enforcement (§6).
- **Live-view relay**: JPEG frames from desktop-agent out to the browser, and your pointer and key events in while you have control. M5 records these input events for teach-by-showing. (noVNC was the first plan; it's MPL-2.0, so the view is our own MJPEG stream.)
- **Notifier**: publishes to ntfy, including action buttons.
- **Storage**: SQLite (WAL) on SSD; `memory/` git repo on SSD; `/archive` (screenshots, raw transcripts) on the HDD mount.

### 4.2 `apps/desktop-agent` — tiny Bun daemon inside the desktop LXC
- `POST /screenshot`: captures the X display (1280×800) and returns lossless WebP.
- `POST /action`: runs the computer-use actions (click, drag, type, key, scroll, hold_key, mouse down/up, cursor_position, wait) through `xdotool`.
- `POST /zoom`: crops a region at full resolution.
- `POST /browser`: runs a browser toolset member (`browser_toolset_20260801`: navigate, read_page, find, get_page_text, clicks and typing by element reference or viewport point, form_input, screenshot, zoom, tabs) on the running Chromium over CDP. Element references live in an isolated world the page can't touch. Dialogs are dismissed and reported; `javascript_exec`, `file_upload`, console and network reads stay off.
- `GET /browser/state`: the open tabs and what changed since the last report (tabs opened, downloads, dismissed dialogs), for the toolset's `browser_state` block. `POST /browser/inspect`: the element a browser click or Enter would hit, for §6.1.
- `GET /context`: the current Chromium URL and title, read through CDP on localhost. Used for logging and the trust tracking in §6.1.
- `POST /inspect`: the element under a point (or the focused one), for the consequential-click check in §6.1.
- `POST /lock` / `/unlock`: input lock used during takeover.
- `WS /live`: an MJPEG stream (ffmpeg x11grab, 15 fps; a slow viewer skips frames) while someone watches, and your input while you have control.
- Auth: a shared bearer secret. The desktop's firewall only accepts the brain, and the host's bridge filter drops the desktop's replies to anyone else.
- Services: `Xvnc :1` (TigerVNC, 1280×800), XFCE (lightweight), Chromium with a persistent profile, `desktop-agent`. All managed by systemd.

### 4.3 `apps/web` — React + Vite PWA
Desktop-first, three panes. Design spec in §10; visual reference in `prototype/`.

### 4.4 `packages/shared`
Shared API types and zod schemas for the brain and web. The iOS app mirrors the types it uses in `apps/ios/Hatbot/Core/Models.swift`; change both together.

### 4.5 Plugins (`apps/brain/src/plugins/`)
Integrations are plugins: Proxmox, Proxmox Backup Server, SSH, Home Assistant, Uptime Kuma, Forgejo, GitHub, Code and MCP. The core keeps memory, chat history, schedules, tasks and the desktop.
- **Shape**: each plugin is a folder exporting one `definePlugin({...})`: an id, a name, its settings (a zod schema whose fields all have defaults), the environment variables it reads from `/etc/hatbot/*.env` (secrets never reach the model or the web app), and `start(ctx)`, which returns its status, tools, an optional paragraph for the system prompt and an optional Test.
- **Built in, not installed at runtime**: plugins ship with Hatbot. Code loaded at runtime would run in the brain next to the API key, the Proxmox token and the SSH key. Third-party extensions come in through the MCP plugin, whose servers run as separate processes behind the same approval rules.
- **On and off**: every plugin starts off. Settings → Plugins switches one on and edits its settings; it restarts with them. One that's on but missing its secrets or settings shows *Needs setup* and offers no tools.
- **Tools**: named `<plugin id>_…`. A **read** tool looks without changing anything; the chat calls it directly. A **write** tool changes something. The chat makes at most two changes in a reply itself (a restart, a command, a comment), through the same checks and approvals as a task; more than that goes to a task with `run_task` (§5.5). A tool can mark its output **untrusted** (issue text, MCP output): it's wrapped as labelled JSON, and a task or chat episode that reads it becomes tainted.
- **Policy**: a write tool may have a `policy(input, task)` that allows, asks you first, or refuses. The core takes the stricter of that and the untrusted-content rule (§6.1), raises the approval, and logs the call on the task's timeline. Plugins never build approvals themselves.
- **Prompt cache**: the chat's tools and system prompt include the plugins that are on, so switching one on or off starts a new episode (§5.3). A task fixes its tools when it starts.
- **MCP stdio servers** run inside the brain as the `hatbot` user with a clean environment (no inherited secrets), but that user can read `/etc/hatbot/*.env`. Run only servers you trust that way; prefer HTTP servers elsewhere.
- **Web**: Settings lists the plugins; each has a page with its switch, which secrets are set, its settings form (`apps/web/src/plugins/<id>.tsx`), a Test button and its tools.

### 4.6 `infra/`
- `host-setup.sh`: the one-time Proxmox setup script (§9).
- the provisioning scripts for both guests, `verify.sh`, and `deploy.sh`, which installs the app and its systemd unit.

### 4.7 `apps/ios` — SwiftUI
- **Native**: SwiftUI, built with the newest Xcode and iOS SDK (27), running on iOS 18+. SF Symbols and the system font, the same amber, blue, red and green as the web. No dependencies.
- **Liquid Glass**: system bars, tab bar and lists get it from the SDK. The chat composer, the paused banner, the toast and the buttons use glass on iOS 26+ (a material before); messages and screenshots stay solid. The sidebar is a solid drawer, not glass.
- **Sidebar**: chat fills the screen; Chat, Search, Tasks, Live, Memory and Settings sit in a drawer under the left edge. A swipe in from the edge (on a section's first page; deeper, it's the back swipe) or the menu button at the top left slides the section aside to show it, following the finger; a swipe back or a tap on the section closes it. The button and the Tasks row count what needs you.
- **Scroll to bottom**: scrolled well up in chat, a round button above the composer jumps back to the latest.
- **Auth**: password + TOTP once, then a bearer token named after the device, kept in the Keychain. Signing out deletes the token on the brain.
- **Live events**: the same `/stream` WebSocket while the app is in front; it reconnects and reloads after a gap. iOS stops it in the background, so notifications stay with the ntfy app.
- **Live view**: the `/desktop/live` frames. During takeover a tap clicks, a drag drags, a long press right-clicks, two fingers scroll, and a Keyboard button types.
- **Build**: `project.yml` (XcodeGen) → `build-ipa.sh` makes an unsigned IPA; SideStore signs it with your Apple ID. The GitHub mirror's iOS workflow builds it on macOS for every change and, on `main`, publishes it with a SideStore source at `https://hkubus.github.io/hatbot/source.json`, so SideStore installs and updates it. `Hatbot/Core` is also a Swift package, tested with `swift test` (on Linux too).
- **Links**: `hatbot://tasks/<id>` and `hatbot://approvals/<id>`.
- **Siri and Shortcuts**: App Intents in the app: Ask Hatbot (`POST /thread/ask`, which waits up to 25 seconds for the reply), Give Hatbot a Task (`/task`), Send to Hatbot (text and files).
- **Share sheet**: the `HatbotShare` extension sends text, links, photos and files with a note to Hatbot's chat. The app keeps the token in the App Group's Keychain access group (`group.ovh.gaycats.hatbot`, renamed by SideStore with the team ID) and the address in the group's defaults. It's a second App ID in SideStore.

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
- **An update that changes the system prompt, the tools or the chat model** also starts a new episode: Opus 5.5 checks each replayed thinking block against the prompt, tools and messages it was made with, and rejects the request on a mismatch. As a backstop the chat sends `block_binding.prefix_mismatch_behavior: "drop_block"`, so a block that still fails is dropped (and logged) instead of failing the reply.
- **After 30 minutes idle**, the next message starts a new episode containing:
  - the system prompt
  - the memory index
  - a rolling **thread summary** (updated by Haiku once an episode has been idle for 30 minutes, which also writes the episode's one-line recap)
  - the last ~10 messages
  - your new message
- **`search_history(query, range?)`**: a full-text search over the thread in SQLite (FTS5). Hatbot pulls in older messages only when it needs them.
- **Tasks started from chat** run in their own contexts; their progress and result show under the reply that started them (§10.4). The thread never carries a 30-step browser transcript.
- **Durable facts** go to memory, not the thread.

### 5.4 Model routing
| Job | Model | Notes |
|---|---|---|
| Chat, planning, non-screen tools | `claude-haiku-5-5` by default, or `claude-opus-5-5` (Settings → Chat); effort `low` (Settings: low or medium) | On Haiku the chat has `ask_opus`: one Opus 5.5 call (effort `high`, no tools) per reply at most, for code, debugging and multi-step reasoning, its answer streamed into the reply as is. Haiku has no server-side fallback, so a refusal ends the reply with a note. Changing the model or effort starts a new episode or drops the cache, so heavier work runs as a task instead |
| Desktop driving (`run_desktop_task`) | `claude-haiku-5-5`, effort `medium`; when Haiku fails, the same task carries on once on `claude-opus-5-5` (Settings → Desktop: the model, and "Try again on Opus when Haiku fails", on by default) | Native `computer_toolset_20260801` plus `browser_toolset_20260801` for web pages. Haiku is cheap but fails more (72% on OSWorld); Opus reads screenshots best. Haiku's tasks run without `display: "updates"`, which isn't documented for it. See "Desktop escalation" below |
| Schedules and triggers (background tasks) | `claude-haiku-5-5` by default, or `claude-opus-5-5` (Settings → Tasks); the chat's effort | Same kind of work as chat, without a screen (§5.6) |
| Injection screening, thread summaries, alert triage | `claude-haiku-5-5`, effort `low` | $0.10/$0.50 per 1M tokens up to 100k-token prompts, 5x above (whole request). Thinks by default |
| Writing code (`forge_*`, `ssh_exec` work, M4) | the background tasks' model, effort `medium`; `high` when you ask or after a failed attempt | Runs as a task with its own card, spend limit and timeline, like desktop tasks |
| Teach-by-showing skill writing | `claude-opus-5-5` | Infrequent |

Chat requests opt into server-side fallback (`fallbacks: "default"`): if the model refuses, the API retries on a fallback model, and the spend ledger bills each model that ran at its own rates.

Why these (Artificial Analysis Intelligence Index, score and cost per index task, October 2026): Haiku 5.5 medium–max 34–43 at $0.05–0.21; Opus 5.5 medium 51 at $1.34, high 54 at $1.82, xhigh 56 at $3.46, max 58 at $5.98; Sonnet 5.5 low/medium 36/41 at $0.41/0.48, high 47 at $0.88, max 56 at $5.5–7.7. Every Sonnet setting is beaten on score or price by Haiku 5.5 or Opus 5.5. Opus low (42 at $0.55) loses to Haiku max on the index, but chat turns are short and tool-driven: a big model with little thinking answers faster and judges better, and cache reads cost the same as Sonnet's. Fable 5.1 and Opus xhigh/max cost 2–4x for a few points; not used.

**Desktop escalation** (decided 2026-10-16): a Haiku desktop task that runs out of steps (80) or time (30 minutes), is refused, is cut off, or finishes as failed on its own carries on once on Opus, in the same task: its card, its timeline, its parent's wait and its spend limit stay. Haiku is first asked, on its own cached conversation, what it tried; Opus starts afresh with the task, that account and why Haiku stopped, on the desktop as Haiku left it (`escalated_from` on the task, migration 28). Budget stops, cancellations, takeovers nobody answered and "Blocked: …" endings (a login or captcha) don't carry on, since Opus can't get past them either. The weekly report has a line per model a desktop task started on: done, failed, and how many of Haiku's failures Opus then finished.

Check tool versions and model IDs against the live docs at implementation time.

### 5.5 Built-in tools (brain)
| Tool | Lane | Default policy |
|---|---|---|
| `run_desktop_task(goal, success_criteria)` | screen | Starts the Opus computer-use subloop; queued per §5.6 |
| `run_task(title, goal, effort?)` | bg | Chat only. Starts a background task with every plugin tool, for work that takes more than two changes or should carry on without you (§4.5); shows under the reply |
| `request_takeover(reason)` | screen | Pauses and notifies you (logins, 2FA, captchas) |
| `desktop_shell(command)` | screen | Desktop tasks only. Runs as `hatbot-desktop-shell`'s own systemd DynamicUser (home `/var/lib/hatbot-shell`): no `/home` (the browser profile), no screen, no secrets, Unix socket relayed by desktop-agent. Destructive patterns ask |
| `memory_*` (list/read/write/search) | bg | Free; every write is a git commit |
| `search_history` | bg | Free |
| `schedule_*` / `trigger_*` (create/list/update/delete) | bg | Free; everything visible in the UI |
| `web_fetch` / `web_search` | bg | Free; output is **untrusted** |
| `proxmox_*` plugin (status, list, start/stop/restart, snapshot of own guests) | bg | Read and restart free; anything else needs approval |
| `ssh_exec(host, cmd)` plugin | bg | Hosts from Settings, as the `hatbot` user; destructive patterns need approval |
| `ssh_pct_exec(host, guest, cmd)` plugin | bg | Optional: a command in a Proxmox container through a host marked "Proxmox host" (`infra/pct-exec-setup.sh`): root in the container via a sudo-only wrapper that refuses Hatbot's own guests; same rules as `ssh_exec` |
| `forgejo_*` plugin (read, comment, open PR) | bg | Merge, force-push and delete need approval |
| `github_*` plugin (the same, on GitHub) | bg | Merging, committing to the default branch and changing workflows ask |
| `watch_*` (create/list/update/delete) | bg | Free; a watcher made after untrusted content starts its tasks tainted (§15) |
| `notify(message, priority)` | bg | Free |
| `mcp_*` plugin (each server's tools) | bg | Default **ask**; set allow/ask/block per tool |

The `run_desktop_task` **subloop** uses the computer toolset against the desktop-agent daemon, plus the browser toolset for web pages:
- The model reads pages as text and acts on elements by reference, and takes a screenshot only when it needs to see the page. It starts from the list of open tabs instead of a screenshot; the timeline still gets one.
- A batch of toolset calls stops at the first failure (or held-back click); the rest get the API's "Not executed" text.
- Screenshots go to `/archive` as WebP and into the task timeline.
- The subloop returns a structured summary to the parent.

### 5.6 Scheduling and lanes
- **Screen lane**: a single FIFO queue. While a screen task waits for approval or takeover, it **releases** the lane. When it resumes, it takes a fresh screenshot and re-checks the state before doing anything.
- **Background lane**: a worker pool, with a concurrency of 3 by default.
- **Scheduled and trigger tasks**: background tasks on Opus 5.5 (the chat's effort setting) with memory, history search and `run_desktop_task`, which waits for the desktop task and returns its summary as untrusted data. They can't create schedules. They enter the same queues. If one fires while its previous run is still going, the new run is skipped: one run at a time per schedule, per webhook, and per Uptime Kuma monitor (later alerts and "back up" go on the running task's timeline).
- **Reporting**: a run ends with `finish_task(summary, notify)`. With news (or a failure) it posts a message in the thread and sends a notification, and the chat hears about it in `<task_updates>`; a routine result only shows in Tasks and on its schedule's page.

---

## 6. Safety model

### 6.1 Trust tracking
Every piece of content entering a context is labelled **trusted** or **untrusted**.

**Trusted:**
- your chat messages
- memory files
- Uptime Kuma alerts
- command output from your hosts, except logs and files (below)
- Proxmox API data

**Untrusted:**
- web pages, screenshots and page text
- `web_fetch` / `web_search` results
- Forgejo/GitHub issue, PR and comment text
- generic webhook payloads (each trigger can be marked trusted)
- MCP tool output (unless the server is marked trusted)
- logs and files read from your hosts (`ssh_check logs`/`errors`, `ssh_read_file`): anyone who reaches a service can write into its logs

Once a task has read **any untrusted content**, it is *tainted*. In a tainted task, these **outward actions** need your approval:
- sending or posting
- submitting forms that send personal data
- deleting
- buying
- changing remote state (SSH writes, Proxmox power actions, forge writes)

Untainted tasks stay fully autonomous. **Haiku's review:** before any change that would ask, whether this rule or a plugin's own policy asks, tainted or not, in the chat or in a task, Haiku 5.5 reviews it: it sees your request or standing instructions, the goal, the names of the untrusted sources if any (never their text) and the action. If it isn't destructive or dangerous (a restart, a reload, a re-run, a fix to what the work is about, a merge or a post you asked for), it goes ahead and the timeline says so. Deleting and other hard-to-undo changes, taking things down for good, account, key, sudo, firewall or persistence changes, posting or sending what you didn't ask for, fetching and running code, home access, and anything whose input looks like it came from untrusted content still ask, with Haiku's reason. Doubt or a failed check means asking; suspected injection skips the review. Settings → Safety turns it off. (2026-10-13, the owner's choice: this replaced a separate "you already asked for this" check, which only ever saved taps the review now saves.) **Always approval, no review:** payments, purchases, credential and account-security changes, budget, hosts and guests you marked careful, and locks, the alarm, doors and gates in Home Assistant.

How it's enforced:
- **Screen actions**: Opus requests consequential steps through a small `confirm_intent(kind, summary)` tool before submitting. The policy engine also flags clicks on buttons such as *submit, pay, buy, delete, send, confirm*, using the screen text and CDP. Browser toolset clicks are checked the same way, by element reference or viewport point.
- **Defence in depth**:
  - Untrusted text only ever enters through tool results, labelled with its source and JSON-encoded.
  - The system prompt states the untrusted-content policy.
  - Haiku 5.5 screens untrusted text and flags `injection_suspected`; a flag adds an extra approval and a warning badge.
  - Anthropic's built-in computer-use and browser-use injection checks stay on.

### 6.2 Approvals
- **An approval contains**: the action, its arguments or a preview, *why* Hatbot wants to do it, the untrusted sources that tainted the task, a screenshot if relevant, and the cost so far.
- **Where you approve**: in the web UI (inline card + side panel), or with ntfy action buttons.
- **ntfy buttons**: carry a **single-use, short-lived signed token** (HMAC over approval ID + decision + expiry). Payments and credential approvals only show *Open in Hatbot*.
- **Steering**: with Approve or Deny you can write a note, in the web UI or the app (not from ntfy). The task gets it with the decision and follows it: deny and say what to do instead, or approve and say how. The note counts as your words for the check below, so the action it asks for doesn't ask again. Not for budget or injection warnings.
- **Waiting**: the task pauses and frees the screen lane. It auto-cancels after **24h** and notifies you.

### 6.3 Spending
- **Price table**: per-model prices live in config. Cost = `usage` × price, recorded per request, task and day.
- **Before each request**: estimate the input cost. Refuse if it would exceed the per-task ($3), daily ($10) or monthly ($200) limit.
- **A task's own limit**: the task asks to spend one more per-task limit ($3), as an approval. Approve and it carries on; deny, or no answer in 24h, and it fails ("Stopped at its spending limit.").
- **The daily or monthly limit**: the task fails at once with "Stopped: Today's $10 limit would be exceeded." (or the month's), and a chat reply stops with the same line. Nothing more runs until the limit resets or you raise it in Settings.
- **Credits**: the Max 20x API credits are the only funding source, so the provider stops requests at $0 as a backstop.

### 6.4 Isolation
- **Network**: both guests sit on the LAN bridge with static IPs. The host's nftables table `bridge hatbot` filters frames at the desktop's bridge port (`veth<ID>i0`), where the desktop can't touch it. It allows only the desktop's own MAC and IP (no spoofing, no ARP poisoning), drops IPv6 and non-IP traffic, drops everything to private ranges (including `192.168.55.0/24`) and to the host itself, and lets through only replies to the brain on 5901/7070. Inside the brain, nftables also drops new connections from the desktop. `infra/test-firewall.sh` tests the ruleset in network namespaces.
- **Secrets**: the desktop holds no secrets except its browser profile.
- **Brain secrets**: in `/etc/hatbot/secrets.env` (mode 600), loaded at start, never sent to the model.
- **Proxmox token**: privilege-separated, with a custom role (§9.3).
- **SSH**: a dedicated `hatbot` user on each allowlisted host, with a key per host and restricted sudo rules where needed.

### 6.5 Kill switch
- **Pause all** (in Settings → Safety, and as an ntfy action) stops all loops, empties the queues and locks the desktop's input.
- **Resume** is a deliberate click.

---

## 7. Data

### 7.1 SQLite (SSD, WAL)
`messages` (thread; FTS5 index), `episodes`, `tasks`, `task_steps` (tool calls, results metadata, screenshot refs), `approvals`, `schedules`, `triggers`, `spend_ledger`, `sessions` (auth), `api_tokens`, `settings` (including each plugin's switch and settings), `skills_index`.

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

## 8. API (for web and the iOS app)
REST + JSON under `/api/v1`. One WebSocket at `/api/v1/stream` for events. The types live in `packages/shared`. A 400 is `{error, field?}`, naming zod's first issue.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login` (password + TOTP) → session cookie (web) or bearer token (apps) · `POST /auth/logout` (ends the session, or the bearer token it's called with) · `GET/POST/DELETE /tokens` |
| Thread | `GET /thread/messages?before=` · `POST /thread/messages` (streams the reply over WS) · `POST /thread/ask` (waits up to 25 s for the reply, for Siri) · `POST /thread/messages/:id/retry` and `/conversations/:id/messages/:id/retry` (an errored latest reply, written again in place) · `GET /thread/episodes?ids=` (recaps) |
| Tasks | `GET /tasks?status=&before=&limit=&botId=&origin=` · `GET /tasks/:id` (+ steps) · `POST /tasks/:id/cancel` · `POST /tasks/:id/rerun` `{goal?}` · `GET /tasks/:id/screens/:stepId` (a raised budget is an approval) |
| Approvals | `GET /approvals?pending` · `POST /approvals/:id` `{decision}` · `POST /approvals/:id/token-decision` (ntfy) |
| Desktop | `GET /desktop/status` · `POST /desktop/takeover` · `POST /desktop/handback` · `WS /desktop/live` (frames + input) · `GET /desktop/snapshots` · `POST /desktop/rollback` |
| Schedules/triggers | CRUD at `/schedules`, `/triggers` · `POST /schedules/:id/run` · `POST /triggers/:id/secret` (a new secret, shown once) · `GET /tasks?scheduleId=&triggerId=` |
| Hooks | `POST /hooks/:id` (HMAC) · `POST/GET /hooks/kuma/:id?token=` |
| Memory | `GET /memory/tree` · `GET/PUT /memory/file?path=` (GET gives the blob `sha`; PUT with `baseSha` answers 409 if it changed) · `GET /memory/log?skip=` · `GET /memory/diff/:sha` · `POST /memory/revert/:sha` |
| Spend | `GET /spend/summary` (today, month, last hour and minute, with tokens) · `GET /spend/hourly?hours=24` · `GET /spend/daily?days=30` · `GET /spend/by-model` · `GET /spend/by-bot` · `GET /spend/by-purpose?days=30` |
| Teach | `GET /teach` (recording + drafts) · `POST /teach/start` · `POST /teach/stop` → draft skill · `GET /teach/:id` · `POST /teach/:id/draft` (again) · `POST /teach/:id/save` `{name, content, replace?}` · `DELETE /teach/:id` |
| Admin | `POST /pause-all` · `POST /resume` · `GET/PUT /settings` · `GET/POST /update` |
| Plugins | `GET /plugins` · `GET/PATCH /plugins/:id` `{enabled?, config?}` · `POST /plugins/:id/test` |
| Watchers | CRUD at `/watchers` · `POST /watchers/preview` (a try, saving nothing) · `GET /watchers/:id/values` · `POST /watchers/:id/check` |
| Looking after | `GET/POST /checks` (`?text=1` for `infra/smoke.sh`) · `POST /checks/approval` · `GET /heartbeat` · `POST /heartbeat/run` · `GET /report` · `POST /report/send` |
| Proposals | `GET /proposals?status=` · `POST /proposals/tidy` · `POST /proposals/:id/apply` · `POST /proposals/:id/dismiss` · `GET /skills` · `POST /skills/:name/fix` |
| Search | `GET /search?q=` (messages, tasks, memory, schedules, triggers and watchers) |

**WS events**: `message.created`, `message.delta`, `message.progress`, `message.done`, `task.updated`, `task.step`, `task.progress`, `approval.created`, `approval.resolved`, `desktop.state`, `spend.updated`, `memory.committed`, `paused`, `schedule.updated`, `schedule.deleted`, `trigger.updated`, `trigger.deleted`, `plugin.updated`, `watcher.updated`, `watcher.deleted`, `proposal.updated`, `settings.updated`, `heartbeat.updated`.

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
- **Commands in containers** don't use the token: the optional `infra/pct-exec-setup.sh` gives a `hatbot` Unix user on the host one sudo rule, for a wrapper around `pct exec` that refuses the brain and desktop. It makes Hatbot root inside your other containers, by the owner's choice (2026-10-11).

### 9.4 Exposure (you own this part)
- **Your reverse proxy** → `http://<brain-LAN-IP>:8080` for `hatbot.gaycats.ovh`. It must pass WebSockets (`/api/v1/stream`, `/api/v1/desktop/live`). Hatbot trusts `X-Forwarded-*` from your proxy's IP only (`HATBOT_TRUSTED_PROXIES`, asked by `deploy.sh`).
- **ntfy** runs on your own server, separate from Hatbot. The brain publishes to it with a token whose user may write to Hatbot's topic (`deploy.sh` asks for the URL, topic and token). Set `upstream-base-url: https://ntfy.sh` on that server so iPhone notifications arrive instantly; only a "wake up and fetch" ping passes through ntfy.sh, never the message content.
- **Public paths needed**: the UI, the API, and `/api/v1/hooks/*` for webhooks.

### 9.5 Prerequisites (you)
- Max 20x with API credits linked to a Console org, plus an API key.
- Bot accounts: `hatbot` on Forgejo (and GitHub if wanted), added as collaborators to chosen repos, with a token in `/etc/hatbot/forgejo.env`.
- A `hatbot` user on each host Hatbot may reach, with the brain's public key (shown in Settings → Plugins → SSH).
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
  - Noto Sans (`--font-text`) for reading text: chat messages and the composer.
  - Mono is `ui-monospace, "SF Mono", Menlo`.
- **Chat messages**: bubbles, grey for Hatbot and orange for you; no avatar or sender name; the timestamp sits under each message (left for Hatbot, right for you). Hovering a message (tapping, on a phone) shows **Copy**, and **Open** when it leads to a task or schedule. The iOS app follows Messages instead: solid orange bubbles with white text for you, runs from one sender grouped with a tail on the last, and a centered time ("Today 14:05") after an hour's pause rather than one under each message.
- **Icons**: **Lucide**. SF Symbols aren't licensed for the web. The brand mark is a minimal line-drawn hat.
- **Components**: built on unstyled **Radix** primitives (dialog, popover, dropdown, tabs, switch, tooltip) styled with CSS variables. No Tailwind.

### 10.3 Layout
- **Desktop (≥ 900px)**:
  - **Sidebar** (240px): Chat, Tasks (with a count of what needs you), Live, Schedules & Triggers, Memory, Spend, Settings.
  - **Centre**: a toolbar with the title, then the content.
  - **Side panel** (420px, toggled from the toolbar): **Live**. Task details are their own page (`/tasks/:id`).
- **Phone (< 900px)**:
  - A single column with an iOS-style **bottom tab bar** (Chat, Tasks, Live, Memory, Settings). Spend opens from Settings.
  - Live is a full page; a Keyboard button opens the phone's keyboard during takeover.

### 10.4 Task, approval and schedule messages
Plain messages, not cards; the details live on the task's or schedule's page.
- **Task started from chat**: no message of its own. The reply that started it shows working dots and the latest step, then the task's result in the same bubble.
- **While a reply is written**: under the dots, what Hatbot is doing ("Thinking…", "Reading memory: homelab.md", "Checking a host: nas, logs") and what the reply has used so far ("4.2k tokens · $0.021").
- **Background task** (schedules, triggers): one message when it ends, the title in bold and its summary.
- **Approval**: what Hatbot wants to do, why, which untrusted page it read, a screenshot, **Approve** (blue) and **Deny**. Once answered it shrinks to one line, and once its task ends that line moves into the task's own message (the reply that started it, or its card), above the result.
- **Schedule created**: "Scheduled **name**: every day at 08:00."

Markdown and code blocks render fully. Replies lead with the answer and use lists, **bold** key values, tables and code blocks where they help; text a reply adds after a tool call comes after a rule (`---`).

**Folded conversations**: every episode but the latest folds into one line, its recap (or its first message, for episodes from before recaps), with the time. A tap opens it in place. Cards from background tasks fold with the conversation before them; an approval still waiting for you stays in view.

### 10.5 Live view
- **Watch-only by default.**
- **Take over**: a blue 2px border and a banner, *"You're in control — Hatbot is paused"*, with **Hand back**.
- **When Hatbot asks**: the panel shows its reason ("Captcha on example.com") and you get an ntfy push.
- **Teach mode**: **Teach a skill** next to Take over. While recording, a plain banner (no dot): *"Recording. Show Hatbot how."*, with **Discard** and **Stop & create skill**. Stopping opens the draft at `/memory/teach/:id`: the name (`skills/<name>.md`) and the markdown to edit, **Save skill** or **Discard**. Drafts not yet saved are listed in Memory.

---

## 11. Milestones

Each milestone ends with a working, demo-able system.

### M0 — Setup
- [x] `git init`, monorepo skeleton (Bun workspaces, Biome, tsconfig, `bun test`), private repo `kubus/hatbot` on Forgejo
- [x] CI on the GitHub mirror (Forgejo has no runner): lint, typecheck and tests; the iOS build
- [x] `infra/host-setup.sh` written
- [x] … reviewed with you, then run on the host
- [x] `infra/brain-provision.sh` (Bun, git, memory repo, firewall) and `infra/desktop-provision.sh` (Xvnc, XFCE, Chromium; desktop-agent itself comes in M2)
- [x] `infra/verify.sh`: brain reaches the desktop; desktop can't reach the LAN or the host; token permissions are correct; snapshots and backups are set up
- [x] `verify.sh` passes on the host
- **Done when**: both guests are up, isolated, and backed up by PBS.

### M1 — Brain core + UI shell
- [x] Hono API, SQLite schema + migrations, password + TOTP auth, API tokens
- [x] Custom agent loop (Opus 5.5 at low effort), streaming, caching, spend ledger + limits
- [x] Episodic thread (§5.3), `search_history`, thread summaries (Haiku)
- [x] Memory repo + tools + UI (tree, editor, history, diff, revert)
- [x] Web PWA built from the prototype: shell, chat, Memory, Spend, Settings
- [x] Pause all
- [x] `infra/deploy.sh`: releases, health check, rollback
- [x] Update from git with a button in Settings (`infra/hatbot-update.sh`)
- [x] Deployed and tried from a phone and a laptop
- **Done when**: you can chat with Hatbot from a phone and laptop, it remembers things in markdown, and spending is enforced.

### M2 — Desktop + safety
- [x] desktop-agent daemon; `run_desktop_task` subloop on Opus with `computer_toolset_20260801`
- [x] Tasks: chat cards, Tasks view, task timelines + archive writer (from M1; tasks first exist here)
- [x] Screen-lane queue, release on wait, re-check screen on resume
- [x] Live view (MJPEG, relayed by the brain); Take over / Hand back; `request_takeover`
- [x] Trust tracking, approval gates, `confirm_intent`, Haiku injection screening
- [x] ntfy notifier (publishing to your ntfy server) + signed action buttons
- [x] Nightly desktop snapshots + "Roll back desktop" in Settings (Proxmox API, pinned TLS fingerprint)
- [ ] Tried live: "book a table at X" with an approval from the lock screen (browsing and takeover work; the lock-screen approval is still unchecked)
- **Done when**: "book a table at X" works end to end, with an approval from your lock screen.

### M3 — Triggers
- [x] Scheduler (cron + one-shot), agent-created schedules from chat, Schedules & Triggers UI
- [x] Generic HMAC webhooks (per-trigger secret, trusted/untrusted flag)
- [x] Uptime Kuma adapter
- [ ] Tried live: a morning schedule, a Forgejo webhook, a Kuma test alert
- **Done when**: "every morning at 8, check X" runs unattended and reports back.

### M4 — Homelab plugins + MCP
- [x] Plugin core (§4.5): registry, Settings → Plugins, read tools in chat, write tools in tasks, policy + approvals, `run_task`
- [x] Proxmox plugin (`proxmox_*`) using the scoped token: guests, a guest, the host, recent tasks; start/reboot free, shutdown/stop and "careful" guests ask, the brain refused; snapshots of own guests
- [x] SSH plugin: hosts in Settings, host keys pinned on first connect (forget in Settings), `ssh_check`/`ssh_read_file` read freely, `ssh_exec`/`ssh_write_file` with a destructive-pattern gate, writes outside home ask, "careful" hosts ask for everything
- [x] Forgejo plugin (`forgejo_*`) with the bot account: repos, issues and PRs (untrusted), files, CI; comment, open issues and PRs, commit files through the API; merging, committing to the default branch and changing CI workflows ask (GitHub later)
- [x] Code tasks: `run_task` with effort medium, high on request or after a failed attempt (§5.4); more steps and output room; new branch + pull request
- [x] Uptime Kuma alert handling: investigate → one safe restart → verify → report; later Kuma events reach the running task
- [x] MCP plugin: HTTP and stdio servers, secrets as `${NAME}` from `mcp.env`, per-tool ask / allow / allow in chat / off, untrusted output unless the server is trusted, stdio servers get a clean environment
- **Done when**: a Kuma "down" alert at 3am is fixed or diagnosed before you wake up.

### M5 — Teach-by-showing
- [x] Record mode in takeover (live-view input events + screenshots + CDP URL/title); typing into password, code and card fields, frames, or fields that can't be checked isn't recorded
- [x] Opus turns a recording into a draft `skills/<name>.md` with placeholders → you review and save
- [x] Skills index in the memory INDEX (and `skills_index`); background tasks see the list, `run_desktop_task(skill)` hands the desktop model its steps
- [ ] Tried live: record a chore, save the skill, a schedule repeats it
- **Done when**: you demo a chore once and Hatbot repeats it on a schedule.

### iOS app (alongside M3–M5)
- [x] SwiftUI app in `apps/ios`: sign-in with TOTP, Keychain token, event stream
- [x] Chat with streaming replies, tasks under the reply, approvals, schedules; Markdown
- [x] Tasks list and task page (approvals, timeline, screenshots, cancel)
- [x] Live view with takeover (touch, scroll, keyboard)
- [x] Settings: spend, chat effort, Pause all / Resume, sign out
- [ ] First build by the iOS workflow, installed from the SideStore source and tried against the brain
- [x] Memory (tree, file, history) and Schedules & Triggers (triggers are made on the web)
- [x] ntfy notifications open the app (`hatbot://` click URLs), chosen in Settings → Notifications
- [x] Siri and Shortcuts actions, and a share extension
- [x] Search, watchers, Check everything, the heartbeat and weekly report, memory proposals, Run again
- **Done when**: you can chat, approve and take over from the app on your phone.

### After v1
Email via Proton Bridge · open-source release (choose a licence, docs, one-command installer).

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Prompt injection while running autonomously with persistent sessions | Trust tracking + approvals, Haiku screening, Anthropic's checks, desktop isolation, takeover for logins only |
| Unprivileged LXC shares the host kernel with a browser on untrusted sites | Chromium sandbox on (`nesting=1`), no LAN, no secrets on the desktop, nightly snapshots; can move to a KVM VM later if RAM allows |
| RAM pressure on a 16 GiB host | Small guests, swap on the desktop, preflight check, one screen lane |
| Cost overruns from screenshot-heavy tasks | Spending limits, 1280×800, caching, server-side context clearing, Haiku 5.5 test for desktop work |
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

---

## 14. Multiple bots

More than one Hatbot, like Grok Bot: several named bots, each with its own role, chat, memory and logins, which hand work to each other. Agreed 2026-10-14. B1–B5 built 2026-10-14; not yet deployed or tried live.

### 14.1 Decisions
| Area | Decision |
|---|---|
| Bot | A row in `bots`: id, name, icon and colour (from fixed lists in `packages/shared`; iOS maps them to SF Symbols and system colours), instructions (its role, markdown), chat model and effort, plugin allowlist (a subset of the plugins switched on). Hatbot is bot #1 (`hatbot`), the default, and can't be deleted |
| Chats | One direct chat per bot. Group chats come last (§14.4) |
| Memory | One git repo. Each bot has `bots/<slug>/INDEX.md` for its own notes and commits under its own name; the root `INDEX.md` and `skills/` are shared, read and written by every bot. `/remember` and teach-by-showing go to the shared part |
| Hand-offs | `ask_bot(bot, request)` runs as a task owned by the other bot, under its plugins; the result returns to the bot that asked. Hand-offs nest at most 3 deep |
| Trust | Bots are a security boundary, unlike Grok Bot's: a bot only gets its allowlisted plugins, and a hand-off from a tainted chat or task starts tainted (§6.1) |
| Desktop | One shared desktop and screen lane. Each bot gets its own Chromium profile (`--user-data-dir`), so logins aren't shared. The live view says which bot is driving |
| Spending | Global limits only ($10/day · $200/month · $3/task); the ledger records the bot for Spend's breakdown |
| Notifications | One ntfy topic; titles name the bot when it isn't Hatbot ("Coder · Approve: …") |

### 14.2 Data
- **`bots`** (migration 20), seeded with Hatbot.
- **`conversations`**: `kind` (`direct` or `group`), members; one direct conversation per bot. The rolling summary moves from `settings.thread_summary` onto the conversation.
- **`bot_id`** on episode turns (each bot in a group keeps its own), messages (who spoke), tasks, approvals, schedules, triggers and spend; **`conversation_id`** on episodes and messages. Existing rows go to Hatbot. Attachments keep `sender` as `owner` or `hatbot`; the message a file is on says which bot sent it.
- Episodes, the 30-minute idle rule, `/new`, incognito, folding and `search_history` work per conversation. `takeUnreported()` reports a task's news to its bot's chat.
- A schedule or trigger runs as the bot that owns it.

### 14.3 Prompts, API and UI
- **Prompt**: `SYSTEM_PROMPT` takes the bot's name and instructions, plus the other bots with one line each, for `ask_bot`. Task and desktop prompts name the bot too.
- **API**: `/bots` (CRUD) and `/conversations/:id/messages`. `/thread/*` stays as Hatbot's direct chat so installed iOS builds keep working. Message, task, approval and desktop events carry `botId` (and `conversationId`); `DesktopState.control` becomes a bot id or `owner`.
- **Web**: the sidebar's Chat becomes a list of bots, each with its name and unread count, and **New bot**. A bot's page: name, instructions, model, plugins, its memory folder.
- **iOS**: the same list in the drawer, and the bot's page. Models in `Models.swift` change with `packages/shared`.

### 14.4 Milestones
- **B1, the model**: migration 20, Hatbot as bot #1, `conversation_id`/`bot_id` everywhere, the API and events. Done when everything behaves as before and the tests pass.
- **B2, direct chats**: create and edit bots; per-bot prompt, memory folder, plugins and model; bot-owned tasks, schedules and triggers; web sidebar. Done when you chat with a "Coder" and a "Homelab" bot apart.
- **B3, hand-offs**: `ask_bot`, taint carried over, the depth cap. Done when Hatbot hands a repo fix to Coder and reports back.
- **B4, desktop and iOS**: a browser profile per bot; the bot list and pages in the iOS app.
- **B5, group chats** (low priority): 2–6 bots and you. `@name` picks who answers; with no mention the last bot to speak does; a bot can bring another in with `@name`; at most 4 bot replies per message from you. Sender names show above a run of messages, only in groups. `@` autocompletes in the composer.

### 14.5 As built
- **Chats:** `Chats` (`apps/brain/src/agent/chats.ts`) runs one `Thread` per conversation. `/conversations` lists them with unread counts; `POST`, `PATCH` and `DELETE /conversations/:id` make, change and delete groups. `/thread/*` is still Hatbot's chat.
- **Prompt cache:** Hatbot on its own keeps its old prompt and tools (no roster, no `ask_bot`), so an existing install's cache carries on.
- **Hand-offs:** `ask_bot` from the chat starts the other bot's task (`requested_by` is the asker) and the asker reports back when it ends. From a task it waits for the result, giving up its background slot meanwhile. Taint goes both ways.
- **Desktop:** Chromium is `hatbot-chromium.service`, which reads its profile from desktop-agent's state dir; `POST /browser/profile` switches it, restarting Chromium.
- **Groups:** the episode is bound to every member's prompt. Each bot has its own turns in it; a bot new to the episode opens with the context, and every bot gets what others said since its last turn in `<group_messages>`. No incognito in groups.

---

## 15. Looking after things (built 2026-10-15)
What runs without you asking, and the tools to see that it works.

- **Check everything** (Settings, `apps/brain/src/checks.ts`): a real try of each part: the database and its migrations, the public address, a Haiku call, memory, the archive, spending, the last update, ntfy, desktop snapshots, the desktop (version, browser profiles, time zone, shell, browser), schedules that keep failing, old approvals, watchers that can't read, and each plugin's own test. A test approval tries the lock-screen buttons. `infra/smoke.sh` runs it from a shell with an API token.
- **Watchers** (`apps/brain/src/watch/`, migration 24): a page (fetched by the desktop, which only reaches the internet) or a plugin's read tool, picked out by CSS selector, JSON path or pattern, looked at every 5 minutes or more. No model call: only a change *into* the condition (changed, contains, missing, below, above) counts, and then it tells you or starts a background task with the watcher's prompt. Page text is untrusted, so those tasks start tainted. Made in the chat (`watch_*`) or on the web.
- **Search**: one box over messages (FTS5), tasks, memory, schedules, triggers and watchers. A found message opens in its chat.
- **Run again**: an ended root background task starts anew with its goal as you edit it, keeping its origin, bot, payload and taint.
- **Heartbeat** (`apps/brain/src/heartbeat.ts`, on by default): every 30 minutes a look, without the model, at failed tasks, expired approvals, watchers and plugins that can't be read, an offline desktop, spend over 80%, and plugin signals (Uptime Kuma monitors down, PBS jobs failed or datastores over 90%). Only something new goes to Haiku, which lets it be, tells you, or starts a task with your instructions. Its tasks start untrusted.
- **Weekly report** (`apps/brain/src/report.ts`, on by default, Monday 09:00): spend by bot, tasks done and failed, approvals, watchers, memory commits. In Hatbot's chat and as a notification, made without the model.
- **Proposals** (`apps/brain/src/memory/proposals.ts`, migration 25): Opus proposes a tidy-up of memory (weekly when switched on, or Tidy up in Memory) and fixes to skills whose tasks failed or needed you since they last changed. Each is a diff per file; Apply commits it as you, Dismiss drops it, and a proposal goes stale if memory changed under it.


---

## 16. Negotiation (planned 2026-10-16, not started)
Hatbot haggles on OLX, Allegro Lokalnie and Vinted for you. It buys first; selling your flips comes later. Its market data comes from Scout (`../scout`) over the MCP plugin. Agreed 2026-10-16.

### 16.1 Decisions
| Area | Decision |
|---|---|
| Who | A bot, **Haggler** (§14). It has its own browser profile, logged in to a separate marketplace account (you make it later), and its own memory folder for the playbook and notes on sellers. Scout is its only plugin |
| Mandate | You approve one **mandate** per negotiation. It covers the listing, the opening offer, the target, the ceiling (a floor when selling), delivery terms and when it expires. Inside it, Hatbot sends and agrees on its own; outside it, it asks. Paying always asks (§6.1) |
| Untrusted content | Seller messages are untrusted, as before. The mandate stands in for the approval §6.1 would ask for, but only for `negotiate_send` within the mandate, checked in code rather than by Haiku. Every other outward action in the task still follows §6.1 |
| Agreeing | Within the mandate, Hatbot agrees on its own (your choice, 2026-10-16) |
| One deal per want | Talking to several sellers about one thing at once is fine. The first agreement locks the want, and the other sellers get a decline |
| Tactics | It doesn't have to be honest about our side (your choice, 2026-10-16). It may state a lower "max" than the ceiling, mention other offers, claim urgency or walk away. **Never**: misstating an item's condition, defects or authenticity when selling; fake proof of payment, shipping or receipt; claiming to have paid or sent; posing as the marketplace or a courier; reporting false defects after receiving an item to get money back. Those are fraud: buyer protection reverses them, and they get the account banned |
| Consistency | What Hatbot has told each seller (its stated max, other offers, timing) is kept on the negotiation, so it doesn't contradict itself |
| Pace | At most 10 new conversations per account per day, sends at a person's pace, nothing between 22:00 and 08:00 |
| Scams | Haiku also screens seller messages for marketplace scams: payment or courier links, BLIK codes or card details, moving to WhatsApp or Telegram, pressure to pay off the platform. A suspected scam pauses the negotiation and tells you. The desktop never opens a link from a seller |
| Transport | Hatbot reads the inbox through Scout (cheap, frequent, read-only). At first, sending is a desktop task in Haggler's browser; Scout could take over sending later |

### 16.2 Data (migration 27)
- **`wants`**: what you're after ("RTX 3070, working, ≤ 1,400 zł"), quantity, status, bot.
- **`negotiations`**:
  - the want, and the listing key (`<Marketplace>:<listingId>`, as Scout gives it);
  - role (`buy` or `sell`) and the mandate (JSON);
  - the conversation's URL and id, and the claims made so far;
  - the next follow-up time and the bot;
  - status: `awaiting_mandate → open → agreed | lost | abandoned | expired`, then `paid` and `received`.
- **`negotiation_messages`**: direction, text, offer amount, time, and the marketplace's message id, which dedupes inbox reads.

### 16.3 Tools
These live in the core, in `apps/brain/src/negotiate/`, like watchers. They are not a plugin, because they start tasks and drive the desktop. They call Scout's tools by name through the MCP plugin, as watchers call plugin tools.
- **`negotiate_appraise(listing)`** (read): gathers Scout's price reference and comparables, plus the listing's price history, days listed and negotiable flag. It returns an opening offer, a target and a walk-away price, with the listings each rests on.
- **`negotiate_start(listing, mandate, want?)`**: makes the record and asks you to approve the mandate. The card shows the listing, the appraisal and the mandate; a steering note (§6.2) can change the numbers.
- **`negotiate_list`** / **`negotiate_get`** (read).
- **`negotiate_send(negotiation, text, offer?, agree?, stated?)`**: the only way out. `stated` records what this message claims about our side. The policy, in code:
  - `offer` is within the mandate (at or under the ceiling when buying, at or over the floor when selling), and `agree` only at a price within it;
  - only the negotiation's own conversation;
  - no phone number, address, e-mail or other app unless the mandate allows it;
  - an amount in `text` outside the mandate asks, so the cap can't be dodged by writing the number out;
  - the pace limits;
  - anything else asks, as in §6.2.

  It then runs a desktop task that may send exactly this text in this conversation. The brain lets the Send click through only while the composer holds that text and the tab shows that conversation.
- **`negotiate_close(negotiation, outcome, price?)`**:
  - ends the negotiation;
  - writes notes on the seller, and on what worked, to the bot's memory;
  - sends the outcome to Scout;
  - on `agreed`, declines the want's other open negotiations.

  Paying comes after this: a desktop task goes as far as the checkout and asks (`payment`, always).
- **Waking**:
  - A poller without the model reads `scout_inbox` every 10 minutes while any negotiation is open.
  - A new seller message is stored and screened, then starts a short background task for that negotiation with its record (mandate, claims, messages). Nothing waits in a long task for days; `wait` stops at 240 minutes anyway.
  - When the follow-up time passes without a reply, a task starts too, to nudge the seller or give up.

### 16.4 Scout's part
This goes in Scout's own repo, as a handoff there. Read tools, all `readOnlyHint`:
- **`scout_price_reference`**: P0-4 in Scout's `HAT_DEALS_HANDOFF.md`, never built. That handoff was written for the old `hat` and is otherwise stale.
- **`scout_comparables(listingKey)`**: live alternatives for the same item. They are the fallback, and honest leverage.
- **`scout_listing_detail`** gains days listed, price drops, relists, the seller's other listings and the negotiable flag. It also gains `live: true` (P1-3), to check the listing before an offer and before paying.
- **`scout_inbox(marketplace, since?)`** and **`scout_conversation(id)`**, through Scout's stored marketplace sessions.

And one write tool:
- **`scout_record_outcome`**: the final price. It is kept apart from Scout's asking-price statistics, as flips are, and comes back as a figure of its own ("you pay about 84% of asking for GPUs on OLX").

A later option is `scout_send_message`, if sending from the desktop turns out to be too slow.

### 16.5 UI
A negotiation shows the way a task does:
- a card under the reply that started it, with the listing, the mandate, the last message and the state;
- its messages on its own page;
- mandate approvals and scam stops among what needs you.

The iOS app follows later.

### 16.6 Milestones
- **N1, by hand**: the Haggler bot; a playbook skill (show it one negotiation per site, M5); wants, negotiations and their tools; every send asks. Done when one OLX negotiation runs end to end with you approving each send.
- **N2, mandates**: the mandate approval, `negotiate_send`'s policy, claims and pace limits. Done when a negotiation runs inside its mandate without asking.
- **N3, waking**: Scout's inbox tools, the poller, follow-ups and scam screening. Done when a seller's reply gets an answer within 15 minutes, with nobody in the chat.
- **N4, several sellers**: wants with several negotiations, the lock and the declines.
- **N5, selling**: answering buyers on your listings. The floor comes from Scout's flips: the buy price, fees and a margin.

Scout: N1 needs `scout_price_reference` and `scout_comparables` (until then, the appraisal uses `scout_watch_analytics`); N3 needs the inbox tools.
