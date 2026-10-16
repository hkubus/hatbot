# Handoff — what's left after M5

Written 2026-10-10. `PLAN.md` is the source of truth; this file says where things stand and what to build next.
Delete it, or fold it into `PLAN.md`, once the work below is done.

**The gaps pass** (2026-10-16) is done, apart from the live run below, which is the owner's, and the licence, which the owner picks: MIT or Apache-2.0 (PLAN §11). Its larger fixes: code tasks check themselves through the repo's CI, desktop tasks start on Haiku and carry on on Opus, memory search ranks, a tainted chat's or task's writes to skills and INDEX.md wait as proposals, the last $1 of each limit is kept for alerts, watchers can run a page's scripts, and an install guide and a licence check in CI.

## Deploy checklist

Everything built since M4 goes live with these steps, in this order: `host-setup.sh` runs the provision scripts, so it comes before `deploy.sh`. The Update button in Settings only updates the app; new desktop units and firewall rules need the host scripts.

1. **iOS build:** push `main`. The GitHub mirror's CI builds the iOS app for the first time, since no SwiftUI has been compiled yet; fix the compile errors from its log. If SideStore refuses the App Group, the widget's App ID or the share extension, see "iOS" below for what to take out.
2. **Host setup:** copy `infra/` to the host (`infra/README.md`, "Run it"). If your router forwards ports, set `HATBOT_PUBLIC_IPS` in `/etc/hatbot/host.env`. Run `./host-setup.sh` again: it loads the new firewall ranges, and its provision scripts bring the fonts, Python and the sandbox's tools.
3. **Deploy:** `./deploy.sh 124:/root/hatbot`. It runs the brain's migrations up to the latest and installs the desktop's units: `hatbot-chromium` (a browser profile per bot), the shell, the renderer (`hatbot-render`, for watchers that run a page's scripts), `/fetch` and `/files`.
4. **Env files:** one for each plugin you want (`github.env`, `forgejo.env`, `pbs.env`, `homeassistant.env`, `uptimekuma.env`, `mcp.env`; `infra/README.md`, "Plugins"), and `HATBOT_PING_URL` in `secrets.env` with its Uptime Kuma Push monitor ("When the brain itself is down"). Then restart the brain.
5. **Optional:** `./pct-exec-setup.sh` on the host, then add the host in Settings → Plugins → SSH with "Proxmox host" on.
6. **Checks:** `./verify.sh` (it now checks that the renderer runs as a user the loopback rule covers, renders a page, and that only desktop-agent's user reaches the shell's and the renderer's sockets), then Settings → Check everything (or `infra/smoke.sh`), then a test approval, approved from the lock screen.
7. **Kuma triggers:** re-save existing Uptime Kuma triggers with the new default prompt (`KUMA_PROMPT` in `apps/web/src/pages/Schedules.tsx`) to get investigate → one restart → verify.
8. **iOS install:** install the IPA from the SideStore source. The bundle prefix is now one setting (`BUNDLE_PREFIX` in `apps/ios/project.yml`, `com.example` there); the iOS workflow keeps `ovh.gaycats` unless the repository variable `BUNDLE_PREFIX` says otherwise, so the installed app stays the same app.
9. **Settings:** a setting saved by an earlier version keeps its value, so look at these. The heartbeat is on by default now (Settings → Heartbeat). Desktop tasks now start on Haiku 5.5 and carry on on Opus when Haiku fails; an install that saved any setting since 2026-10-10 keeps Opus for the desktop (Settings → Desktop). The last $1 of the daily and monthly limits is now kept for alerts (Settings → Spending limits → Kept for alerts).

## The live run

Acceptance tests for parts that have never run live. The owner runs them; write each result here: passed, or what broke and the commit that fixed it.

1. **Forgejo alert:** a Kuma monitor on `git.gaycats.ovh` that notifies Hatbot's Kuma trigger; stop Forgejo. Passes when Hatbot reads the service over SSH, restarts it once, checks it's back, and reports in chat and on ntfy. *Not run yet.*
2. **netlog chart:** add the host that runs `/root/netlog` (CT 124) as an SSH host. Ask Hatbot to copy `loss.csv` and chart the last 7 days' loss for each target. Passes when the chart arrives as a file. Then make it a Monday schedule. *Not run yet.*
3. **CI watcher:** a watcher on `github_ci` for `hkubus/hatbot` `main`, condition "contains failure". Passes when a failing run sends a notification. *Not run yet.*
4. **OVH invoice:** teach it once on the desktop, save the skill, then run it as a task. Passes when the PDF arrives through `send_file`. Note which model drove it and whether it needed a takeover. *Not run yet.*
5. **Share sheet:** share a Safari link with "summarize". Passes when the summary appears in chat. *Not run yet.*
6. **Also try:** a desktop task that needs a login (takeover both ways), two bots in a group, an incognito chat, `/task` and `/remember`, and Run again on an ended task. *Not run yet.*

## Where things stand

- **Built:** M0–M5, the iOS app, more than one bot (§14) and looking after things (§15). M4 onwards is built and committed but not yet deployed or tried live.
- **Not yet tried live** (the owner does these): the M2 lock-screen approval, the M3 morning schedule, Forgejo webhook and Kuma alert, all of M4 and M5, the first iOS install from SideStore, and everything from the gaps pass. The renderer was tried only with Playwright's Chromium here, not Debian's on the desktop.
- **Checks:** 444 tests (brain, desktop-agent and web) and 52 iOS core tests pass, Biome and `tsc -b` are clean, and `bun run licenses` passes.

## How to work here

- **Run:** `export PATH=$HOME/.bun/bin:$PATH` (`bun` isn't on PATH). Then `bun test`, `bun run check` (Biome) and `bun run typecheck`, all three before every commit.
- **Commits:** one commit per finished piece, on `main`, in the style of the history ("Plugins: …", "MCP plugin: …"). Commit locally; push only when the owner asks. End commit messages with the `Co-Authored-By` line your harness gives you.
- **Stopping the dev brain:** use `fuser -k <port>/tcp`. `pkill -f "bun src/main.ts"` kills your own shell.
- **Forgejo** (`git.gaycats.ovh`) sometimes hangs or resets connections. Retry later; the GitHub mirror runs CI.
- **Code style:** match the surrounding code. Comments are sparse and explain *why*; user-facing text is plain, short English.
- **UI style:** no decorative clutter, meaning no status dots, subtext, kickers or meta chips.
- **Shared types:** they live in `packages/shared`. The iOS app mirrors the ones it uses in `apps/ios/Hatbot/Core/Models.swift`, so change both together. The iOS decoder tolerates unknown events and enum values.
- **Swift on Linux:** the toolchain is in `/opt/swift61` (reinstall it if it's gone; no Docker here). `swift test -Xswiftc -use-ld=lld --scratch-path /tmp/hbswiftbuild` in `apps/ios` tests `Hatbot/Core`; `swiftc -parse` checks the views' syntax. SwiftUI can't be type-checked on Linux; CI on the GitHub mirror builds the app.
- **Licences:** no copyleft dependencies (PLAN §2), not even MPL. That's why the live view is our own MJPEG stream and not noVNC (MPL). `bun run licenses` (`scripts/licenses.ts`, in CI) lists every installed package's licence and fails on anything not permissive. Its one exception is lightningcss (MPL-2.0), which Vite itself depends on to minify CSS at build time; none of it is in the build.

## 1. Trust-tracking gaps (PLAN §6.1): decided 2026-10-10

These came out of the M4 security review.

1. **`memory_write` from a tainted chat or task:** closed 2026-10-16, with the owner's agreement. Writes and deletes to skills and the `INDEX.md` files become `write` proposals (PLAN §6.1); other memory files still commit directly.
2. **Thread summaries** (Haiku, `agent/thread.ts`) don't carry taint. Left for now: the path from a summary to an unapproved change is long.
3. **SSH logs and files:** done. `ssh_check logs`/`errors` and `ssh_read_file` are untrusted and taint the task.

## 2. M5 — Teach-by-showing (built, not tried live)

- **Brain:** `apps/brain/src/teach/` (recorder, skills index, service) and `routes/teach.ts`. Live input is recorded from `routes/desktop.ts` while a recording runs; the recording holds the screen lane. The draft is one Opus call (`purpose: "teach"` in the ledger) and stays in `teach_sessions` until the owner saves it.
- **Secrets:** desktop-agent's `inspect()` reports `secret` (password, one-time-code, card fields, frames). Typing there, or where nothing focused can be seen, is only counted. An older desktop-agent only checks `type === "password"`.
- **Use:** background tasks get a `<skills>` list; `run_desktop_task` takes `skill`, and the desktop model gets the file's steps in `<skill>`. Chat sees skills through INDEX.md's Skills section.
- **Decided:** no recording dot; a plain "Recording. Show Hatbot how." banner.
- **Not done:** the iOS app has no teach mode. Handing back from the app ends a recording without a skill.

## 3. iOS
- **Built, not yet compiled by CI:** everything in SwiftUI, including the Memory tab, Schedules & Triggers under Settings (triggers are made on the web), Settings → Notifications, App Intents, the share extension, the widget and the Pause all control. SwiftUI can't be type-checked on Linux, so the first CI run on the GitHub mirror is the real check.
- **If SideStore refuses them:** the App Group, `entitlements` and the share extension come out of `project.yml` (the app works without them). The widget and Pause all control are one commit ("iOS: a home-screen widget…"), a third App ID: revert it alone.
- **Optional:** Settings → Plugins and teach mode aren't in the app. The plan doesn't ask for them.

## Desktop shell (built 2026-10-10)
- `desktop_shell` in desktop tasks runs commands through `hatbot-desktop-shell` (`apps/desktop-agent/src/shell.ts`), relayed by desktop-agent's `POST /exec`. The owner chose to add it for experiments. Until `deploy.sh` installs the unit, the tool answers that the shell isn't running.

## Commands in containers (built 2026-10-11)
- `ssh_pct_exec` in the SSH plugin, for hosts marked "Proxmox host" (checklist step 5). The wrapper's `pct exec` path is only tested on the real host.

## Web, homelab plugins, browser input (built 2026-10-12, not tried live)
- **Web search and fetch** are Anthropic's server tools, the basic versions (`WEB_TOOLS` in `apps/brain/src/agent/tools.ts`) on both models. The dynamic-filtering versions would save tokens on Opus but bring a code container into every conversation. What they read taints the conversation or task. Each search is billed at $0.01 in the spend ledger.
- **Plugins:** Proxmox Backup Server, Home Assistant and Uptime Kuma, tested only against stand-in servers.
- **Task tools:** `wait` gives up the slot and wakes early on an event; `notify_owner` sends at most 5 notifications per task.
- **Browser input** (`apps/desktop-agent/src/human.ts`): curved pointer paths, held clicks, a person's typing pace. Still a tell: WebGL renders in software (no GPU in the container). The container's timezone should match the owner's.
- **Captchas:** the desktop model clicks a plain checkbox once; image and puzzle challenges go to the owner.

## Attachments and code (built 2026-10-12, not tried live)
- **Both ways:** the owner uploads with `POST /attachments` and then posts the ids with the message. The model gets these directly: images up to 5 MB, PDFs up to 20 MB, and text up to 400 KB. Anything else is reached through `code_run`. Attached files taint the conversation. Hatbot sends files back with `send_file`, from the sandbox or from a desktop task's browser download (saved in desktop-agent's state dir). A task's files show on the messages that show the task. Files live in the archive under `files/` and are limited to 25 MB.
- **Code:** the Code plugin (`apps/brain/src/plugins/code/`) is off until it's switched on in Settings → Plugins. `code_run` runs as the desktop shell user and goes through the usual write gating. Commands that fetch from the network make it untrusted.
- **Unchecked:** the web composer was never looked at in a browser.

## Chat commands (built 2026-10-13, not tried live)
- `/new`, `/stop [task]`, `/task <what>` and `/remember <fact>` run in the brain without the model (`Thread.post` in `apps/brain/src/agent/thread.ts`; the list is `CHAT_COMMANDS` in `packages/shared`, mirrored in `apps/ios/Hatbot/Core/Thread.swift`). An unknown `/word` is an ordinary message.
- `/new` starts a `fresh` episode (migration 18): no recent messages and no taint carried over, only the running summary. `/task` runs your words as an untainted background task. `/remember` appends to the Notes section of INDEX.md, as the owner. The model hears about commands in `<owner_commands>` with your next message.

## Incognito (built 2026-10-13, not tried live)
- The chat toolbar's incognito button (web and iOS) switches to a conversation apart from the thread. `incognito: true` on `POST /thread/messages`; `GET /thread/messages?incognito=1` lists it; `DELETE /thread/incognito` ends it. The owner chose these rules:
  - **No history:** no summary, no earlier messages, no `search_history`, no task news. It isn't summarized, unread or in the search index.
  - **Memory read-only, lookups only:** memory reads, schedule and trigger lists, plugins' read tools, web search, `ask_opus`. No writes, tasks or schedules; `/task` and `/remember` answer that they don't work there.
  - **Deleted** (messages, files, model turns) when you leave, after 30 idle minutes, on `/new`, or when the brain restarts. Spend stays in the ledger without it. `secure_delete` and a WAL checkpoint keep the text out of the database files; a PBS backup taken while one is open still has it.

## More than one bot (built 2026-10-14, not tried live)
- PLAN §14, milestones B1–B5: bots with their own role, chat, memory folder (`bots/<id>/`), plugins, model and browser profile; `ask_bot` hand-offs, at most 3 deep; group chats of 2–6 bots, where `@name` picks who answers and at most 4 bot replies follow each message. Spend limits stay global. §14.5 says how it's built.
- Migration 20 moves the thread into conversation 1, Hatbot's chat. Until `deploy.sh` installs `hatbot-chromium.service`, every bot shares one browser profile.
- **Not tried:** two bots answering in a group with the real model, and per-bot profiles on the real desktop.

## Copying files (built 2026-10-14, not tried live)
- `ssh_copy_file` in the SSH plugin copies any file up to 25 MB between hosts, containers on a Proxmox host (through `hatbot-pct-exec`), the desktop's sandbox, and the chat: the owner's attachments in, or out to the owner under the reply or on the task (`CallContext.sendFile`). Plugins get the sandbox and the chat's files as `PluginContext.files`.
- Writes on a host follow `ssh_write_file`'s rules; in a container, outside /root and /tmp asks. Only a write on a host counts against the chat's two changes. A host's file copied into the sandbox taints the conversation, as `ssh_read_file` does. In a tainted conversation, sending to the owner asks too, like every write.
- Bytes go over ssh's stdin and stdout, so nothing new is needed on hosts; the container path relies on `pct exec` passing stdin through, untested on the real host.

## Looking after things, GitHub, Siri and sharing (built 2026-10-15, not tried live)
The owner asked for all of these at once. PLAN §15 describes them.
- **Brain:** Check everything (Settings, `infra/smoke.sh`), watchers (`watch_*` in the chat), search, Run again, the heartbeat (on by default since 2026-10-16), the weekly report (on, Monday 09:00), memory tidy-ups and skill fixes as proposals (the weekly tidy-up is off by default), the GitHub plugin, and `POST /thread/ask` for Siri.
- **Plugin signals** for the heartbeat: Uptime Kuma (monitors down) and PBS (failed tasks, full datastores). A plugin adds one with `signals()` on its instance.
- **GitHub:** a commit of many files is one commit through the git tree API (the contents API makes one per file). Tested only against a stand-in server.
- **iOS:** Search in the drawer; Watchers, Check everything and Heartbeat under Settings, with the weekly report and memory tidy-up switches; proposals and skills that went wrong in Memory; Run again on an ended task. App Intents (Ask Hatbot, Give Hatbot a Task, Send to Hatbot) and a share extension. The token moved into the App Group's Keychain access group on first launch, so the extension can read it; `build-ipa.sh` signs both ad hoc with their entitlements, since SideStore reads the App Group from them, and the SideStore source lists the entitlement.
- **Checked:** brain tests, `tsc -b`, Biome, the iOS core's 37 tests, and the web pages (Search, watchers, Check everything, Heartbeat, Settings, a proposal) in headless Chromium against a dev brain.

## The improvement pass (built 2026-10-15, not tried live)
An audit of every part, then fixes across all of them. The commits from "Desktop: the shell can't reach Chromium's DevTools…" onwards.
- **Desktop and infra:** the shell can't reach DevTools (nft `meta skuid` on the DynamicUser range), desktop-agent or the screen (Xvnc `-nolisten local`, unconfirmed on TigerVNC; `verify.sh` checks it). Timeouts on xdotool and ffmpeg, faster screenshots, a live view that sends only changed frames (5 fps unless you have control), coalesced input, `/fetch` checked at every redirect, `GET /health?deep=1`, `POST /browser/reset`, restart limits off, the database copied before a release switch and put back on rollback, the brain updated before the desktop, optional signed-commit updates (`HATBOT_UPDATE_SIGNERS`, `infra/README.md`), more blocked ranges and optional `HATBOT_PUBLIC_IPS`. CI builds the web app, runs shellcheck and the firewall test, and builds iOS on `packages/shared` changes.
- **Agent runtime:** no summary while a reply runs or waits; files kept by reference, not base64 in turns; a new episode past 90k tokens and tool results cleared past 70k in tasks; tasks cache their system prompt; `ask_opus`'s answer in Haiku's context; mid-stream retries; Try again on an errored reply; a background task gives its slot up while its desktop task runs; at most 3 s waiting for the last summary; page screening in parallel, once per page, asking when it fails; tasks stopped by a restart are told in their chats with one notification (not re-queued); effort changes keep the cache (beta `mid-conversation-output-config-2026-07-01`).
- **Brain services:** migration 26 (indexes, webhook deliveries seen, kept 30 days); takeover survives a restart; a deleted bot's watchers go to Hatbot; plugins in error restart on a backoff; the heartbeat keeps its last 20 finds; paging on tasks, approvals and memory history; storage sizes and growth in Check everything and the weekly report; a nightly `VACUUM INTO` copy in `<archive>/db/` (7 kept); memory writes that read first go through the write queue, edits on an older copy get a 409, search wants every word; hook bodies capped at 256 KB; spend by purpose; tidy-up and skill fixes answer 202 and arrive as `proposal.updated`.
- **Web:** streaming redraws once a frame; only a 401 signs you out; fast reconnects that merge the thread; drafts per chat; phone composer; the live view streams only when visible; Tasks lists what needs you and pages back; memory conflicts; lazy pages and no zod (636 → 440 kB); Inter split by script, Noto with Cyrillic and Greek; the duplicated CSS folded; scroll-to-bottom, Stop, Cmd-K; title and icon badge; drag and drop; a service worker for the app shell.
- **iOS:** reload after the background; per-request timeouts; a revoked token signs out; streaming, typing and Markdown performance; ImageIO photos (share extension memory); drafts per chat; search opens the message; landscape Live with pinch zoom; Spend charts, limits, devices, test approval; Try again; haptics; VoiceOver; iPad sidebar; an on-device cache; quick actions, Spotlight, icon badge.

## The network pass (built 2026-10-16, not tried live)
The owner asked for performance work, mostly on the network, with each change measured. The commits from "Brain: compressed JSON answers…" onwards.
- **Brain:** JSON answers of 1 KB or more go out compressed (`compress.ts`: brotli 5, else gzip). A 50-message chat page goes from 71 to 25 kB. The web app's files go out as the `.br` and `.gz` copies the Vite build writes, with ETags and 304s; a first load is 0.7 MB instead of 1.1 MB. The event stream joins streamed text for up to 50 ms and is compressed (permessage-deflate) where the client offers it: browsers do; URLSession, as far as I know, doesn't. One reply went from 361 frames and 24.7 kB to 184 frames and 7.7 kB. `GET /tasks?ids=` lists just those tasks. A live viewer that fell behind gets the newest frame once it catches up; before, a still desktop could leave it on an old one.
- **Web:** one live socket per tab, however many screens show it. A chat's task cards load in one request without their steps: a chat with 12 cards makes 9 requests instead of 20. A reconnect loads the chats and ended tasks once. Spend refreshes at most every 10 s while a task bills (46 requests a minute instead of 192).
- **iOS:** a reconnect loads everything side by side (0.17 s instead of 1.2 s at 150 ms a request); seen messages go in one post; task rows load in one request, one by one from a brain without `ids=`.
- **For the owner to decide:** desktop tasks send every screenshot again, as base64, with each step: a 30-screenshot task uploads about 56 MB in all. The Files API would upload each once and refer to it by id. It costs a round trip per screenshot and keeps screenshots at Anthropic until they're deleted.

## 4. Later (not v1, don't start without the owner)
- **After v1** (PLAN §11): email via Proton Bridge, an open-source release.
- **Negotiation** (PLAN §16): planned 2026-10-16, not started. N1 first. Scout's part needs a handoff in Scout's own repo.

## Things the owner should know when testing M4
- **Plugin pages:** Settings → Plugins was never looked at in a browser, only checked through the API and typecheck.
