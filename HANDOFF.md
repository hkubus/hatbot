# Handoff — what's left after M5

Written 2026-10-10. `PLAN.md` is the source of truth; this file says where things stand and what to build next.
Delete it, or fold it into `PLAN.md`, once the work below is done.

**The gaps pass** (2026-10-16) is done, apart from the live run below, which is the owner's. Hatbot is MIT-licensed (`LICENSE`). Its larger fixes: code tasks check themselves through the repo's CI, desktop tasks start on Haiku and carry on on Opus, memory search ranks, a tainted chat's or task's writes to skills and INDEX.md wait as proposals, the last $1 of each limit is kept for alerts, watchers can run a page's scripts, and an install guide and a licence check in CI.

**The review fixes** (2026-10-17) are built and merged on `main`, not deployed, tried live or pushed. They change the deploy; see their section below.

## Deploy checklist

Everything built since M4 goes live with these steps, in this order: `host-setup.sh` runs the provision scripts, so it comes before `deploy.sh`. The Update button in Settings only updates the app; new desktop units and firewall rules need the host scripts.

1. **iOS build:** push `main`. The GitHub mirror's CI builds the iOS app for the first time, since no SwiftUI has been compiled yet; fix the compile errors from its log. If SideStore refuses the App Group, the widget's App ID or the share extension, see "iOS" below for what to take out.
2. **Host setup:** copy `infra/` to the host (`infra/README.md`, "Run it"). If your router forwards ports, set `HATBOT_PUBLIC_IPS` in `/etc/hatbot/host.env`. Run `./host-setup.sh` again: it loads the new firewall ranges, and its provision scripts bring the fonts, Python and the sandbox's tools, and make `/etc/hatbot/mcp.env` root:hatbot, mode 640, which the MCP plugin now needs.
3. **Deploy:** `NTFY_URL=<your ntfy server> HATBOT_GIT_URL=<repository> ./deploy.sh 124:/root/hatbot`. The two variables make it ask again for what it otherwise keeps: ntfy (take the random topic it suggests, and a token) and the repository, now with the SSH public key you sign commits with (it sets `HATBOT_UPDATE_SIGNERS`). It runs the brain's migrations up to 37, reinstalls `hatbot-update.sh`, and installs the brain and desktop-agent together, which must match (they share the key lists). desktop-agent's archive now carries `packages/shared` (in its `node_modules`), where it reads those lists; an Update run by the `hatbot-update.sh` installed before that would send desktop-agent without it, and the desktop would keep its old version. It installs the desktop's units: `hatbot-chromium` (a browser profile per bot), the shell, the renderer (`hatbot-render`, for watchers that run a page's scripts), `/fetch` and `/files`; the shell and renderer now get their own IPC namespace. Use `deploy.sh`, not Update, for this one.
4. **ntfy:** subscribe the phone's ntfy app to the new topic, and on the ntfy server let only your user read it (`auth-default-access: deny-all` or `write-only`, plus an access rule for your user).
5. **Env files:** one for each plugin you want (`github.env`, `forgejo.env`, `pbs.env`, `homeassistant.env`, `uptimekuma.env`, `mcp.env`; `infra/README.md`, "Plugins"), and `HATBOT_PING_URL` in `secrets.env` with its Uptime Kuma Push monitor ("When the brain itself is down"). Then restart the brain.
6. **Optional:** `./pct-exec-setup.sh` on the host (again, if you ran it before: it now tags the brain and desktop `hatbot` and installs a wrapper that refuses tagged containers), then add the host in Settings → Plugins → SSH with "Proxmox host" on.
7. **Checks:** `./verify.sh` (it checks that the renderer runs as a user the loopback rule covers, renders a page, that only desktop-agent's user reaches the shell's and the renderer's sockets, and that neither can reach the screen grabs' shared memory), then Settings → Check everything (or `infra/smoke.sh`). A guessable ntfy topic now fails it; it warns without a signing key or without desktop-agent's `gates`. Then a test approval, approved from the lock screen: it has Approve, Deny and Pause all.
8. **Kuma triggers:** re-save existing Uptime Kuma triggers with the new default prompt (`KUMA_PROMPT` in `apps/web/src/pages/Schedules.tsx`) to get investigate → one restart → verify.
9. **iOS install:** install the IPA from the SideStore source. The bundle prefix is now one setting (`BUNDLE_PREFIX` in `apps/ios/project.yml`, `com.example` there); the iOS workflow keeps `ovh.gaycats` unless the repository variable `BUNDLE_PREFIX` says otherwise, so the installed app stays the same app. Sign in with the brain's **https** address: the app no longer takes `http`, on the LAN either, and an address saved as `http` shows the sign-in screen.
10. **Settings:** a setting saved by an earlier version keeps its value, so look at these. The heartbeat is on by default now (Settings → Heartbeat). Desktop tasks now start on Haiku 5.5 and carry on on Opus when Haiku fails; an install that saved any setting since 2026-10-10 keeps Opus for the desktop (Settings → Desktop). The last $1 of the daily and monthly limits is now kept for alerts (Settings → Spending limits → Kept for alerts), and a research task has its own $5 (Per research task).
11. **MCP:** pick every MCP tool's mode again in Settings → Plugins → MCP. Chat and Allow are now pinned to the tool's definition, and the ones saved before have no pin, so they ask until you pick them again. Accept an untrusted server's tool descriptions there, or they taint every chat; pins saved before 2026-10-18 were a shorter hash, so even a tool you picked or accepted since then asks once more. Scout's read tools must be set to Chat again, or negotiations fail.
12. **Negotiation**, once you have a marketplace account: the steps under "Negotiation, N1 and N2" below.

