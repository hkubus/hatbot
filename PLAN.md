# Hatbot — Plan

A self-hosted, always-on personal agent built on Claude, running on your Proxmox homelab. It's an alternative to OpenAI Dots and xAI Grok Bot, and it fixes what they get wrong:

- **Memory you can read.** Memory is plain markdown, not hidden.
- **Real isolation.** Each agent's desktop is in its own fenced-off container, unlike Grok Bot's shared VM.
- **No vendor cloud.** It runs on your hardware.
- **Predictable cost.** Spending limits are enforced.

> Status: design agreed 2026-10-09. M0–M5, the iOS app, more than one bot (§14), looking after things (§15), negotiation's N1 and N2 (§16), research (§17) and own code (§18) are built, and so are the fixes from the 2026-10-17 code review. M4 onwards is not yet deployed or tried live, and the iOS app awaits its first install. Next is the owner's deploy and live run (`HANDOFF.md`).

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
| Audience | You first. The repository is public, under the MIT licence. **No copyleft dependencies**: `bun run licenses` fails CI on one, with only build tools that ship nothing allowed by name (Vite's `lightningcss`, MPL-2.0) |
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
| Spending limits | $10/day · $200/month · $3/task, $5 for a research task (raisable per task) |
| Autonomy | Mostly autonomous. Payments, purchases, credential changes and unlocking the house always need approval, in the app |
| Untrusted-content rule | Once a task has read untrusted input, outward actions need approval (§6.1) |
| Concurrency | Screen tasks run one at a time; non-screen tasks run in parallel |
| Approvals | The task pauses and frees the screen; auto-cancels after 24h; ntfy Approve/Deny buttons use single-use tokens, and money, accounts and access are approved only in the app (§6.2) |
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
| Stack | Bun + Hono + SQLite · React + Vite PWA · MJPEG live view (ffmpeg → WS → canvas) · our own components + CSS variables · Biome · `bun test` |
| Repo | Bun-workspaces monorepo `kubus/hatbot`, public, on Forgejo `git.gaycats.ovh`; Forgejo push-mirrors it to GitHub `hkubus/hatbot` (deploy key), where CI runs |
| Exposure | `hatbot.gaycats.ovh`. You handle the tunnel, TLS and reverse proxy; Hatbot serves plain HTTP on the LAN |
| Auth | Single user, password + TOTP, both changeable in Settings; API tokens for the iOS app |
| Notifications | Your self-hosted **ntfy**, on its own server, on a random topic only you can read; the brain publishes to it. No APNs or Web Push, because the iOS app is a free SideStore sideload |
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
- **Trigger ingress**: `POST /hooks/:id`, checked by HMAC signature (`X-Hatbot-Signature: t=…,v1=…` over `t.body`, or the `X-Hub-Signature-256` / `X-Forgejo-Signature` that GitHub and Forgejo send), with replays dropped: a delivery that starts a task is remembered by its forge delivery id and by its signature for 30 days, and either seen again is a replay. A delivery skipped while paused or switched off can be sent again. Uptime Kuma can't sign, so `/hooks/kuma/:id` takes the trigger's secret in the URL (`?token=`, what the setup panel shows) or as a bearer token, and accepts every way Kuma sends: JSON, form data, or GET. Kuma's Test message sends you a notification. Each trigger starts at most 24 tasks in 24 hours; then you're told once ("<name> is at its limit") and later events start nothing. Every hook logs what it did with the request.
- **Tool host**: the built-in tools (§5.5) and the plugins' tools (§4.5).
- **Policy engine**: trust tracking, approval gates, spend enforcement (§6).
- **Live-view relay**: JPEG frames from desktop-agent out to the browser, and your pointer and key events in while you have control. M5 records these input events for teach-by-showing. (noVNC was the first plan; it's MPL-2.0, so the view is our own MJPEG stream.)
- **Notifier**: publishes to ntfy, including action buttons (§6.2).
- **Sign-in**: each attempt counts against the limits before it's checked. A browser or app that signed in before carries a signed `hatbot_device` cookie and has a limit of its own (10 tries in 15 minutes), so strangers using up the overall limit (50 in 15 minutes) can't lock it out. When the overall limit trips, ntfy says "Sign-in is on hold", at most once an hour. Sign-in bodies are read up to 16 KB. Settings → Password and sign-ins changes the password (the current one and a code) or the authenticator (the password and a code, then a code from the new one within 10 minutes); either change signs out every other browser and every API token. It also lists the signed-in browsers, to sign out one or all the others. `infra/reset-login.sh` on the host forgets both, signs out everything and prints a new setup code.
- **Sessions**: the cookie is sent again whenever its sliding expiry moves on, so a session in use doesn't end on day 30. Signing out, revoking a token or expiry closes that client's live sockets, and a request whose body arrives after its session ended does nothing. Logout sends `Clear-Site-Data: "cache"`.
- **Storage**: SQLite (WAL) on SSD; `memory/` git repo on SSD; `/archive` (screenshots, raw transcripts) on the HDD mount.

### 4.2 `apps/desktop-agent` — tiny Bun daemon inside the desktop LXC
- `POST /screenshot`: captures the X display (1280×800) and returns lossless WebP.
- `POST /action`: runs the computer-use actions (click, drag, type, key, scroll, hold_key, mouse down/up, cursor_position, wait) through `xdotool`. Keys are only named keys (Return, Tab, Page_Down, F1–F24, KP_Enter, the modifiers) and single characters, modifiers first; keycodes, keysyms in hex or Unicode and chords with a modifier after the key are refused. The brain checks the same list (`packages/shared/src/keys.ts`, desktop-agent's `keys.ts`; a test keeps them equal), so the two are deployed together.
- `POST /zoom`: crops a region at full resolution.
- `POST /browser`: runs a browser toolset member (`browser_toolset_20260801`: navigate, read_page, find, get_page_text, clicks and typing by element reference or viewport point, form_input, screenshot, zoom, tabs) on the running Chromium over CDP. Element references live in an isolated world the page can't touch. Dialogs are dismissed and reported; `javascript_exec`, `file_upload`, console and network reads stay off.
- `GET /browser/state`: the open tabs and what changed since the last report (tabs opened, downloads, dismissed dialogs), for the toolset's `browser_state` block. `POST /browser/inspect`: the element a browser click or Enter would hit, for §6.1.
- `GET /context`: the current Chromium URL and title, read through CDP on localhost. Used for logging and the trust tracking in §6.1.
- `POST /inspect`: the element under a point (or the focused one), for the consequential-click check in §6.1. It reads into frames from other addresses over CDP, open shadow roots and same-origin frames, and uses the browser window that holds the point. It advertises the feature `gates`; Check everything warns while it's missing.
- `POST /lock` / `/unlock`: input lock used during takeover.
- `WS /live`: an MJPEG stream (ffmpeg x11grab, 15 fps; a slow viewer skips frames) while someone watches, and your input while you have control.
- Auth: a shared bearer secret. The desktop's firewall only accepts the brain, and the host's bridge filter drops the desktop's replies to anyone else.
- Services: `Xvnc :1` (TigerVNC, 1280×800), XFCE (lightweight), Chromium with a persistent profile, `desktop-agent`. All managed by systemd.

### 4.3 `apps/web` — React + Vite PWA
Desktop-first, three panes. Design spec in §10.

### 4.4 `packages/shared`
Shared API types and zod schemas for the brain and web. The iOS app mirrors the types it uses in `apps/ios/Hatbot/Core/Models.swift`; change both together.

### 4.5 Plugins (`apps/brain/src/plugins/`)
Integrations are plugins: Proxmox, Proxmox Backup Server, SSH, Home Assistant, Uptime Kuma, Forgejo, GitHub, Code, Own code (§18) and MCP. The core keeps memory, chat history, schedules, tasks and the desktop.
- **Shape**: each plugin is a folder exporting one `definePlugin({...})`: an id, a name, its settings (a zod schema whose fields all have defaults), the environment variables it reads from `/etc/hatbot/*.env` (secrets never reach the model or the web app), and `start(ctx)`, which returns its status, tools, an optional paragraph for the system prompt and an optional Test.
- **Built in, not installed at runtime**: plugins ship with Hatbot. Code loaded at runtime would run in the brain next to the API key, the Proxmox token and the SSH key. Third-party extensions come in through the MCP plugin, whose servers run as separate processes behind the same approval rules.
- **On and off**: every plugin starts off. Settings → Plugins switches one on and edits its settings; it restarts with them. One that's on but missing its secrets or settings shows *Needs setup* and offers no tools.
- **Tools**: named `<plugin id>_…`. A **read** tool looks without changing anything; the chat calls it directly. A **write** tool changes something. The chat makes at most two changes in a reply itself (a restart, a command, a comment), through the same checks and approvals as a task; more than that goes to a task with `run_task` (§5.5). A tool can mark its output **untrusted** (issue text, MCP output): it's wrapped as labelled JSON, and a task or chat episode that reads it becomes tainted.
- **Policy**: a write tool may have a `policy(input, task)` that allows, asks you first, or refuses. The core takes the stricter of that and the untrusted-content rule (§6.1), raises the approval, and logs the call on the task's timeline. Plugins never build approvals themselves. Tool text says "needs approval" for what Haiku's review may let through, and "waits for the owner" for what always asks. Hosts and guests marked careful wait for the owner first, whatever else asks; a careful guest covers every change in it, through its Proxmox host too.
- **Calls follow the plugin as it is now**: every call, in the chat or a running task, and one approved after Haiku's review, runs on the plugin's current settings and policy. A plugin switched off or taken from the bot, or a tool whose definition changed, refuses the call; a call approved after its plugin restarted doesn't run. A task is refused a tool it wasn't sent.
- **Prompt cache**: the chat's tools and system prompt include the plugins that are on, so switching one on or off starts a new episode (§5.3). A task fixes its tools when it starts.
- **MCP tools**: each tool's mode is Off, Ask first, Always ask, Allow, or Chat, no asking (stored as `chat`; a read the chat calls freely). A tool also has a kind (Pays or moves money, Buys or orders, Changes accounts or keys, Other changes), set in Settings or guessed from its name and description. A tool that pays, buys or changes accounts always asks, with that kind (so in the app, §6.2), and can't be Chat. A Chat or Allow mode is pinned to the tool's definition (name, description, input schema): when the server changes it, the tool asks again until you pick its mode again. An untrusted server's tool descriptions taint every chat and task until you press Accept in Settings → Plugins → MCP, which shows each description and input schema; a changed definition taints again. Definitions the API wouldn't take are left out with the reason under the tool: an input schema that isn't valid JSON Schema 2020-12 (checked with ajv) or refers to what it doesn't define, a top-level `anyOf`/`oneOf`/`allOf`/`not`/`if`, a schema over 16,000 characters, a property name the API refuses, or a tool that only runs as an MCP task. At most 50 tools per server are offered. A failed call is sent again only when it can't have reached the server, or in Chat mode.
- **MCP secrets**: `${NAME}` in a server's headers or environment reads only names set in `/etc/hatbot/mcp.env` (root:hatbot, mode 640; `brain-provision.sh` creates it).
- **MCP stdio servers** run inside the brain as the `hatbot` user with a clean environment (no inherited secrets), but that user can read `/etc/hatbot/*.env`. The form says so and suggests a pinned version. Run only servers you trust that way; prefer HTTP servers elsewhere. Running each as its own user would need a root-side launcher (a systemd unit per server, say), since the brain's unit has `NoNewPrivileges=yes`; not built.
- **Web**: Settings lists the plugins; each has a page with its switch, which secrets are set, its settings form (`apps/web/src/plugins/<id>.tsx`), a Test button and its tools.

### 4.6 `infra/`
- `host-setup.sh`: the one-time Proxmox setup script (§9).
- the provisioning scripts for both guests, `verify.sh`, and `deploy.sh`, which installs the app and its systemd unit.

### 4.7 `apps/ios` — SwiftUI
- **Native**: SwiftUI, built with the newest Xcode and iOS SDK (27), running on iOS 18+. SF Symbols and the system font, the same amber, blue, red and green as the web. Amber text and the app's tint are darker in light mode so they read (`Color.brandText`, #9C5200, #7A4000 with Increase Contrast); `Color.brand` (#E8820C) stays for fills, with dark text on them. No dependencies.
- **https only**: the app, widget, Siri intents and share extension refuse an `http` brain address, on the LAN too, so the token never crosses a network in clear. Use the public https address, or give a LAN-only brain a certificate the iPhone trusts (Caddy's internal CA installed as a profile with full trust, or `tailscale cert`). An address an older build saved as `http` shows the sign-in screen.
- **Privacy**: a blank window covers the app in the app switcher. Spotlight uses a named index with complete protection and holds names only. Secrets stay off the synced pasteboard. Signing out deletes the chat cache, opened files and cached downloads.
- **Liquid Glass**: system bars, tab bar and lists get it from the SDK. The chat composer, the paused banner, the toast and the buttons use glass on iOS 26+ (a material before); messages and screenshots stay solid. The sidebar is a solid drawer, not glass.
- **Sidebar**: chat fills the screen; Chat, Search, Tasks, Live, Memory and Settings sit in a drawer under the left edge. A swipe in from the edge (on a section's first page; deeper, it's the back swipe) or the menu button at the top left slides the section aside to show it, following the finger; a swipe back or a tap on the section closes it. The button and the Tasks row count what needs you.
- **Scroll to bottom**: scrolled well up in chat, a round button above the composer jumps back to the latest.
- **Auth**: password + TOTP once, then a bearer token named after the device, kept in the Keychain. Signing out deletes the token on the brain.
- **Live events**: the same `/stream` WebSocket while the app is in front; it reconnects and reloads after a gap, and keeps reply events that arrive while a page loads, as the web does. iOS stops it in the background, so notifications stay with the ntfy app.
- **Sections** stay alive once opened, so they keep their edits; a hidden one doesn't mark messages seen or stream the live view. The sidebar docks only when both size classes are regular.
- **Live view**: the `/desktop/live` frames. During takeover a tap clicks, a drag drags, a long press right-clicks, two fingers scroll, and a Keyboard button types.
- **Build**: `project.yml` (XcodeGen) → `build-ipa.sh` makes an unsigned IPA; SideStore signs it with your Apple ID. The GitHub mirror's iOS workflow builds it on macOS for every change and, on `main`, publishes it with a SideStore source at `https://hkubus.github.io/hatbot/source.json`, so SideStore installs and updates it. `Hatbot/Core` is also a Swift package, tested with `swift test` (on Linux too).
- **Links**: `hatbot://tasks/<id>` and `hatbot://approvals/<id>`.
- **Siri and Shortcuts**: App Intents in the app: Ask Hatbot (`POST /thread/ask`, which waits up to 25 seconds for the reply), Give Hatbot a Task (`/task`), Send to Hatbot (text and files). They and the Pause Hatbot control ask you to unlock the iPhone first, pausing included.
- **Share sheet**: the `HatbotShare` extension sends links, photos and files up to 25 MB each, streamed from disk, with a note to Hatbot's chat. Text shared from another app goes as a file, "Shared text.txt", so it isn't taken for your words; your note and the links are the message. The app keeps the token in the App Group's Keychain access group (`group.<prefix>.hatbot`, from `project.yml`'s `BUNDLE_PREFIX`, renamed by SideStore with the team ID) and the address in the group's defaults. It's a second App ID in SideStore.

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
  - The thread uses the **1-hour cache**, so the 30-minute episode window stays cheap. It adds a third mark where the last request ended, so a long reply still reads the cache; a miss is logged ("episode N: the cache missed (…)").
  - Tasks use the 5-minute cache.
- **Long tasks**: rely on server-side **context editing** (`clear_tool_uses`) and **compaction**. We never edit history client-side: on the 5.5 models that breaks cached reasoning and is rejected.
- **Retries**: a model stream is tried at most 3 times in all, after `retry-after` when the API gives one; a wait over 60 s fails at once. A failed try's usage is billed.
- **Limits**: hard caps per task on turns, wall-clock time and dollars. A background task stops after 4 hours of its own time (`MAX_RUN_MS`); waiting for approvals or child tasks doesn't count. A task reply with no tool call is asked once to call `finish_task`, and a second one fails the task. A request past the context window ends a reply as cut off and a task as failed. A run that crashes while it sets up is marked failed.
- **Stopping**: cancelling, or Pause all, stops the rest of the turn and the desktop requests in flight.

### 5.3 Episodic chat thread
- **During an active conversation** (last message under 30 minutes ago), keep appending to the same cached context.
- **An update that changes the system prompt, the tools or the chat model** also starts a new episode: Opus 5.5 checks each replayed thinking block against the prompt, tools and messages it was made with, and rejects the request on a mismatch. As a backstop the chat sends `block_binding.prefix_mismatch_behavior: "drop_block"`, so a block that still fails is dropped (and logged) instead of failing the reply.
- **After 30 minutes idle**, the next message starts a new episode containing:
  - the system prompt
  - the memory index
  - a rolling **thread summary** (updated by Haiku once an episode has been idle for 30 minutes, which also writes the episode's one-line recap)
  - the last ~10 messages
  - your new message
- **`search_history(query, range?)`**: a full-text search over the thread in SQLite (FTS5, Porter stemming): any of the words, each also as a prefix, best-ranked (bm25) first, with times and dates in the brain's local time. Hatbot pulls in older messages only when it needs them.
- **Transcripts** the model reads (recent messages, group messages, owner commands, the summariser's input) are `<message from="…" at="…">` tags with their text escaped. The app's own notes (a task ended, a bot was mentioned) are system messages in the conversation, not your words.
- **A reply being written** is served with its text so far (a reload, `/ask`) and saved every 3 s; after a restart, a cut-off reply keeps that text with "This reply was cut off."
- **Tasks started from chat** run in their own contexts; their progress and result show under the reply that started them (§10.4). The thread never carries a 30-step browser transcript.
- **Durable facts** go to memory, not the thread.

### 5.4 Model routing
| Job | Model | Notes |
|---|---|---|
| Chat, planning, non-screen tools | `claude-haiku-5-5` by default, or `claude-opus-5-5` (Settings → Chat); effort `low` (Settings or a bot: low, medium, high, xhigh or max) | On Haiku the chat has `ask_opus`: one Opus 5.5 call (effort `high`, no tools) per reply at most, for code, debugging and multi-step reasoning, its answer streamed into the reply as is. Haiku has no server-side fallback, so a refusal ends the reply with a note. Changing the model or effort starts a new episode or drops the cache, so heavier work runs as a task instead |
| Desktop driving (`run_desktop_task`) | `claude-haiku-5-5`, effort `medium`; when Haiku fails, the same task carries on once on `claude-opus-5-5` (Settings → Desktop: the model, and "Try again on Opus when Haiku fails", on by default) | Native `computer_toolset_20260801` plus `browser_toolset_20260801` for web pages. Haiku is cheap but fails more (72% on OSWorld); Opus reads screenshots best. Haiku's tasks run without `display: "updates"`, which isn't documented for it. See "Desktop escalation" below |
| Schedules and triggers (background tasks) | `claude-haiku-5-5` by default, or `claude-opus-5-5` (Settings → Tasks); the chat's effort | Same kind of work as chat, without a screen (§5.6) |
| Injection screening, thread summaries, alert triage | `claude-haiku-5-5`, effort `low` | $0.10/$0.50 per 1M tokens up to 100k-token prompts, 5x above (whole request). Thinks by default |
| Writing code (`forge_*`, `ssh_exec` work, M4) | the background tasks' model, effort `medium`; `high` when you ask or after a failed attempt | Runs as a task with its own card, spend limit and timeline, like desktop tasks |
| Teach-by-showing skill writing | `claude-opus-5-5` | Infrequent |

Chat requests opt into server-side fallback (`fallbacks: "default"`): if the model refuses, the API retries on a fallback model, and the spend ledger bills each model that ran at its own rates.

Why these (Artificial Analysis Intelligence Index, score and cost per index task, October 2026): Haiku 5.5 medium–max 34–43 at $0.05–0.21; Opus 5.5 medium 51 at $1.34, high 54 at $1.82, xhigh 56 at $3.46, max 58 at $5.98; Sonnet 5.5 low/medium 36/41 at $0.41/0.48, high 47 at $0.88, max 56 at $5.5–7.7. Every Sonnet setting is beaten on score or price by Haiku 5.5 or Opus 5.5. Opus low (42 at $0.55) loses to Haiku max on the index, but chat turns are short and tool-driven: a big model with little thinking answers faster and judges better, and cache reads cost the same as Sonnet's. Fable 5.1 and Opus xhigh/max cost 2–4x for a few points; not used.

**Desktop escalation** (decided 2026-10-16): a Haiku desktop task that runs out of steps (80) or time (30 minutes), is refused, is cut off, or finishes as failed on its own carries on once on Opus, in the same task: its card, its timeline, its parent's wait and its spend limit stay. Haiku is first asked, on its own cached conversation, what it tried; Opus starts afresh with the task, that account and why Haiku stopped, on the desktop as Haiku left it (`escalated_from` on the task, migration 28). A Haiku task that ran out of context, or answered twice without a tool call, carries on too; one out of context isn't asked what it tried. Budget stops, cancellations, takeovers nobody answered and "Blocked: …" endings (a login or captcha) don't carry on, since Opus can't get past them either. The weekly report has a line per model a desktop task started on: done, failed, and how many of Haiku's failures Opus then finished.

Check tool versions and model IDs against the live docs at implementation time.

### 5.5 Built-in tools (brain)
| Tool | Lane | Default policy |
|---|---|---|
| `run_desktop_task(goal, success_criteria)` | screen | Starts the Opus computer-use subloop; queued per §5.6 |
| `run_task(title, goal, effort?)` | bg | Chat only. Starts a background task with every plugin tool, for work that takes more than two changes or should carry on without you (§4.5); shows under the reply |
| `research(title, question, previous?)` | bg | Chat only. A research task (§17): Haiku 5.5 at xhigh effort with up to 5 Haiku helpers at once, the numbers cited as [n] checked against the quotes the helpers copied, and a report with numbered sources saved in memory and attached; shows under the reply |
| `request_takeover(reason)` | screen | Pauses and notifies you (logins, 2FA, captchas) |
| `desktop_shell(command)` | screen | Desktop tasks only. Runs as `hatbot-desktop-shell`'s own systemd DynamicUser (home `/var/lib/hatbot-shell`): no `/home` (the browser profile), no screen, no secrets, Unix socket relayed by desktop-agent. Destructive patterns ask |
| `memory_*` (list/read/write/search) | bg | Free; every write is a git commit |
| `search_history` | bg | Free |
| `schedule_*` / `trigger_*` (create/list/update/delete) | bg | Free; everything visible in the UI. After untrusted content some changes ask (§6.1) |
| `web_fetch` / `web_search` | bg | Anthropic's server tools, the dynamic-filtering versions: called directly or from code in Anthropic's container, which keeps only what matters; $0.01 a search; output is **untrusted** |
| `proxmox_*` plugin (status, list, start/stop/restart, snapshot of own guests) | bg | Read and restart free; anything else needs approval |
| `ssh_exec(host, cmd)` plugin | bg | Hosts from Settings, as the `hatbot` user; destructive patterns need approval. Output is **untrusted** unless the command only checks status (`uptime`, `df`, `systemctl is-active` and the like) |
| `ssh_pct_exec(host, guest, cmd)` plugin | bg | Optional: a command in a Proxmox container through a host marked "Proxmox host" (`infra/pct-exec-setup.sh`): root in the container via a sudo-only wrapper that refuses any container tagged `hatbot`; same rules as `ssh_exec`. Not offered without `HATBOT_BRAIN_ID` |
| `forgejo_*` plugin (read, comment, open PR) | bg | Merge, force-push and delete need approval. Branch names must be ones git takes; a new branch named as its base or the default branch asks |
| `github_*` plugin (the same, on GitHub, plus CI: `github_ci` lists each check with its id, `github_ci_log` reads a failed job's log, **untrusted**) | bg | Merging, committing to the default branch (in any letter case), changing workflows or actions (`.github/actions`, any `action.yml`) and a new branch named as its base ask. Files and CI are trusted only on the default branch of a repository the bot account can see, not on forks, mirrors or other branches, so the CI loop taints its task. Code work lets the repository's CI check its branch before the pull request: on a failure it reads the log, fixes and pushes, at most 3 rounds, then says the result in the pull request (a draft if it still fails). The sandbox has no Rust or Swift and little RAM, so CI is the build machine |
| `watch_*` (create/list/update/delete) | bg | Free; a watcher made after untrusted content starts its tasks tainted (§15). One that reads a page or an untrusted tool taints the chat that lists, makes or changes it |
| `notify(message, priority)` | bg | Free |
| `mcp_*` plugin (each server's tools) | bg | Default **Ask first**; per tool Off, Ask first, Always ask, Allow or Chat, no asking. Tools that pay, buy or change accounts always ask (§4.5) |

The `run_desktop_task` **subloop** uses the computer toolset against the desktop-agent daemon, plus the browser toolset for web pages:
- The model reads pages as text and acts on elements by reference, and takes a screenshot only when it needs to see the page. It starts from the list of open tabs instead of a screenshot; the timeline still gets one.
- A batch of toolset calls stops at the first failure (or held-back click); the rest get the API's "Not executed" text.
- Screenshots go to `/archive` as WebP and into the task timeline.
- The subloop returns a structured summary to the parent.

### 5.6 Scheduling and lanes
- **Screen lane**: a single FIFO queue. While a screen task waits for approval or takeover, it **releases** the lane, so other screen tasks, alerts and negotiation sends run meanwhile. When it resumes, it takes a fresh screenshot and re-checks the state before doing anything. A task that starts while another task of the same bot waits mid-run opens its own tab instead of closing the others.
- **Takeover**: Take over gives the task that asked the screen and its browser profile first. It waits up to 8 s for a task mid-step, then says "Another task is using the desktop. Try again in a moment." Several requests wait in turn; the first is shown. If desktop-agent can't lock the input after the asking task got the screen, the task gives it back and waits, and the next Take over gives it the screen first again. Teach mode can start while a task only waits for a takeover.
- **Background lane**: a worker pool, with a concurrency of 3 by default.
- **Scheduled and trigger tasks**: background tasks on Opus 5.5 (the chat's effort setting) with memory, history search and `run_desktop_task`, which waits for the desktop task and returns its summary as untrusted data. They can't create schedules. They enter the same queues. If one fires while its previous run is still going, the new run is skipped: one run at a time per schedule, per webhook, and per Uptime Kuma monitor (later alerts and "back up" go on the running task's timeline). A Kuma down or up within an hour of the monitor's last alert task ending goes on that task's timeline too. A down then waits until the hour is over and starts a new task if the monitor hasn't come back up, and you're told once that it's down again (Kuma sends nothing more while a monitor stays down).
- **Reporting**: a run ends with `finish_task(summary, notify)`. With news (or a failure) it posts a message in the thread and sends a notification, and the chat hears about it in `<task_updates>`; a routine result only shows in Tasks and on its schedule's page.

---

## 6. Safety model

### 6.1 Trust tracking
Every piece of content entering a context is labelled **trusted** or **untrusted**.

**Trusted:**
- your chat messages
- memory files, except research reports and `research/sites.md` read back (below)
- Uptime Kuma's own fields in an alert: monitor, type, URL, status and time
- output of status-only commands on your hosts (`uptime`, `df`, `free`, `systemctl is-active`, `pct list`, `zpool status` and the like, piped into `head`, `grep` and so on)
- Proxmox API data
- files and CI on the default branch of a repository the bot account can see

**Untrusted:**
- web pages, screenshots and page text
- `web_fetch` / `web_search` results, and the output of code the web tools run (it always counts as a web read)
- Forgejo/GitHub issue, PR and comment text; files and CI from forks, mirrors and other branches
- generic webhook payloads (each trigger can be marked trusted), and a Kuma alert's free-text message: it reaches the task as `<event_message trusted="false">`, isn't shown to Haiku's review, and taints the alert task when it isn't empty
- MCP tool output (unless the server is marked trusted), and an untrusted server's tool descriptions until you accept them (§4.5)
- other command output from your hosts, and logs and files read from them (`ssh_check logs`/`errors`, `ssh_read_file`): anyone who reaches a service can write into its logs
- `code_run` output, always
- Home Assistant's free-text states (shown as `[text]`; a state shows only when it's a number, a time, one of HA's own words or an option), and `homeassistant_entity` except for plain-device domains
- attachments, and research reports and `research/sites.md` read back from memory
- what tainted work hands on: a tainted task's summary reaching the chat, another bot or Opus (`get_task` quotes its steps too), the running summary of a chat that read untrusted content, notes in the chat from watchers that read pages or untrusted tools and from the heartbeat, and `search_history` hits from tainted conversations, tasks or notes

Once a task has read **any untrusted content**, it is *tainted*. In a tainted task, these **outward actions** need your approval:
- sending or posting
- submitting forms that send personal data
- deleting
- buying
- changing remote state (SSH writes, Proxmox power actions, forge writes)

**Taint carries on.** A summarized conversation that read untrusted content makes every new conversation in that chat start tainted, `/new` included, with the summary shown as untrusted JSON; deleting those conversations clears it. The summariser is told not to keep requests from quoted content. A `run_desktop_task` or `ask_bot` from a tainted chat or task starts tainted. Most Kuma down alerts carry a message, so alert tasks are usually tainted.

**Automations after untrusted content**: in a tainted chat, any change to a schedule or watcher that's on, deleting one, switching a schedule, watcher or trigger off, or changing a Kuma trigger's `confirmChecks` goes to Haiku's review and then to you, and the approval lists every change. A rename always asks you. Switching one on, or changing one that's off, doesn't ask. In a suspected chat (below), making a schedule or watcher asks too.

**Memory that everything trusts** (decided 2026-10-16): memory is trusted on every read, so a tainted chat or task can't write it all directly. Its `memory_write` and `memory_delete` on `skills/**`, the root `INDEX.md`, `bots/*/INDEX.md` and `homelab.md` become a proposal (Memory → To look over) with a low-priority notification. The proposal's reason names the untrusted sources, never their text. Applying it commits as you; a newer write to the same file replaces one still waiting, and a file changed since makes it stale. Other files still commit directly. Your own edits, `/remember` and teach-by-showing are unchanged.

Untainted tasks stay fully autonomous. **Haiku's review:** before any change that would ask, whether this rule or a plugin's own policy asks, tainted or not, in the chat or in a task, Haiku 5.5 reviews it: it sees your request or standing instructions, the goal, the names of the untrusted sources if any (never their text) and the action. A task another bot asked for gets the asking task's words from you (its chat request, or its standing instructions and approval notes), never the request text. If it isn't destructive or dangerous (a restart, a reload, a re-run, a fix to what the work is about, a merge or a post you asked for), it goes ahead and the timeline says so. Deleting and other hard-to-undo changes, taking things down for good, account, key, sudo, firewall or persistence changes, posting or sending what you didn't ask for, spending or moving money, fetching and running code, home access, and anything whose input looks like it came from untrusted content still ask, with Haiku's reason. It also judges scope: a change your words don't lead to (another host, repo or recipient, or another kind of action) asks, and the goal can't on its own explain a link, address, recipient or command. It answers as schema-checked JSON. Doubt or a failed check means asking; a suspected injection skips the review (below). Settings → Safety turns it off. (2026-10-13, the owner's choice: this replaced a separate "you already asked for this" check, which only ever saved taps the review now saves.) **Always approval, no review:** payments, purchases, credential and account-security changes, budget, MCP tools that pay, buy or change accounts, hosts and guests you marked careful, and who can get into the house (the `access` kind: locks, the alarm, covers, entities you marked in Settings → Plugins → Home Assistant, and scenes, groups, areas and other targets that may reach one).

How it's enforced:
- **Screen actions** (`apps/brain/src/tasks/policy.ts`): the desktop model asks for consequential steps through a small `confirm_intent(kind, summary)` tool before taking them. The policy engine also holds a click, or Enter or Space, on anything that could be consequential, read through desktop-agent's inspect and CDP. Browser toolset clicks are checked the same way, on the element at the reference's centre or at the viewport point. A held step tells the model plainly whether to ask or go another way.
  - **Labels**: names that read like submit, pay, buy, order, offer, accept a price, send, delete, confirm or transfer, in English and as Polish and Czech stems ("Płacę", "Do kasy", "zaplatit", "objednat"), with accents folded and Unicode word edges. Buttons with no name or only a symbol, and divs made clickable, are held unless they toggle something. Filter, sort and search controls don't hold for submit, confirm, apply or remove, and a search box's query isn't text waiting to go (in a POST form, only under `role=search`).
  - **Checkout and payment**: on a checkout or payment page (a path part starting with checkout, kasa, platnosc, payment, pay, zamowienie, objednavka or pokladna, Shopify's `/checkouts`, `/order`, `/gp/buy`, a `route=` or `controller=` checkout query) or a payment provider's host (one list: PayU, Przelewy24, PayPal, Tpay, Paynow, imoje, Dotpay, BLIK, GoPay, Comgate, Google Pay, Stripe Checkout, Adyen), every click except typing and choosing an option asks. A step in a payment frame asks as that checkout; a frame Hatbot can't enter asks as a purchase, whatever its title.
  - **Keys**: only named keys and single characters (§4.2). Enter or Space on a focused button or link counts as pressing it. Enter or Space after other keys in one action, repeated or held is refused, and so is typed text with a tab followed by a space or line break. Enter in a chat box asks when a button beside it sends or has no name; Enter in a box with no button and no form is held; shift+Return is a new line and passes. A typed line break is checked with the text before it already typed.
  - **Address bar and windows**: while the keyboard is off the page (the address bar, another window, a page that doesn't answer), Enter or Space is held and the model is pointed to navigate. Typed `javascript:`, `data:` and `vbscript:` addresses are refused. Where browser windows overlap, a click is held as unseen, so a click in a popup over the main window asks; the browser toolset with the popup's tab is the way around.
  - **Mouse**: right clicks are refused. Middle clicks and mouse down and up are checked where they land, drags at both ends.
  - **Frames**: clicks and focus in frames from other addresses are followed over CDP. A frame that still can't be read, or an inspect that fails, is held.
  - **Marketplaces**: outside a negotiation, on olx.pl, allegrolokalnie.pl and vinted.pl, any click or Enter while a text box holds text asks, except clicks into a box and on links. Messaging sellers goes through §16.
  - With an older desktop-agent (no `gates` feature), a browser click on a blank part of the page is held, and icon-only, toggle and search controls can't be told apart.
- **Defence in depth**:
  - Untrusted text only ever enters through tool results or the app's notes, labelled with its source and JSON-encoded; its blocks can't be closed from inside.
  - The system prompt states the untrusted-content policy, in its own section before Style, and tells you when a page tried to instruct the bot. A bot's role can add care but can't loosen the rules on untrusted content, approvals or payments.
  - Haiku 5.5 screens untrusted text for injection, in the chat, background tasks and desktop tasks alike: fetched pages, search-result titles, the web tools' code output, untrusted plugin output, PDFs (as documents), text attachments, files viewed in the code container, research notes read back, an alert's first message and untrusted task payloads. It runs in the background, each text once (by hash); a change, and the next reply, wait for the verdicts so far. Incognito isn't screened, since it can't change anything.
  - **A suspicion**, or a screening check that failed, means no Haiku review: every change asks you, and the approval says why (the tray shows it too). It lasts for the rest of the task, and in a chat it carries into the next conversation and through the running summary until that conversation is deleted. Tasks the chat starts after it, and a suspected task's `ask_bot` hand-offs, start suspected.
  - Anthropic's built-in computer-use and browser-use injection checks stay on.

### 6.2 Approvals
- **An approval contains**: the action, its arguments or a preview, *why* Hatbot wants to do it, the untrusted sources that tainted the task, a screenshot if relevant, and the cost so far.
- **Where you approve**: in the web UI (inline card + side panel), in the iOS app, or with ntfy action buttons.
- **ntfy buttons**: carry a **single-use, short-lived signed token** (HMAC over approval ID + decision + expiry). Approve works from a notification, and so from a locked phone, only for `send`, `submit_personal_data`, `delete` and `other`. **Approved only in the app** (web or iOS): `purchase`, `payment`, `account_security`, `access`, `mandate`, `budget` and `injection_warning`; their notification shows *Open in Hatbot* and Deny, and an older notification's Approve for them gets a 403. Every approval notification also has **Pause all**, with its own signed token (`POST /pause-all/token`); resuming needs the app.
- **Kinds**: `access` is who can get into the house (§6.1). A desktop step is raised to `payment` on a payment provider's page, in a payment frame or with card or BLIK fields on screen, and to `purchase` when it says it buys or pays (Czech words too) or is in a frame Hatbot can't see into. A negotiation message past its mandate asks as `purchase` (§16.7).
- **What an approval covers**: on the desktop, an approval asked after a held step covers that step on that page, and its reason ends "(Hatbot held: …)". One asked before trying (`confirm_intent`) covers the next held step on that page, unless that step may buy or pay and the approval's kind is one a notification can approve. A held step the model moved on from isn't carried into the next approval.
- **Steering**: with Approve or Deny you can write a note, in the web UI or the app (not from ntfy), on every kind that takes one. The task gets it with the decision and follows it: deny and say what to do instead, or approve and say how. The note counts as your words for the check below, so the action it asks for doesn't ask again. Not for budget or injection warnings.
- **Plain text**: approvals show as plain text everywhere, never Markdown, with the summary in monospace.
- **Waiting**: the task pauses and frees the screen lane. It auto-cancels after **24h** and notifies you.

### 6.3 Spending
- **Price table**: per-model prices live in config, the fallback models' (Opus 5 and Opus 4.8) included. A model with no price is billed at Claude Fable's rates ($10/$50) and logged. Cost = `usage` × price, recorded per request, task and day.
- **Before each request**: the most it could cost. Prompt not known to be cached is priced at the cache-write rate, what the last request left in the cache within its lifetime at the read rate, all of `max_tokens` as output, plus $0.01 for each web search it may make (8 a request), and for Opus chat and `ask_opus`, a fallback model too. The request holds that much against the limits until its cost is recorded, so requests in parallel can't pass a limit together. Refuse if it would exceed the per-task ($3), daily ($10) or monthly ($200) limit. So limits stop work earlier: an Opus chat request holds about $0.64 for output alone, a Haiku background request about $0.09, mostly search fees. Thread summaries and Haiku's approval reviews are checked too: a summary waits, a review asks you.
- **A task's own limit**: it covers the tasks it started (`run_desktop_task`, `ask_bot` from a task, plugin child tasks); the task at the top holds it, and the cost shown for a task includes its children. The task asks to spend one more per-task limit ($3), as an approval ("Let task #N and the tasks it started spend $3 more"). Approve and it carries on; deny, or no answer in 24h, and it fails ("Stopped at its spending limit."). A research task starts with its own limit (`limits.researchUsd`, $5, Settings → Spending limits → Per research task), and each raise adds that much.
- **The daily or monthly limit**: the task fails at once with "Stopped: Today's $10 limit would be exceeded." (or the month's), and a chat reply stops with the same line. Nothing more runs until the limit resets or you raise it in Settings.
- **Kept for alerts** (decided 2026-10-16): the last $1 of the daily and monthly limits (`limits.alertReserveUsd`, Settings → Spending limits) is only for alert and heartbeat tasks, their desktop tasks, and the heartbeat's own look. Everything else stops short of it ("… (its last $1 is kept for alerts)"). So a busy day still leaves room to look into a monitor that goes down. Deleting a summarized conversation may use it too; past that, it answers that the limit is spent. When even that is spent, the alert task fails with "Not investigated: today's limit is spent. The alert: Jellyfin (http://…) is down: timeout", so the notification still says what happened.
- **Credits**: the Max 20x API credits are the only funding source, so the provider stops requests at $0 as a backstop.

### 6.4 Isolation
- **Network**: both guests sit on the LAN bridge with static IPs. The host's nftables table `bridge hatbot` filters frames at the desktop's bridge port (`veth<ID>i0`), where the desktop can't touch it. It allows only the desktop's own MAC and IP (no spoofing, no ARP poisoning), drops IPv6 and non-IP traffic, drops everything to private ranges (including `192.168.55.0/24`) and to the host itself, and lets through only replies to the brain on 5901/7070. Inside the brain, nftables also drops new connections from the desktop. The desktop also filters itself: its nftables output chain lets the users that browse and run commands (`desk`, and the shell's and renderer's DynamicUsers) open connections to the internet only, not to private ranges, its LAN, the brain or `HATBOT_PUBLIC_IPS`, and no IPv6; a LAN resolver stays reachable on port 53. Root could lift that one, which is why on Proxmox the host's table is the fence and this is a second layer; without Proxmox (`ssh-setup.sh`) it's the only one. `infra/test-firewall.sh` tests both rulesets in network namespaces.
- **Secrets**: the desktop holds no secrets except its browser profile.
- **Brain secrets**: in `/etc/hatbot/secrets.env` (mode 600), loaded at start, never sent to the model. The Anthropic API key and the ntfy server can also be set in **Settings → Connections**: the brain tries a key against the API before keeping it, and keeps both in `/var/lib/hatbot/secrets.json` (mode 600), out of the database, so the nightly snapshots and the settings every client is sent don't carry them. Set there, they replace the host's at once, with no restart, until **Use the host's**. The app is only told whether each is set, where from, and the key's last four characters; a ntfy topic that's easy to guess is refused.
- **Proxmox token**: privilege-separated, with a custom role (§9.3).
- **SSH**: a dedicated `hatbot` user on each allowlisted host, with a key per host and restricted sudo rules where needed.
- **Hatbot's own guests**: `host-setup.sh` and `pct-exec-setup.sh` tag the brain and desktop `hatbot`. The `pct exec` wrapper refuses any container with that tag, and `proxmox_power` refuses tagged guests other than the desktop. Without `HATBOT_BRAIN_ID` (in `proxmox.env`), `proxmox_power` and `ssh_pct_exec` aren't offered and copies into containers are refused.
- **Desktop services**: the desktop shell and the renderer each have their own IPC namespace (`PrivateIPC=yes`), so the screen grabs' X shared memory is out of their reach; `verify.sh` checks it. `/fetch` connects to the address it resolved and checked (every IPv6 form of a private address is refused, at each redirect), and `/render` checks its first URL the same way. `desktop-deploy.sh` installs only an archive of plain files and directories, with no set-id bits and no paths outside it.

### 6.5 Kill switch
- **Pause all** (in Settings → Safety, and as a button on every approval notification) stops all loops and the rest of each turn, empties the queues and locks the desktop's input. While paused no task starts: `/task` says so, negotiations wait for Resume, and anything else ends as cancelled with "Not started: Hatbot is paused.", without a notification. A banner under the toolbar says so on every web page, with Resume.
- **Resume** is a deliberate click, in the app.

---

## 7. Data

### 7.1 SQLite (SSD, WAL)
`messages` (thread; FTS5 index), `memory_fts` (memory files by section, for search), `episodes`, `tasks`, `task_steps` (tool calls, results metadata, screenshot refs), `approvals`, `schedules`, `triggers`, `spend_ledger`, `sessions` (auth), `api_tokens`, `settings` (including each plugin's switch and settings), `skills_index`.

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
- **Commits**: every write is a commit authored `Hatbot <hatbot@local>`, with a message that names the task. Your edits from the UI are committed as you. A commit names its paths, so nothing else staged is swept in; a write or delete that fails partway puts its files back as the last commit has them. A revert refuses, naming the file, when a file it touches has uncommitted edits. At start the brain removes a leftover `.git/index.lock`.
- **Skills in INDEX.md**: its Skills section is rebuilt from `skills/` in a commit of its own ("List the skills in INDEX.md") whenever it differs, at start and after any memory commit.
- **UI**: lists commits, shows diffs, and reverts a commit with one click.
- **Search** (`memory_search` and the app's search box): FTS5 over each file's sections, split at headings, with Porter stemming. Any of the words may match, the best-ranked (bm25) section first, shown as its line with the most matches. Every commit reindexes the files it changed; startup reindexes everything, which picks up hand edits. If the index fails, search falls back to `git grep` for lines with every word. No meaning-based search: Anthropic has no embedding API, and a local model on a host without a GPU isn't worth it at this size.
- **Not pushed to any remote.** Backed up by PBS.

### 7.3 Archive (`/archive`, HDD pool mount)
- **Screenshots**: `screens/YYYY/MM/DD/<task>/<step>.webp`.
- **Raw transcripts**: compressed API request/response JSON.
- **Retention**: kept forever, and included in PBS backups.

---

## 8. API (for web and the iOS app)
REST + JSON under `/api/v1`. One WebSocket at `/api/v1/stream` for events. The types live in `packages/shared`. A 400 is `{error, field?}`, naming zod's first issue. Errors are plain sentences ("That's gone.", "That was already answered."), with no stack traces. Bodies are read up to 16 KB on `/auth/*` and the ntfy buttons, 25 MB for attachments and 5 MB elsewhere. A task carries `conversationId`, the chat it reports to.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login` (password + TOTP) → session cookie (web) or bearer token (apps) · `POST /auth/logout` (ends the session, or the bearer token it's called with) · `POST /auth/password` · `POST /auth/totp/start`, `POST /auth/totp` (a new authenticator) · `GET /auth/sessions` · `DELETE /auth/sessions/:id` · `POST /auth/sign-out-others` · `GET/POST/DELETE /tokens` |
| Thread | `GET /thread/messages?before=` · `POST /thread/messages` (streams the reply over WS; an optional `clientId` repeated within 10 minutes gets the message already posted, kept in memory only) · `POST /thread/ask` (waits up to 25 s for the reply, for Siri) · `POST /thread/messages/:id/retry` and `/conversations/:id/messages/:id/retry` (an errored latest reply, written again in place) · `GET /thread/episodes?ids=` (recaps) |
| Tasks | `GET /tasks?status=&before=&limit=&botId=&origin=` · `GET /tasks/:id` (+ steps) · `POST /tasks/:id/cancel` · `POST /tasks/:id/rerun` `{goal?}` · `GET /tasks/:id/screens/:stepId` (a raised budget is an approval) |
| Approvals | `GET /approvals?pending` · `POST /approvals/:id` `{decision}` · `POST /approvals/:id/token-decision` (ntfy; 403 for the kinds approved only in the app) · `POST /pause-all/token` (ntfy's Pause all) |
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

**Without Proxmox**, `infra/ssh-setup.sh` sets up any two Debian 13 machines you reach over SSH (VMs, Incus containers, cloud servers), or a brain alone without a desktop. It checks they're Debian 13 with systemd, different machines, without firewall rules provisioning would wipe (Docker, ufw, firewalld), and that the desktop's address is private, since VNC and desktop-agent aren't encrypted; then it writes the desktop secrets and runs the same provision scripts. It saves `HATBOT_TRANSPORT=ssh` and the machines' addresses in `host.env`, and `deploy.sh`, `verify.sh` and `reset-login.sh` reach the guests over SSH instead of `pct` (`infra/lib.sh`). There's no host firewall, Proxmox token, snapshots or backups: the desktop's own output chain (§6.4) is its only network fence.

The app itself is installed by `infra/deploy.sh`, run where the setup ran for the first install. It sends a `git archive` of a commit to the brain, which installs it as a new release under `/var/lib/hatbot/releases`, builds the web app, writes and restarts `hatbot-brain.service`, and goes back to the previous release if the health check fails. The first run asks for the public URL (only its scheme and host; the brain won't start with a path), the reverse proxy's IP, the Anthropic API key, ntfy (it suggests a random topic, §9.4), the git repository to update from, and the SSH public key you sign commits with. After that, **Settings → Update** does the same from git: the brain writes a request file, `hatbot-update` (root, on the brain) fetches with a token the brain service can't read, sends desktop-agent its new code, and runs the new commit's `brain-deploy.sh`. With a signing key (`HATBOT_UPDATE_SIGNERS`, `/etc/hatbot/allowed_signers`), Update deploys only commits signed with it, and only forward: a branch moved back or rewritten is refused, though `deploy.sh` still deploys it on purpose. Without a key, `deploy.sh` and Check everything warn. Host-side scripts still change only through `deploy.sh`. `infra/reset-login.sh` on the host forgets the password and authenticator, signs out everything, restarts the brain and prints a new setup code.

### 9.3 Proxmox roles
- **`HatbotOps` on `/`**: `VM.Audit`, `VM.PowerMgmt`, `Sys.Audit`, `Datastore.Audit`. Hatbot can see and start/stop/restart every guest.
- **`HatbotSnapshots` on `/pool/hatbot`**: `VM.Audit`, `VM.Snapshot`, `VM.Snapshot.Rollback`. Only Hatbot's own guests.
- **Never**: config change, allocate, console, migrate, or destroy rights. `infra/verify.sh` checks this.
- **Commands in containers** don't use the token: the optional `infra/pct-exec-setup.sh` gives a `hatbot` Unix user on the host one sudo rule, for a wrapper around `pct exec` that refuses the brain, the desktop and any container tagged `hatbot` (it tags the brain and desktop if they aren't yet). It makes Hatbot root inside your other containers, by the owner's choice (2026-10-11).

### 9.4 Exposure (you own this part)
- **Your reverse proxy** → `http://<brain-LAN-IP>:8080` for `hatbot.gaycats.ovh`. It must pass WebSockets (`/api/v1/stream`, `/api/v1/desktop/live`). Hatbot trusts `X-Forwarded-*` from your proxy's IP only (`HATBOT_TRUSTED_PROXIES`, asked by `deploy.sh`); when requests come through a proxy that isn't listed, the brain logs it and Check everything's Public address warns.
- **ntfy** runs on your own server, separate from Hatbot. The brain publishes to it with a token whose user may write to Hatbot's topic (`deploy.sh` asks for the URL, topic and token; Settings → Connections can change them). Whoever can read the topic sees every notification and can press its Approve buttons, so there's no default topic: `deploy.sh` suggests a random one, and on the ntfy server only your user may read it (`auth-default-access: deny-all` or `write-only`, plus an access rule for your user). Check everything fails a guessable topic unless it can tell that only your user reads it; a topic counts as random only with 16 or more hex characters or 22 or more mixed letters and digits. Without a token, when anyone can read a random topic, or when it can't tell who reads one, it warns. Set `upstream-base-url: https://ntfy.sh` on that server so iPhone notifications arrive instantly; only a "wake up and fetch" ping passes through ntfy.sh, never the message content.
- **Public paths needed**: the UI, the API, and `/api/v1/hooks/*` for webhooks.

### 9.5 Prerequisites (you)
- Max 20x with API credits linked to a Console org, plus an API key.
- Bot accounts: `hatbot` on Forgejo (and GitHub if wanted), added as collaborators to chosen repos, with a token in `/etc/hatbot/forgejo.env`.
- A `hatbot` user on each host Hatbot may reach, with the brain's public key (shown in Settings → Plugins → SSH).
- An Uptime Kuma webhook notification pointing at Hatbot.
- The ntfy iOS app subscribed to Hatbot's topic.

---

## 10. Web design spec

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
- **Components**: our own, styled with CSS variables, with no component library (no Radix, no Tailwind). The switch is `switch.tsx`. Confirmations and text prompts use a native `<dialog>` (`confirm.tsx`: `ask()` and `askText()`, rendered once by `<Dialogs/>`), never the browser's `confirm()` or `prompt()`; only leaving a tab with unsaved edits still shows the browser's own prompt. Toasts have a kind: done (a check), error (a red alert) or info (no icon). Switches, segmented controls and fields have names and state for screen readers.
- **Text on amber** is dark (`--on-accent`, #1d1d1f). Section titles are sentence case.

### 10.3 Layout
- **Desktop (≥ 900px)**:
  - **Sidebar** (240px): Chat, Tasks (with a count of what needs you), Live, Schedules & Triggers, Memory, Spend, Settings.
  - **Centre**: a toolbar with the title, then the content.
  - **Side panel** (420–640px, 32% of the window, toggled from the toolbar): **Live**. Task details are their own page (`/tasks/:id`).
  - **Pause all**: while paused, a banner under the toolbar on every page, with Resume.
- **Phone (< 900px)**:
  - A single column with an iOS-style **bottom tab bar** (Chat, Tasks, Live, Memory, Settings). Spend opens from Settings.
  - Live is a full page; a Keyboard button opens the phone's keyboard during takeover.
  - The app sizes itself to the visible viewport, so the on-screen keyboard doesn't cover the composer, and the tab bar hides while a text field has focus. Form labels sit above their fields.

### 10.4 Task, approval and schedule messages
Plain messages, not cards; the details live on the task's or schedule's page.
- **Task started from chat**: no message of its own. The reply that started it shows working dots and the latest step, then the task's result in the same bubble.
- **While a reply is written**: under the dots, what Hatbot is doing ("Thinking…", "Reading memory: homelab.md", "Checking a host: nas, logs") and what the reply has used so far ("4.2k tokens · $0.021").
- **Background task** (schedules, triggers): one message when it ends, the title in bold and its summary.
- **Approval**: what Hatbot wants to do, why, which untrusted page it read, a screenshot, **Approve** (blue) and **Deny**. Once answered it shrinks to one line, and once its task ends that line moves into the task's own message (the reply that started it, or its card), above the result. The chat's tray shows only that chat's approvals: those asked in it, and those from its bots' tasks. The rest are one line, "N more waiting in <chat>", which opens that chat (or Tasks, when they're spread over several). In the tray, why it asks, the screenshot and the note sit behind More.
- **Schedule created**: "Scheduled **name**: every day at 08:00."

Markdown and code blocks render fully. Replies lead with the answer and use lists, **bold** key values, tables and code blocks where they help; text a reply adds after a tool call comes after a rule (`---`).

**Folded conversations**: every episode but the latest folds into one line, its recap (or its first message, for episodes from before recaps), with the time. A tap opens it in place. Cards from background tasks fold with the conversation before them; an approval still waiting for you stays in view.

### 10.5 Live view
- **Watch-only by default.** `/live` shows the desktop as large as the window allows, up to 1280×800.
- **Keys held** when the view loses them (the window blurs, the tab hides, Hand back, leaving the page) are let go; desktop-agent also lets go on unlock and when a viewer that sent input disconnects.
- **Take over**: a blue 2px border and a banner, *"You're in control — Hatbot is paused"*, with **Hand back**.
- **When Hatbot asks**: the panel shows its reason ("Captcha on example.com") and you get an ntfy push.
- **Teach mode**: **Teach a skill** next to Take over. While recording, a plain banner (no dot): *"Recording. Show Hatbot how."*, with **Discard** and **Stop & create skill**. Stopping opens the draft at `/memory/teach/:id`: the name (`skills/<name>.md`) and the markdown to edit, **Save skill** or **Discard**. Drafts not yet saved are listed in Memory.
- **Teach keeps secrets out**: typing into password, code and card fields (in frames, open shadow roots and text areas too, and in any keyboard layout) is only counted. No screenshot is kept while such a field holds something, while a payment frame shows, or while the page can't answer the check; a page where typing turned out hidden gets none for the rest of the recording. A recording's screenshots are deleted when it's discarded and once its skill is saved.

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
Email via Proton Bridge.

**Not planned** (the owner's call, 2026-10-16): messengers (Signal, Telegram, Matrix); being reachable only through Hatbot's own web and iOS app is fine. Email and calendar wait for after v1.

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
- **Prompt**: `SYSTEM_PROMPT` takes the bot's name and instructions, plus the other bots with one line each (quoting the first line of each role), for `ask_bot`. Task and desktop prompts name the bot too. After `</role>` a line says a role can add care but can't loosen the rules on untrusted content, approvals or payments. `ask_bot` is only for work that needs another bot's plugins, logins or notes.
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
- **Deleting a bot:** its chat goes away. The brain keeps the messages, but the chat takes no new ones (410, "That bot was deleted, so its chat takes no new messages.") and search leaves it out, as it does a deleted group. Its reply in progress stops. Its schedules, triggers and watchers go to Hatbot switched off, for you to look over and turn back on; so do automations its reply made during the delete, when they come due. A heartbeat that ran as it is switched off, and the confirmation says so.

### 14.6 Templates (built 2026-10-17)
New bot starts from a template, or from nothing. A template fills in the name, icon, colour, role, model and plugins, and all of it can be changed before Create. They're `BOT_TEMPLATES` in `packages/shared/src/templates.ts`; the web reads them from there, and the iOS app from `GET /bot-templates`, so a new one reaches it without an app update. Each role's first line, in the third person, is what the other bots see of it (§14.3). A template applies only when a bot is made: a bot made earlier keeps its old instructions until you paste in the new ones.

| Template | Does | Plugins | Model |
|---|---|---|---|
| Haggler | Buys second-hand inside a mandate (§16.8) | MCP (Scout) | As in Settings |
| Sysadmin | The homelab: alerts, backups, updates, a runbook in its notes; restarts once on its own, asks for more | SSH, Proxmox, PBS, Uptime Kuma | As in Settings |
| Coder | Repositories: a branch and a pull request per change, CI checks it, reviews | GitHub, Forgejo, Code | As in Settings |
| Researcher | Asks one to three scoping questions and says its plan, then hands real questions to `research` (§17); asks the second-hand bot (Haggler) for used prices; keeps its reports and notes on sites in its notes (`research/sites.md`, a hint written from web pages, not a list of sites to trust) | None (the web is built in) | Opus, medium |

---

## 15. Looking after things (built 2026-10-15)
What runs without you asking, and the tools to see that it works.

- **Check everything** (Settings, `apps/brain/src/checks.ts`): a real try of each part: the database and its migrations, the public address, a Haiku call, memory, the archive, spending, the last update, ntfy, desktop snapshots, the desktop (version, browser profiles, time zone, shell, browser, page scripts), schedules that keep failing, old approvals, watchers that can't read, and each plugin's own test. It fails a guessable ntfy topic that anyone may be able to read (§9.4), and warns when Update has no signing key, when the desktop-agent lacks the `gates` feature, and when requests come through a proxy that isn't trusted. A test approval tries the lock-screen buttons. `infra/smoke.sh` runs it from a shell with an API token.
- **Watchers** (`apps/brain/src/watch/`, migration 24): a page (fetched by the desktop, which only reaches the internet) or a plugin's read tool, picked out by CSS selector, JSON path or pattern, looked at every 5 minutes or more. No model call: only a change *into* the condition (changed, contains, missing, below, above) counts, and then it tells you or starts a background task with the watcher's prompt. Page text is untrusted, so those tasks start tainted. Made in the chat (`watch_*`) or on the web.
  - **Limits**: a watcher looks at least once a week (`MAX_WATCH_MINUTES`). A pattern runs on its own worker for at most 5 seconds, over at most 200,000 characters. One that counts more than 12 times in 24 hours is switched off, says why and tells you once; switching it on or giving it a new source starts the count again (migration 35). From the third failed check in a row each wait doubles, up to 6 hours; you're told once at 5 failures.
  - **Prices**: each element a selector matches is its own line. Spaces group digits only in threes, "1.299 zł" is 1299 next to a currency, numbers followed by % are skipped, and the first number next to a currency beats the first on the page. A "changed" watcher ignores differences only in spacing.
  - **Run the page's scripts** (`render` on a page's source): for a page that fills in with JavaScript. desktop-agent relays `POST /render` to `hatbot-render` (`apps/desktop-agent/src/render.ts`), a headless Chromium per page with a throwaway profile and no DevTools port, run as its own DynamicUser like the shell, capped at 500 MB, one page at a time. Such a watcher looks every 15 minutes at most. Bot protection blocks it as it blocks a fetch.
- **Search**: one box over messages (FTS5), tasks, memory, schedules, triggers and watchers. A found message opens in its chat.
- **Run again**: an ended root background task starts anew with its goal as you edit it, keeping its origin, bot, payload and taint.
- **Heartbeat** (`apps/brain/src/heartbeat.ts`, on by default): every 30 minutes a look, without the model, at schedules, triggers and watchers whose runs failed 3 times in a row (once per streak), expired approvals, plugins that can't be read, an offline desktop, spend over 80%, and plugin signals (Uptime Kuma monitors down, PBS jobs failed or datastores over 90%). Single failed tasks, tasks stopped by a restart and failing watchers are left out, since you're told about them elsewhere. A Kuma down is skipped while that monitor's own alert waits, its task runs, or its task ended within the hour. Only something new goes to Haiku, which lets it be, tells you, or starts a task with your instructions; Hatbot's own findings (the desktop, a broken plugin, spend, an expired approval) go to it in a separate call from the rest, and it answers as schema-checked JSON. Its tasks start untrusted.
- **Weekly report** (`apps/brain/src/report.ts`, on by default, Monday 09:00): spend by bot, tasks done and failed, approvals, watchers, memory commits. In Hatbot's chat and as a notification, made without the model.
- **Proposals** (`apps/brain/src/memory/proposals.ts`, migrations 25 and 30): writes to skills and indexes held from tainted work (§6.1), and Opus proposes a tidy-up of memory (weekly when switched on, or Tidy up in Memory) and fixes to skills whose tasks failed or needed you since they last changed. Each is a diff per file (Myers' algorithm, a whole replacement only past 2,000 edited lines); Apply commits it as you, Dismiss drops it, and a proposal goes stale if memory changed under it. Opus answers tidy-ups and fixes as structured JSON.


---

## 16. Negotiation (planned 2026-10-16; N1 and N2 built the same day, not tried live)
Hatbot haggles on OLX, Allegro Lokalnie and Vinted for you. It buys first; selling your flips comes later. Its market data comes from Scout (`../scout`) over the MCP plugin. Agreed 2026-10-16.

### 16.1 Decisions
| Area | Decision |
|---|---|
| Who | A bot, **Haggler** (§14). It has its own browser profile, logged in to a separate marketplace account (you make it later), and its own memory folder for the playbook and notes on sellers. Scout is its only plugin |
| Mandate | You approve one **mandate** per negotiation. It covers the listing, the opening offer, the target, the ceiling (a floor when selling), delivery terms and when it expires. Inside it, Hatbot sends and agrees on its own; outside it, it asks, in the app. Paying always asks (§6.1). A mandate runs out at its expiry |
| Untrusted content | Seller messages are untrusted, as before. The mandate stands in for the approval §6.1 would ask for, but only for `negotiate_send` within the mandate, checked in code rather than by Haiku. The check fails closed: a message goes on its own only when it can be read in full and is inside the mandate. Every other outward action in the task still follows §6.1 |
| Agreeing | Within the mandate, Hatbot agrees on its own (your choice, 2026-10-16) |
| One deal per want | Talking to several sellers about one thing at once is fine. The first agreement locks the want, and the other sellers get a decline |
| Tactics | It doesn't have to be honest about our side (your choice, 2026-10-16). It may state a lower "max" than the ceiling, mention other offers, claim urgency or walk away. **Never**: misstating an item's condition, defects or authenticity when selling; fake proof of payment, shipping or receipt; claiming to have paid or sent; posing as the marketplace or a courier; reporting false defects after receiving an item to get money back. Those are fraud: buyer protection reverses them, and they get the account banned. Asked whether it's a bot, it says it's an assistant |
| Consistency | What Hatbot has told each seller (its stated max, other offers, timing) is kept on the negotiation, so it doesn't contradict itself |
| Pace | At most 10 new conversations per account per day, sends at a person's pace, nothing between 22:00 and 08:00 |
| Scams | Seller messages are also checked for marketplace scams (in code, `negotiate/scam.ts`): payment or courier links, BLIK codes, card details or bank accounts, crypto, moving to WhatsApp or Telegram, pressure to pay off the platform. A suspected scam holds the negotiation and asks you in the app. The desktop never opens a link from a seller |
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
- **`negotiate_send(negotiation, text, offer?, agree?, stated?)`**: the only way out. `stated` records what this message claims about our side. The policy, in code, **fails closed**: a message goes on its own only when the check can read every part of it and finds it inside the mandate. Anything it can't read asks.
  - `offer` is within the mandate (at or under the ceiling when buying, at or over the floor when selling), and `agree` only at a price within it, named in both the text and `offer`;
  - only the negotiation's own conversation;
  - no phone number, address, e-mail or other app unless the mandate allows it;
  - every amount in `text` counts, alternatives, ranges, sums and products included, so the cap can't be dodged by writing the number out;
  - only the ways to pay, pickup and shipping that the mandate's delivery terms allow;
  - the pace limits;
  - anything else asks, as in §6.2. Money past the mandate is approved in the app, as the mandate is.

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
- **N3, waking**: Scout's inbox tools, the poller, follow-ups and scam screening (the scam check on the messages a read records is built already, §16.7). Done when a seller's reply gets an answer within 15 minutes, with nobody in the chat.
- **N4, several sellers**: wants with several negotiations, the lock and the declines.
- **N5, selling**: answering buyers on your listings. The floor comes from Scout's flips: the buy price, fees and a margin.

Scout: N1 needs `scout_price_reference` and `scout_comparables` (until then, the appraisal uses `scout_watch_analytics`); N3 needs the inbox tools.

### 16.7 As built (N1 and N2, 2026-10-16)
Not tried live: there's no marketplace account yet. Everything here is tested against a stand-in desktop-agent and a stand-in Scout. The 2026-10-17 review fixes changed the policy, the gate and the mandate's life, as below.

- **Where:**
  - `apps/brain/src/negotiate/`: `service.ts` (records, mandates, the send and read tasks, the pace), `tools.ts`, `appraise.ts`, `mandate.ts`, `policy.ts` (`negotiate_send`'s policy) and `gate.ts` (the exact-text gate). The last two are pure functions.
  - Types are in `packages/shared/src/negotiate.ts`.
  - Migration 27 also adds `negotiation_tasks`, which records the desktop task that reads or sends for a negotiation and the message it sends. It also adds `messages.negotiation_id`, the reply a negotiation shows under.
- **Who gets the tools:** any bot whose plugin tools include Scout's `scout_listing_detail`; a bot without it gets none. Scout's tools are found by name suffix (`mcp_<server>_scout_…`) and used only when set to Chat ("Chat, no asking"), which is pinned to their definitions (§4.5), so reading Scout never asks.
- **Tools:**
  - The six in §16.3, plus **`negotiate_check`**. It runs a desktop task that reads the conversation and records the seller's messages, sending nothing; it's refused before the mandate is approved. N3's poller takes over the routine reads.
  - There is one open negotiation per listing and per want. N4 lifts the second limit.
  - A message is one paragraph of at most 1,000 characters.
  - Amounts are in the listing's currency, which the appraisal takes from Scout (always PLN for now). A mandate in euro reads in euro in Haggler's view and on your cards.
  - The mandate has one `limit`: a ceiling when buying, a floor when selling.
  - The mandate lasts 7 days unless set otherwise, at most 30.
- **Appraisal:**
  - **The typical price** comes from the first source that has one:
    1. Scout's price reference (with its lower quartile);
    2. the watch's median and lower band from `scout_watch_analytics`;
    3. the watch's typical price from `scout_listing_detail`;
    4. the asking price alone.
  - **Walk-away** is the lowest of the asking price, the typical price and any comparable listing priced at 60% of typical or more. A cheaper comparable is likely a different item.
  - **Target and opening:** the target is the lower quartile, or 90% of the typical price. The opening offer is 85% of the target. All three are rounded down the way people write prices.
  - **Notes:** price drops, days listed and the negotiable flag.
  - `negotiate_start` reuses an appraisal made in the same turn.
- **The mandate approval:**
  - `negotiate_start` checks the numbers. Buying, opening ≤ target ≤ limit, and the limit may not exceed the asking price; this also catches misread numbers.
  - It then makes an `awaiting_mandate` record and an approval of the new `ApprovalKind` `mandate`. The approval has no task and belongs to the chat.
  - The card reads "Negotiate: open at …, aim for …, pay at most … · “title”" and shows the listing, Scout's numbers, delivery, expiry and the contact details allowed, and "Up to X on top of the limit for shipping." when the delivery terms allow it.
  - **A note on Approve** is turned into new numbers by Haiku, with a forced `set_mandate` call that sees only the note and the mandate, not the listing's title. The new numbers get the same checks. If the note can't be applied, the approval is asked again with the old numbers and the reason. A note that raises the ceiling, changes delivery or adds contact details comes back as a new mandate approval showing old → new (a longer expiry shows "Until: old → new"); approving that opens the negotiation. The note is kept as `note` inside the mandate (left out of the API) and reaches the opening task. A note is applied once, and a Stop or close while it's being applied stands.
  - **Deny or cancel** makes the negotiation `abandoned`. No answer within 24 h makes it `expired`.
  - **A restart** leaves mandate approvals pending. Other pending approvals are cancelled at a restart, because their tasks stopped.
  - The negotiation keeps its approval, so the decision and the note show on its page.
  - Nothing is agreed before the mandate is approved.
- **Running out:** once a minute, an open negotiation past its expiry becomes `expired` and its tasks are cancelled; the web shows "The mandate ran out." A hold waiting for you is withdrawn then too.
- **The opening message:**
  - On approval, `next_follow_up_at` is set to now, or to 08:00 if it is quiet hours.
  - A one-minute timer (`due()`) then starts a background task as the bot. Its origin is "chat", it shows under the reply with the negotiation, and its request is the approved mandate and the note.
  - The task writes the first message and sends it with `negotiate_send`. Task briefs leave out the seller's title, and the seller's messages sit between tags.
- **`negotiate_send`'s policy** (`policy.ts`, in code, not Haiku). It **fails closed**: a message goes on its own only when the check can read every part of it and finds it inside the mandate. It reads the text through `plain()`: NFKC, invisible format characters dropped, every script's digits as 0–9, and O, o, l and I among digits as 0 or 1. That last mapping is only for reading; the text sent is the NFKC form.
  - **Refused, with the reason given to the model:**
    - the negotiation isn't open, or still waits for its mandate;
    - a send is already in flight;
    - it's another bot's negotiation;
    - the conversation isn't on the listing's site;
    - `agree` without `offer`;
    - words that accept a price (biorę, zgoda, umowa, niech będzie, deal, I'll take it…) without `agree` and `offer`: set them, or reword;
    - quiet hours (22:00–08:00, by the brain's local time);
    - an 11th new conversation within a rolling 24 h, per bot and marketplace, counted by each negotiation's first sent message;
    - less than 2 minutes since our last unanswered message.
  - **Asks you** (always: Haiku can't let these through). It asks as `purchase`, approved in the app, unless its only reasons are a link or contact details, which ask as `send`:
    - an expired mandate;
    - `offer`, `agree` or `stated.max` past the limit;
    - any character outside what can be read for certain: Latin letters with the Polish and Czech ones, ASCII digits, ordinary punctuation, currency signs, °, and spaces (checked after NFKC). Emoji too; Haggler is told so;
    - a number it can't read, numerals from ten up or two numerals together in words, any amount in words (English or Polish, slang included), and digits or letters spelt out one by one;
    - every amount in the text counts: one past the limit asks, alternatives ("1100 albo 1300") and ranges included, as do "2 tys.", "1,5k", "2 000 zł" and "1,5" (read as 1,500). Sums (+, plus, i, oraz, dorzucę, do tego, and) past the limit and the shipping allowance ask, so offering exactly the ceiling plus any other number asks. So do products past the limit (2 x 750, 2 razy po 750, 2 sztuki po 750) and any price per item;
    - amounts set by another or left open: percentages other than 100, "o 100 więcej", "the rest later", twice as much, half price, netto, monthly; and a message about more than one item;
    - another currency;
    - agreeing, by `agree` or in words, without naming its price inside the mandate in both the text and `offer`. A bare "Ok, biorę" always asks;
    - while the seller's last price is past the limit or can't be read: anything that reads as agreeing, and any message that names no price of ours inside the mandate. A question with no price asks then; Haggler is told to restate its offer;
    - a way to pay, pickup or meeting, or shipping that the delivery terms don't allow;
    - a claim that something was paid or sent;
    - contact details the mandate doesn't allow, disguised ones too: a phone number of 9 or more digits, an e-mail address (spelt out too), a street address or postcode, or another app;
    - any link: any TLD, an IP address, or written defanged.
  - **The seller's price** is the highest amount they named since our last sent message (the lowest when selling); with none since, their latest named price; with none at all, the asking price. Only price-sized amounts count (at least half the opening), and "Cena bez zmian" means the asking price. Odd characters in a number, a numeral word, a per-item or relative price, or another currency make it unreadable.
  - **Delivery terms** are read clause by clause, split at `, ; ( ) .`, dashes and "but". A clause allows a way to pay, pickup or shipping only if it has no word of negation: "Wysyłka OLX bez dopłat" doesn't allow shipping. So state what's allowed plainly, and put exclusions in a clause of their own. A clause that puts an amount on top ("up to 20 zł on top") allows that much on top of the ceiling for shipping, at most a tenth of the limit, and only for sums. Terms that say only "OLX" hold any mention of shipping.
  - **Goes without asking:** everything else, read in full and covered by the mandate.
  - Model numbers that are in the title (i7-12700, RTX 3070, 512 GB), dates, times and years aren't counted as amounts. A model number after an all-caps word that isn't its pair in the title, a lowercase one not in the title (rtx3080), "650W", "w Euro" (the shop) and quoting the seller's price all ask.
  - **Still can't catch** (word lists): an acceptance in words it doesn't know while naming our own price inside the mandate; new plain words for paying off the platform; trades ("300 zł i moją starą kartę").
- **Claims:** `stated` (max, other offers, timing, other) is kept on the message and merged into the negotiation's claims once the message is sent. `negotiate_get` shows the claims.
- **Sending** (`gate.ts`, `tasks/desktop-run.ts`):
  - **Start:** `negotiate_send` stores the message as `sending` and starts a desktop task. Called from a task, it waits for the desktop task, giving up its slot meanwhile. Called from the chat, the desktop task shows under the reply.
  - **`record_conversation`** must come first. It stores the seller's messages and the conversation's address. If the seller wrote since the message was approved, nothing is sent. If the message is already in the conversation, it counts as sent.
  - **The send:** a click or Enter passes as the send only when all of these hold:
    - desktop-agent shows exactly the approved text in the one filled text box (NFKC, with whitespace collapsed; a bidi override or a compatibility form makes it differ);
    - the tab is the listing or the recorded conversation; it counts as the conversation only when its path names the listing id, not its query;
    - the button's label starts with a send verb and names no offer, money or payment. Enter in a chat box sends if any button beside it is Send.

    A checkout or frame hold never passes as the send. The gate stands in for `confirm_intent` on that one action. In a send task `confirm_intent` answers at once without asking, and any other held step (a pay or buy button, say) tells the task it can't ask for approval.
  - **Once only:** after the send passes, nothing more goes from that task.
  - **Status**, from the gate only (what the desktop model reports doesn't mark a message sent or move the conversation):
    - `sent`: the text left the box;
    - `unconfirmed`: the text was still there after 3 s;
    - `failed`: the task ended without the send passing, or the message was left `sending` across a restart.
  - **Refused outright:** press-and-drag, middle clicks, mouse down and up; typing a line break or shift+Return (one paragraph); repeated Enter; the address bar and new-window keys; navigating to a seller's link, however it's written (checked after adding `https://`); typing in a reading task; and, once something has been typed, a click or Enter that sees no text box. Links off the listing's site, its own redirect to another host included, are held.
  - **The conversation's address** is recorded from the tab right after a send goes through, or by a read only when the address names the listing id or the page shows the listing's title. If the marketplace doesn't change the address after a first message from the listing page, it stays unknown and sends keep going from the listing page.
  - **desktop-agent:** its inspect now returns the tab's `url`, whether the element is `editable`, and the text in the page's text boxes (`fields`), open shadow roots and same-origin frames included. It advertises this as the feature `fields`; an older desktop-agent can't send.
- **Scam hold:** each seller message that `record_conversation` stores is checked (`scam.ts`): paying off the platform (BLIK, transfers, account numbers that pass the IBAN check, card details, crypto, PayPal, Revolut), payment or parcel links, other apps, and contact details the mandate doesn't allow, disguised spellings included. Graphics cards, parcel codes, serial numbers and "OLX.pl" pass. A hit holds the negotiation with an approval, "Keep negotiating for “…”?" (`injection_warning`, approved in the app), that quotes the message. Approve carries on; deny, or 24 h without an answer, abandons the negotiation. The hold outlasts a restart and applies only to open negotiations, and the bot can't close while it waits. Nothing wakes Haggler after you approve; tell it in the chat.
- **`negotiate_close`**, or **Stop** on the negotiation's page (`POST /negotiations/:id/close`, asked in the app's own dialog):
  - It sets the outcome and appends notes to `bots/<id>/negotiations.md` in memory.
  - It cancels a pending mandate approval and the negotiation's queued or running tasks.
  - It calls `scout_record_outcome` if Scout has it and it's set to Allow; otherwise it tells the model why not.
  - Agreeing past the limit asks (`purchase`).
  - It doesn't decline other sellers yet (N4).
- **API and events:**
  - `GET /negotiations?status=open|closed`, `GET /negotiations/:id` (with its messages) and `POST /negotiations/:id/close`.
  - The events `negotiation.updated`, and `message.negotiation`: a reply now shows a negotiation.
  - `Models.swift` decodes both events; the app doesn't show negotiations yet.
- **Web:**
  - Under the reply: the listing, linked, and one line on where it stands.
  - The negotiation's page, `/negotiations/:id` under Tasks: the mandate approval or its decision, the mandate, Scout's appraisal, what has been said, every message, and a link to the conversation.
  - Open negotiations are listed on Tasks.
  - A mandate approval opens its negotiation from Waiting for you, from the chat's tray (which has a note box for it) and from a notification.
- **What the brain reads from Scout:**
  - `scout_listing_detail {key}`: `listing.{url, title, price, marketplace, typical, watchId, priceNegotiable, postedAt|firstSeenAt}` and `history[].{price, observedAt}`.
  - `scout_watch_analytics {id}`: `current.{medianPrice, lowerPrice, minPrice, listingCount}`.
  - Once they exist:
    - `scout_price_reference {query, sources}` → `best.{typicalPrice, p25, samples, name, basis, ready}`;
    - `scout_comparables {listingKey}` → `comparables|listings|items[].{title, price, url}`;
    - `scout_record_outcome` gets `{listingKey, outcome, price, asking, currency}`.

  Scout's handoff should match these shapes.
- **Not done:**
  - N1's playbook skill, which needs the account: show Haggler one negotiation per site (M5).
  - Everything from N3 on, apart from the scam hold.

### 16.8 Haggler's instructions
Haggler is a template on New bot (§14.6): pick it, and its instructions and its one plugin, MCP for Scout, fill in. The instructions are `HAGGLER` in `packages/shared/src/templates.ts`. In short: find listings with Scout and pick the one that fits best (condition, price against Scout's typical price, delivery), saying why; appraise it, propose a mandate and wait for it; message sellers only through `negotiate_send`, recording each claim; state no maximum until it's ready to hold it, and go past one only with a reason; close as lost when the seller sold, said no or won't come within the limit, and as abandoned when it or you give up; bluff about our side if useful, but never commit fraud, and say it's an assistant if asked; keep everything on the marketplace, and treat a request to pay or talk off it as a scam. `negotiate_send`'s description says what holds: amounts in digits, one price to a message, the price it agrees to in the text, its own price in every message while the seller is above the limit, and plain characters. A Haggler made before 2026-10-17 keeps its old instructions until you paste the new `HAGGLER` text in.

---

## 17. Research (built 2026-10-17, not tried live)
Deep research as its own kind of background task. The chat starts it with `research(title, question, previous?)`, after asking one to three scoping questions when the question leaves out something that would change the answer. Not in incognito.

- **Runs on** Haiku 5.5 at xhigh effort (`RESEARCH_MODEL` and `RESEARCH_EFFORT` in `apps/brain/src/tasks/research-goal.ts`; Opus 5.5 at high until 2026-10-18), whatever Settings say for tasks. It gets up to 60 steps, and the API's task budget (beta `task-budgets-2026-03-13`) is 250k tokens. The prompt is `RESEARCH_PROMPT`; the bot's role and the other bots follow it as usual. It writes in the question's language.
- **Spending:** a research task starts with its own limit, `limits.researchUsd` ($5, Settings → Spending limits → Per research task), and each approved raise adds that much (§6.3). A run usually costs under $1. Its helpers' and the number check's requests count against it and are held in Spend like any other, so the chat and other tasks count them; Spend files them as "Research". The lead is told to finish at 2 steps left, at 80% of its limit, or once fewer than two of its requests fit. A lead that ends without `finish_research` is asked once.
- **Helpers:** `investigate(parts[])` runs up to 5 helpers at once, each Haiku 5.5 with web search and fetch and up to 12 steps (`apps/brain/src/tasks/research.ts`). Each request makes at most 5 searches and 5 fetches of 10k-token pages, and clears old results from 40k. A helper ends with `report_findings`: claims, each with the exact quote it rests on, the page (an http(s) link) and its date. Its last step, or one its limit only just allows, forces `report_findings`, and a report cut off at `max_tokens` is asked for once more, with 10 findings. Helpers stop short of the room the lead's next request needs. The findings come back numbered by source, one page always under one number, with "Spent so far". A finding's link counts only when a helper's search or fetch returned that page. What the helpers read taints the task and shows on its timeline.
- **Links:** a helper's brief, a `run_desktop_task` title, goal or success criteria, and an `ask_bot` request may name only links the task got from outside (the question and events, search results, fetched pages, helpers' sources), matched exactly. Otherwise the call is refused, and the timeline says "Refused a brief". A bare host below a site's name ("dluga-5.stock-check.example") counts as a link; "x-kom.pl" and "www.x-kom.pl" don't.
- **Its own tools:** only memory list, read, search and write, `run_desktop_task`, `ask_bot` (for other bots' tools), `investigate`, `finish_research(outcome, answer, report, notify)` in place of `finish_task`, the web tools and the plugins' read tools. The lead's `web_fetch` reads 10k tokens of a page, and the prompt leaves reading pages to the helpers. The lead clears old tool results from 70k, at least 20k at a time, like other tasks, but never `investigate`'s.
- **Checking:** each quote is first confirmed against what its helper read (fetched pages, code output, search titles), decimal separators kept; an unconfirmed quote is marked and not given to the checker. A quote from a PDF or from code output Hatbot can't read is "unchecked": the check uses it, and the report's header names those sources. Then, before the report is final, Haiku compares every number cited as [n] with the quotes the helpers copied (`RESEARCH_CHECK_PROMPT`, structured output). Mismatches, and citations that aren't source numbers, go back once to be fixed or dropped. If the check can't run, the timeline, the report's header and the summary say the numbers weren't checked. A `failed` finish doesn't use up the check.
- **The report:** citations are renumbered in the order first cited and become links, `[[1]](url)`, everywhere but in code. The answer is the task's summary, which goes to the chat. The report gets a header (title, when, the question) and a Sources list. It's saved in the bot's notes as `research/<date>-<slug>.md` (`bots/<id>/research/…` for a bot other than Hatbot), never over another (`-2` to `-9`, then `-task-<id>`; Polish letters are made plain), attached to the task as a `.md` file, and kept as `tasks.report_path` (migration 31). It opens in the web's reader (`/read`): from the task page's Report link, which falls back to the attachment when the note is gone, from the `.md` chip in the chat, and from Read in Memory. The reader renders it like a reply, charts included, and never raw HTML or another site's pictures.
- **Charts:** the report can draw chart blocks of every kind: line and bar, and since 2026-10-18 scatter, range (low to high, with a mark), matrix (options against criteria, each column shaded worst to best) and timeline (`packages/shared/src/chart.ts`; the web and iOS draw them all). Under each chart a line cites its sources, like "Prices from [2, 4, 7].", and the number check reads the chart's values as cited by it.
- **Stopping short:** a run that fails, or is cancelled by anything but you (the step cap, a limit, a refusal, a model error, an unanswered raise, a brain restart), saves its last draft, or else every source with its claims and quotes, as an unfinished report.
- **Read back:** research reports and `research/sites.md`, read with `memory_read` or found by `memory_search`, are untrusted and taint the reader (§6.1).
- **Refreshing:** Run again on a research task, or `research` with `previous`, names the earlier report in the goal ("Earlier report to refresh: …"); a rerun keeps it and the bot that asked. The task reads that report first and leads with what changed.
- **Sites:** `research/sites.md` in the bot's notes says which sites were useful and which weren't, and for what. It's written from web pages, so it's a hint, not a list of sites to trust. The task reads it before searching and adds to it.
- **Second-hand prices:** with a buying bot such as Haggler, research asks it with `ask_bot`.
- **Not built:**
  - A page reader that runs JavaScript. It would fetch any URL the model names, and so could send out what the task has read. Pages that need a browser go to `run_desktop_task`, which asks before consequential steps.
  - Starting research from schedules.

## 18. Own code (built 2026-10-18, not tried live)
Hatbot can read its own code and propose changes to it as Forgejo pull requests, when the owner asks. It doesn't go looking for things to change on its own (§1). The **Own code** plugin (`apps/brain/src/plugins/self/`) needs the desktop, and `HATBOT_SELF_REPO` (owner/name) next to `FORGEJO_URL` and `FORGEJO_TOKEN` in `/etc/hatbot/forgejo.env`. The bot account needs write access to the repository, to push branches. It's off until switched on.

- **Why Forgejo:** the canonical repository is on Forgejo, which push-mirrors it to GitHub. A branch made only on GitHub would likely be pruned by the mirror. Forgejo has no CI runners, so the sandbox runs the tests instead.
- **`self_checkout`:** the brain keeps a bare clone in `/var/lib/hatbot/self/repo.git`, fetches the default branch, and copies `git archive` of it into the sandbox at `~/hatbot-self/work`, where it becomes a fresh git repository tagged `base` (its commit message is the commit it came from). Then `bun install --frozen-lockfile` runs there. The brain never runs the code.
- **`self_run`:** bash in that checkout, like `code_run`: reading, editing, `bun test`, `bun run check`, `bun run typecheck`. Its output is untrusted, like everything the sandbox prints, so the task is tainted.
- **`self_propose(branch, title, body)`:** the branch must start with `hatbot/`. The sandbox's `git diff --binary base` comes back to the brain, which applies it with `git apply --cached` to a temporary index on the checked-out commit, writes the tree and a commit as the bot account, and pushes it with no force. git applies the diff without running anything in it. The branch starts from the commit that was checked out, so a default branch that moved on meanwhile isn't undone; Forgejo shows any conflict. Symlinks and submodules are refused, and so is a diff over 5 MB. The pull request's body ends with where it came from and its size, and names any file under `infra/`, `.forgejo/`, `.github/`, `.gitea/` or `scripts/`, or any `package.json`, `bun.lock` or `bunfig.toml`, for the owner to read closely: once merged and updated, those run as root on the brain, run in CI, or bring in other code.
- **Approvals:** it's a forge write in a tainted task, so it needs approval: Haiku's review, or the owner. Hatbot never merges its own pull requests (the guidance says so, and `forgejo_merge` always asks). Deploying stays with the owner too: Update deploys only commits signed by `HATBOT_UPDATE_SIGNERS`, and the bot's commits aren't signed, so a change goes live only through the owner's signed merge.
- **How it's used:** the owner asks in the chat, and the chat starts a task (`run_task`, effort high). Tasks share the sandbox's one checkout, so run one at a time.
- **Not built:** updating a pull request after review comments (push to its branch again), and suggesting improvements on a schedule.