## The live run

Acceptance tests for parts that have never run live. The owner runs them; write each result here: passed, or what broke and the commit that fixed it.

1. **Forgejo alert:** a Kuma monitor on `git.gaycats.ovh` that notifies Hatbot's Kuma trigger; stop Forgejo. Passes when Hatbot reads the service over SSH, restarts it once, checks it's back, and reports in chat and on ntfy. *Not run yet.*
2. **netlog chart:** add the host that runs `/root/netlog` (CT 124) as an SSH host. Ask Hatbot to copy `loss.csv` and chart the last 7 days' loss for each target. Passes when the chart arrives as a file. Then make it a Monday schedule. *Not run yet.*
3. **CI watcher:** a watcher on `github_ci` for `hkubus/hatbot` `main`, condition "contains failure". Passes when a failing run sends a notification. *Not run yet.*
4. **OVH invoice:** teach it once on the desktop, save the skill, then run it as a task. Passes when the PDF arrives through `send_file`. Note which model drove it and whether it needed a takeover. *Not run yet.*
5. **Share sheet:** share a Safari link with "summarize". Passes when the summary appears in chat. *Not run yet.*
6. **Also try:** a desktop task that needs a login (takeover both ways), two bots in a group, an incognito chat, `/task` and `/remember`, and Run again on an ended task. *Not run yet.*
7. **Negotiation:** with Haggler logged in to OLX, ask it to haggle for a cheap listing you'd actually buy. It passes when:
   - the mandate card arrives;
   - approving it sends the opening message on its own;
   - the message shows in OLX's conversation, and on the negotiation's page with no note under it (an unconfirmed send says the message box didn't clear);
   - when the seller holds out above the limit, an answer from Haggler that goes past it asks you instead of sending (item 9).

   Until N3, Haggler reads replies only when asked: "check the seller's reply". *Not run yet.*
8. **Payment, in the app only:** a desktop task that goes as far as a shop's checkout for something cheap. It passes when the payment step asks, its notification offers only Open in Hatbot and Deny, and Deny in the app stops the task. *Not run yet.*
9. **Over the mandate:** in item 7's negotiation, ask Haggler to offer more than the ceiling, then to agree without naming a price. It passes when each message is held, asks in the app as a purchase (no Approve on the notification), and nothing reaches the seller until you approve. *Not run yet.*
10. **Home Assistant unlock:** with the Home Assistant plugin on, ask Hatbot to unlock a lock, or open a gate you listed under "Always ask before changing these entities". It passes when it asks with no Haiku review, the notification has no Approve, and approving in the app does it. *Not run yet.*
11. **ntfy and Pause all:** after the deploy, Check everything's ntfy line passes and a test approval reaches the phone on the new topic. Pause all on that notification pauses Hatbot; Resume in the app. *Not run yet.*
12. **Signed update:** with `HATBOT_UPDATE_SIGNERS` set, Update deploys a signed commit and refuses an unsigned one, saying why in Settings. *Not run yet.*
13. **iOS over https:** the app signs in with the https address, and Ask Hatbot from Siri on a locked phone asks you to unlock first. *Not run yet.*

## Where things stand

- **Built:** M0–M5, the iOS app, more than one bot (§14), looking after things (§15), negotiation's N1 and N2 (§16), research (§17), and the review fixes. M4 onwards is built and committed but not yet deployed or tried live.
- **Not yet tried live** (the owner does these): the M2 lock-screen approval, the M3 morning schedule, Forgejo webhook and Kuma alert, all of M4 and M5, the first iOS install from SideStore, and everything from the gaps pass and the review fixes. The renderer and the desktop gates' frame following were tried only with Chromium here, not Debian's on the desktop.
- **Checks:** 368 tests (brain, desktop-agent, web and shared; 8 of them drive Chromium and run only with `HATBOT_CHROMIUM_TESTS=1`) pass in about 5 s, 36 iOS core tests pass, Biome and `tsc -b` are clean (2026-10-18).

## How to work here

- **Run:** `export PATH=$HOME/.bun/bin:$PATH` (`bun` isn't on PATH). Then `bun test`, `bun run check` (Biome) and `bun run typecheck`, all three before every commit. The Update test's jq stand-in runs on `bun`, so it fails without that PATH where jq isn't installed.
- **Tests:** one test per rule (allow and refuse) and per real past bug, plus one end-to-end test per feature; no tests of wording, mappers or constants. No sleeps: advance `testApp()`'s clock, await what a tick returns, or `waitFor` a condition. `testApp()` hashes passwords at argon2id's lowest cost (`AuthService`'s third argument); the brain itself never passes one.
- **Chromium tests:** desktop-agent's tests that drive a real Chromium (cdp, inspect, render) take seconds, so `bun test` skips them. Run `HATBOT_CHROMIUM_TESTS=1 bun test ./apps/desktop-agent` before shipping desktop-agent changes (`HATBOT_CHROMIUM` picks the binary).
- **Commits:** one commit per finished piece, on `main`, in the style of the history ("Plugins: …", "MCP plugin: …"). Commit locally; push only when the owner asks. End commit messages with the `Co-Authored-By` line your harness gives you.
- **Stopping the dev brain:** use `fuser -k <port>/tcp`. `pkill -f "bun src/main.ts"` kills your own shell.
- **Forgejo** (`git.gaycats.ovh`) sometimes hangs or resets connections. Retry later; the GitHub mirror runs CI.
- **Code style:** match the surrounding code. Comments are sparse and explain *why*; user-facing text is plain, short English.
- **UI style:** no decorative clutter, meaning no status dots, subtext, kickers or meta chips.
- **Shared types:** they live in `packages/shared`. The iOS app mirrors the ones it uses in `apps/ios/Hatbot/Core/Models.swift`, so change both together. The iOS decoder tolerates unknown events and enum values. desktop-agent ships with `packages/shared` but without zod, so it imports values only from `@hatbot/shared/bot-id`, `/keys` and `/desktop`, never the package entry.
- **Swift on Linux:** the Swift 6.1 toolchain is in `~/.local/swift61` (reinstall it if it's gone; no Docker here). Use its wrapper, `~/.local/swift61/bin/swift` (and `swiftc`): it adds `~/.local/swift61/compat` to `LD_LIBRARY_PATH` for the ncurses and libxml2 sonames Arch lacks. `~/.local/swift61/bin/swift test -Xswiftc -use-ld=lld --scratch-path /tmp/hbswiftbuild` in `apps/ios` tests `Hatbot/Core`; `~/.local/swift61/bin/swiftc -parse` checks the views' syntax. SwiftUI can't be type-checked on Linux; CI on the GitHub mirror builds the app.
- **Licences:** no copyleft dependencies (PLAN §2), not even MPL. That's why the live view is our own MJPEG stream and not noVNC (MPL). `bun run licenses` (`scripts/licenses.ts`, in CI) lists every installed package's licence and fails on anything not permissive. Its one exception is lightningcss (MPL-2.0), which Vite itself depends on to minify CSS at build time; none of it is in the build.

## 1. Trust-tracking gaps (PLAN §6.1): decided 2026-10-10

These came out of the M4 security review.

1. **`memory_write` from a tainted chat or task:** closed 2026-10-16, with the owner's agreement. Writes and deletes to skills and the `INDEX.md` files become `write` proposals (PLAN §6.1); other memory files still commit directly.
2. **Thread summaries:** closed 2026-10-17. If a summarized conversation read untrusted content, every new conversation in that chat starts tainted, `/new` included, until those conversations are deleted (PLAN §6.1). So in a chat that has used the web, later writes go through Haiku's review, and edits to skills, INDEX.md and homelab.md become proposals.
3. **SSH logs and files:** done. `ssh_check logs`/`errors` and `ssh_read_file` are untrusted and taint the task.

## 2. M5 — Teach-by-showing (built, not tried live)

- **Brain:** `apps/brain/src/teach/` (recorder, skills index, service) and `routes/teach.ts`. Live input is recorded from `routes/desktop.ts` while a recording runs; the recording holds the screen lane. The draft is one Opus call (`purpose: "teach"` in the ledger) and stays in `teach_sessions` until the owner saves it.
- **Secrets:** desktop-agent's `inspect()` reports `secret` (password, one-time-code, card fields, frames). Typing there, or where nothing focused can be seen, is only counted. An older desktop-agent only checks `type === "password"`.
- **Use:** background tasks get a `<skills>` list; `run_desktop_task` takes `skill`, and the desktop model gets the file's steps in `<skill>`. Chat sees skills through INDEX.md's Skills section.
- **Decided:** no recording dot; a plain "Recording. Show Hatbot how." banner.
- **Not done:** the iOS app has no teach mode. Handing back from the app ends a recording without a skill.
- **Screenshots** (2026-10-17): none is kept while a secret field holds something, while a payment frame shows, or for the rest of the recording once typing on a page turned out hidden; they're deleted when the recording is discarded or its skill saved. This uses desktop-agent's new `secretShown` and `pageFocus`; with an older desktop-agent, Teach falls back to the typing rules.

## 3. iOS
- **https only** (2026-10-17): the app, widget, intents and share extension refuse an `http` address. A LAN-only brain needs a certificate the iPhone trusts (Caddy's internal CA as a profile with full trust, or `tailscale cert`). Siri, Shortcuts and the Pause Hatbot control ask you to unlock first.
- **Built, not yet compiled by CI:** everything in SwiftUI, including the Memory tab, Schedules & Triggers under Settings (triggers are made on the web), Settings → Notifications, App Intents, the share extension, the widget and the Pause all control. SwiftUI can't be type-checked on Linux, so the first CI run on the GitHub mirror is the real check.
- **If SideStore refuses them:** the App Group, `entitlements` and the share extension come out of `project.yml` (the app works without them). The widget and Pause all control are one commit ("iOS: a home-screen widget…"), a third App ID: revert it alone.
- **Optional:** Settings → Plugins and teach mode aren't in the app. The plan doesn't ask for them.

## Desktop shell (built 2026-10-10)
- `desktop_shell` in desktop tasks runs commands through `hatbot-desktop-shell` (`apps/desktop-agent/src/shell.ts`), relayed by desktop-agent's `POST /exec`. The owner chose to add it for experiments. Until `deploy.sh` installs the unit, the tool answers that the shell isn't running.

## Commands in containers (built 2026-10-11)
- `ssh_pct_exec` in the SSH plugin, for hosts marked "Proxmox host" (checklist step 5). The wrapper's `pct exec` path is only tested on the real host.

## Web, homelab plugins, browser input (built 2026-10-12, not tried live)
- **Web search and fetch** are Anthropic's server tools, `webTools()` in `apps/brain/src/agent/tools.ts`. Since 2026-10-17 they're the dynamic-filtering versions (`web_search_20260318`, `web_fetch_20260318`) on both models and in chat and tasks. The model calls them directly or from code that keeps only what matters. That code runs in Anthropic's container, which is free with these tools, has no network, and shares nothing with `code_run`. Calls made from code come back without their results (`response_inclusion: "excluded"`). So `webCalls()` reads the queries and URLs out of the code, for taint and the timeline. A paused reply or task carries on in the same container. A task holds its inbox events while code is still running, because then only tool results may follow. The chat's pages can be cited. A reply keeps the pages it cites (`addSources()`, `messages.sources`, migration 31), and the web and iOS list them as links under it. Searches carry the brain's time zone as the owner's rough location. `HATBOT_WEB_TOOLS=basic` goes back to `web_search_20250305` and `web_fetch_20250910`. Not tried live yet. What they read taints the conversation or task. Each search is billed at $0.01 in the spend ledger.
- **Plugins:** Proxmox Backup Server, Home Assistant and Uptime Kuma, tested only against stand-in servers.
- **Task tools:** `wait` gives up the slot and wakes early on an event; `notify_owner` sends at most 5 notifications per task.
- **Browser input** (`apps/desktop-agent/src/human.ts`): curved pointer paths, held clicks, a person's typing pace. Still a tell: WebGL renders in software (no GPU in the container). The container's timezone should match the owner's.
- **Captchas:** the desktop model clicks a plain checkbox once; image and puzzle challenges go to the owner.

## Attachments and code (built 2026-10-12, not tried live)
- **Both ways:** the owner uploads with `POST /attachments` and then posts the ids with the message. The model gets these directly: images up to 5 MB, PDFs up to 20 MB, and text up to 400 KB. Anything else is reached through `code_run`. Since 2026-10-17 a conversation sends at most 20 MB of files inline, oldest first; later ones are named for `code_run`, and a PDF over about 15 MB never goes inline. They're still sent again with every request. Migration 34 gives attachment ids that are never reused, so new ones jump by 1000 (#1043, say). Attached files taint the conversation. Hatbot sends files back with `send_file`, from the sandbox or from a desktop task's browser download (saved in desktop-agent's state dir). A task's files show on the messages that show the task. Files live in the archive under `files/` and are limited to 25 MB.
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
- **Deleting a bot** (2026-10-17): its chat goes away and takes no new messages, and its schedules, triggers and watchers go to Hatbot switched off, for you to turn back on.
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
- **Brain services:** migration 26 (indexes, webhook deliveries seen, kept 30 days); takeover survives a restart; a deleted bot's watchers go to Hatbot (switched off since 2026-10-17); plugins in error restart on a backoff; the heartbeat keeps its last 20 finds; paging on tasks, approvals and memory history; storage sizes and growth in Check everything and the weekly report; a nightly `VACUUM INTO` copy in `<archive>/db/` (7 kept); memory writes that read first go through the write queue, edits on an older copy get a 409, search wants every word; hook bodies capped at 256 KB; spend by purpose; tidy-up and skill fixes answer 202 and arrive as `proposal.updated`.
- **Web:** streaming redraws once a frame; only a 401 signs you out; fast reconnects that merge the thread; drafts per chat; phone composer; the live view streams only when visible; Tasks lists what needs you and pages back; memory conflicts; lazy pages and no zod (636 → 440 kB); Inter split by script, Noto with Cyrillic and Greek; the duplicated CSS folded; scroll-to-bottom, Stop, Cmd-K; title and icon badge; drag and drop; a service worker for the app shell.
- **iOS:** reload after the background; per-request timeouts; a revoked token signs out; streaming, typing and Markdown performance; ImageIO photos (share extension memory); drafts per chat; search opens the message; landscape Live with pinch zoom; Spend charts, limits, devices, test approval; Try again; haptics; VoiceOver; iPad sidebar; an on-device cache; quick actions, Spotlight, icon badge.

## The network pass (built 2026-10-16, not tried live)
The owner asked for performance work, mostly on the network, with each change measured. The commits from "Brain: compressed JSON answers…" onwards.
- **Brain:** JSON answers of 1 KB or more go out compressed (`compress.ts`: brotli 5, else gzip). A 50-message chat page goes from 71 to 25 kB. The web app's files go out as the `.br` and `.gz` copies the Vite build writes, with ETags and 304s; a first load is 0.7 MB instead of 1.1 MB. The event stream joins streamed text for up to 50 ms and is compressed (permessage-deflate) where the client offers it: browsers do; URLSession, as far as I know, doesn't. One reply went from 361 frames and 24.7 kB to 184 frames and 7.7 kB. `GET /tasks?ids=` lists just those tasks. A live viewer that fell behind gets the newest frame once it catches up; before, a still desktop could leave it on an old one.
- **Web:** one live socket per tab, however many screens show it. A chat's task cards load in one request without their steps: a chat with 12 cards makes 9 requests instead of 20. A reconnect loads the chats and ended tasks once. Spend refreshes at most every 10 s while a task bills (46 requests a minute instead of 192).
- **iOS:** a reconnect loads everything side by side (0.17 s instead of 1.2 s at 150 ms a request); seen messages go in one post; task rows load in one request, one by one from a brain without `ids=`.
- **For the owner to decide:** desktop tasks send every screenshot again, as base64, with each step: a 30-screenshot task uploads about 56 MB in all. The Files API would upload each once and refer to it by id. It costs a round trip per screenshot and keeps screenshots at Anthropic until they're deleted.

## Negotiation, N1 and N2 (built 2026-10-16, not tried live)
PLAN §16: Haggler haggles with a seller inside a mandate you approve. §16.7 says how it's built; Haggler is a template on New bot (§14.6). Nothing could be tried live without a marketplace account; it's tested against a stand-in desktop-agent and a stand-in Scout.
- **Built:**
  - **Records:** migration 27 (wants, negotiations, their messages).
  - **Tools:** the negotiate tools (`apps/brain/src/negotiate/`). The appraisal falls back to `scout_watch_analytics` until Scout has `scout_price_reference` and `scout_comparables`.
  - **The mandate approval:** a note on it changes the numbers.
  - **`negotiate_send`:** its policy is checked in code, with pace limits and quiet hours.
  - **Claims:** what Haggler has told each seller is kept.
  - **The exact-text gate:** the Send click goes through only with the approved text, in the negotiation's conversation, once.
  - **Web:** the line under the reply, the negotiation's page (with Stop), open negotiations on Tasks, and mandates among what needs you.
  - **Since the review fixes** (2026-10-17): the mandate check fails closed, so more messages ask than before (an emoji, a bare "Ok, biorę", "Czy mogę odebrać osobiście?" under an OLX-delivery mandate); money past the mandate asks in the app; mandates run out at their expiry; a seller's message that looks like a scam holds the negotiation until you decide; inside the mandate a message goes without asking again. PLAN §16.7 has it all.
- **Not built:** N3 onwards: inbox polling, follow-ups, several sellers and the declines, and selling. The scam check on the messages a read records is built; the inbox polling it was planned with isn't. Also the playbook skill from N1, which needs the account. Scout's part (§16.4) is for Scout's own repo; the shapes the brain reads are in §16.7.
- **To do, in order:**
  1. **Deploy** (checklist step 3). It runs migration 27 and installs a desktop-agent whose inspect reports the tab's address and the text in its text boxes. With an older desktop-agent, nothing is sent.
  2. **Scout:** Settings → Plugins → MCP. Add Scout as an HTTP server at `http://<scout>:3001/mcp`, with `Authorization: Bearer ${SCOUT_TOKEN}` and `SCOUT_TOKEN` (one of Scout's `SCOUT_API_TOKENS`) in `mcp.env`.
     - Accept Scout's tool descriptions there, unless you mark the server trusted.
     - Set these to **Chat** ("Chat, no asking"): `scout_search`, `scout_listings`, `scout_listing_detail` and `scout_watch_analytics`, plus `scout_price_reference` and `scout_comparables` once they exist.
     - Set `scout_record_outcome` to **Allow** once it exists, if Scout should learn final prices.
     - Scout limits `/mcp` to 30 requests a minute.
  3. **Haggler:** New bot, Template → Haggler, Create. It fills in the instructions and the MCP plugin as its only plugin. A Haggler made before 2026-10-17 keeps its old instructions: paste in the new `HAGGLER` text from `packages/shared/src/templates.ts`.
     - Any bot with Scout gets the negotiate tools. Hatbot too, if it has the MCP plugin.
     - The MCP plugin is allowed as a whole, so Haggler also gets any other MCP server you've added.
  4. **Account:** log in to the marketplace in Haggler's own browser profile. Ask Haggler to open olx.pl and take over when it asks you to log in.
  5. **Time zone:** quiet hours (22:00–08:00) go by the brain's clock. Check that the brain's container is on your time zone.
  6. **Delivery terms:** when you approve a mandate, state its delivery terms plainly, with exclusions in a clause of their own: "Wysyłka OLX, odbiór osobisty. Bez przedpłaty.", not "Wysyłka OLX bez dopłat", which reads as not allowing shipping. For shipping on top of the limit, say how much ("up to 20 zł on top").
  7. **The live run:** items 7 and 9 above.
- **Fixed on the way:** a restart used to cancel every pending approval, so a redeploy would have abandoned each negotiation waiting for its mandate. Mandates now outlast a restart.

## Research (built 2026-10-17, not tried live)
- **Reader and charts** (2026-10-18): reports open rendered in the web at `/read?path=…` (or `?file=<attachment id>`). Chart blocks gained scatter, range, matrix and timeline, in chat and tasks too. iOS draws them, but its SwiftUI is unchecked until CI; if the build fails there, the likely spots are the timeline's `.annotation(…, alignment:)` and the scatter's `chartXAxisLabel`/`chartYAxisLabel` overloads in `ChartView.swift`. iOS has no report reader.
PLAN §17: `research` in the chat starts a research task. Opus 5.5 at high effort plans it and hands parts to up to 5 Haiku 5.5 helpers at once (`investigate`). Each helper reports claims with the quotes they rest on. Haiku checks the cited numbers against those quotes before the report is final. The answer goes to the chat with numbered source links. The report is saved in the bot's notes under `research/` and attached to the task, and the task page links it. Run again, or `previous`, refreshes a report and says what changed. The Researcher template asks scoping questions first, uses `research`, asks Haggler for second-hand prices and keeps `research/sites.md`. Tested with a stand-in model only.
- **Not built:** a page reader that runs JavaScript. It could fetch any URL the model names, and so send out what the task has read; pages that need a browser go to `run_desktop_task`. Also research from schedules.
- **To try:** ask the Researcher (or Hatbot) something worth comparing, e.g. a quiet four-bay NAS under 3,000 zł. It passes when it asks what it needs to know, the task's timeline shows the helpers' searches, the answer arrives with numbered links, and the report opens in the reader from the task page and from the chat's `.md` chip, with at least one chart whose values the number check covered. Note what it cost: about $2–5 is expected, and its limit starts at $5. The helpers' forced `report_findings` call on Haiku 5.5 with adaptive thinking hasn't been tried against the real API yet. If a request is turned away, `HATBOT_WEB_TOOLS=basic` in the brain's `/etc/hatbot/secrets.env`, and a restart, puts the basic web tools back while you look.

## The review fixes (built 2026-10-17, not tried live)
A code review (about 240 findings and nits, kept outside the repo) was fixed in 17 groups, checked adversarially, and the gaps it found were fixed on 5 more branches and a finishing pass: about 350 commits after `ed5df58`, all merged on `main`. Nothing is deployed, tried live or pushed. PLAN has the design as it now stands.
- **What changed:**
  - **Desktop gates** (PLAN §6.1): only named keys; Enter held off the page, in the address bar or another window; popups, frames and payment frames; search boxes and clickable divs read as what they are; checkout and payment pages ask for every click; Polish and Czech labels. An approval covers one held step, on its page.
  - **Approvals** (§6.2): purchase, payment, account security, the new `access` kind (Home Assistant locks, the alarm, covers, gates and what can reach them), mandates, budget raises and injection warnings are approved only in the app. Every approval notification has Pause all.
  - **Negotiation** (§16.7): the mandate check fails closed; money past the mandate asks in the app; mandates run out; a scam check holds a negotiation; Stop on its page.
  - **Taint and screening** (§6.1): more taints (a Kuma alert's message, most SSH output, `code_run`, forks and other branches, Home Assistant's text, research notes, running summaries, notes in the chat); Haiku screens the chat and background tasks too; a suspicion lasts into the next conversation and turns Haiku's review off; automation changes after untrusted content ask.
  - **Sign-in** (§4.1): change the password or authenticator, sign out other browsers, a limit per browser, `infra/reset-login.sh`.
  - **ntfy** (§9.4): no default topic, a token recommended, Check everything says who can read it.
  - **MCP** (§4.5): Always ask, tool kinds, modes pinned to the tool's definition, descriptions to accept, schemas checked with ajv.
  - **Spending** (§6.3): a request holds the most it could cost; a task's limit covers the tasks it started; research has its own $5.
  - **Also:** watchers' limits and back-off, triggers (Kuma "down again", 24 tasks a day, replays by signature), the heartbeat, research's limits and checks, deleting a bot, iOS (https only, intents need unlock), and much of the web UI.
- **To deploy** (the checklist above has these steps):
  1. **Migrations** 32–37 run on deploy. Migration 34 rebuilds the attachments table, so new attachment ids jump by 1000. Migration 37 records on each episode whether it read untrusted content or was suspected, and fills that in for old episodes.
  2. **`bun install`** in a checkout: `ajv` is a new dependency of the brain. Deploy installs it on the brain itself.
  3. **`deploy.sh` on the host**, not Update: `hatbot-update.sh`, `desktop-deploy.sh` and the desktop units changed. The brain and desktop-agent go together, since they share the key lists; an older desktop-agent has no `gates`.
  4. **ntfy:** run `deploy.sh` with `NTFY_URL` set to get a random topic, give it a token, subscribe the phone to the new topic, and let only your ntfy user read it. A guessable topic (`hatbot`, the old default) fails Check everything.
  5. **MCP:** pick every tool's mode again in Settings → Plugins → MCP, and set Scout's tools to Chat again, or negotiations fail.
  6. **Signed updates:** run `deploy.sh` with `HATBOT_GIT_URL` set and give it your commit-signing key; it sets `HATBOT_UPDATE_SIGNERS`. Without one, Update deploys any commit on the branch, and Check everything warns.
  7. **iOS:** enter the brain's address again as https.
  8. **Haggler:** state the delivery terms plainly, with exclusions in a clause of their own (step 6 under "Negotiation, N1 and N2").
  9. **Sign-ins:** changing the password or authenticator signs out every other browser and API token, so the iOS app and any scripts sign in again.
- **Left on purpose:**
  - stdio MCP servers still run as the `hatbot` user, which can read `/etc/hatbot/*.env`. Running each as its own user needs a root-side launcher, since the brain's unit has `NoNewPrivileges=yes`.
  - Attachments are still sent inline with every request, up to 20 MB, not through the Files API: deleted and incognito conversations would need their remote files deleted too, and that can't be checked without live calls.
  - No cache mark on the app's system-note turns: the docs don't say system messages take `cache_control`.
  - No Chromium policy (`URLBlocklist` for `javascript:`) in `desktop-deploy.sh`; the brain refuses typed script addresses instead.
  - Outside negotiations, Enter in a custom element with a closed shadow root isn't held; only Teach treats it as secret.
  - The mandate check works from word lists, so it still can't catch an acceptance in words it doesn't know while naming our own price inside the mandate, new plain words for paying off the platform, or trades ("300 zł i moją starą kartę"). It holds an IBAN written like a phone number as a phone number.
  - desktop-agent keeps its own list of payment hosts for Teach's card-frame check, apart from the brain's.
  - The try-again note and the chart-fix note stay user turns, opening "(No message from the owner: …)": the API takes a system message only after a user turn.
  - SwiftUI still hasn't been compiled. Every Swift file passes `swiftc -parse` and the core's 36 tests pass, but the first Xcode build in CI is the iOS app's real check.
  - The web app's room for the phone keyboard hasn't been tried on a real iPhone or Android phone.

## The cleanup pass (built 2026-10-18, not tried live)
A second review of everything since `ed5df58` was fixed, then the code and tests were cut down: from `52a55af`, source went from about 66,800 lines to 63,600 and tests from about 28,400 lines (1,586 tests, ~55 s) to 15,700 (368 tests, ~5 s). `prototype/` is gone. All merged on `main`; nothing deployed or pushed.
- **What behaves differently:**
  - **Desktop:** an approval asked before a step covers that one step, and only if the step is what was approved. A desktop request that times out answers 504, and Check everything says it timed out rather than that the desktop isn't running. Cancelling a task also stops its `code_run` and its copies to and from the sandbox.
  - **Sign-in:** signing out other browsers, changing the password or authenticator, and `reset-login` each rotate the device key. A proxy that forwards addresses without being in `HATBOT_TRUSTED_PROXIES` is warned about.
  - **Update** refuses a branch that moved back or was rewritten.
  - **MCP** pins are the definition's full hash (see the checklist's MCP step).
  - **GitHub/Forgejo:** `open_pr` refuses a head from another repository (`owner:branch`).
  - **Research** strips `gbraid`, `wbraid` and `_ga` from links too, and what its helpers read is screened like everything else.
  - **Negotiation:** the mandate note is a structured JSON answer, not a forced tool call.
  - **API:** an owner's mistake (no such bot, bad schedule, …) answers 400 from every route where some gave 500; a missing memory file answers 404 (the web takes both); webhooks refuse with "Wrong or missing signature." or "Wrong or missing secret."; 401 and 403 say plainly why. `/triggers` with no id opens Schedules.
  - Check everything's model call fails if Haiku stops at its 16-token cap instead of answering.
- **Deploy:** `deploy.sh`, not Update (step 3 of the checklist): desktop-agent now ships with `packages/shared` in its `node_modules`, and the `hatbot-update.sh` already installed doesn't put it there.
- **iOS:** the views changed in this pass (the shared `attempt` helper, the delete confirmation, `SpendView`'s limit field) were only parse-checked; the first Xcode build is their real check.
- **Tests now cover less, on purpose:** one test per rule (allow and refuse) and per real past bug. No longer tested: JSON compression of answers, message batching, memory search ranking and its fallback, which conversation a negotiation's messages belong to, a queued send already sent or unconfirmed, the address-bar screenshot wait, the watcher pattern timeout, and `ssh_exec`'s timeout (it can't be set under a second).

## 4. Later (not v1, don't start without the owner)
- **After v1** (PLAN §11): email via Proton Bridge.
- **Negotiation** (PLAN §16): N1 and N2 are built (above). N3 onwards wait for the owner, and Scout's part needs a handoff in Scout's own repo.

## Things the owner should know when testing M4
- **Plugin pages:** Settings → Plugins was never looked at in a browser, only checked through the API and typecheck.
