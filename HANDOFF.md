# Handoff — what's left after M5

Written 2026-10-10. `PLAN.md` is the source of truth; this file says where things stand and what to build next.
Delete it, or fold it into `PLAN.md`, once the work below is done.

**Next: `GAPS.md`** (2026-10-16) is the plan for the next pass: small fixes and one deploy checklist, the owner's live run, then the larger fixes. Start there.

## Where things stand

- **Built:** M0–M5, the iOS app, more than one bot (§14) and looking after things (§15). M4 onwards is built and committed but not yet deployed or tried live.
- **Not yet tried live** (the owner does these): the M2 lock-screen approval, the M3 morning schedule, Forgejo webhook and Kuma alert, all of M4 and M5, and the first iOS install from SideStore.
- **Checks:** 328 tests (brain, desktop-agent and web) and 47 iOS core tests pass, and Biome and `tsc -b` are clean.

## How to work here

- **Run:** `export PATH=$HOME/.bun/bin:$PATH` (`bun` isn't on PATH). Then `bun test`, `bun run check` (Biome) and `bun run typecheck`, all three before every commit.
- **Commits:** one commit per finished piece, on `main`, in the style of the history ("Plugins: …", "MCP plugin: …"). Commit locally; push only when the owner asks. End commit messages with the `Co-Authored-By` line your harness gives you.
- **Stopping the dev brain:** use `fuser -k <port>/tcp`. `pkill -f "bun src/main.ts"` kills your own shell.
- **Forgejo** (`git.gaycats.ovh`) sometimes hangs or resets connections. Retry later; the GitHub mirror runs CI.
- **Code style:** match the surrounding code. Comments are sparse and explain *why*; user-facing text is plain, short English.
- **UI style:** no decorative clutter, meaning no status dots, subtext, kickers or meta chips.
- **Shared types:** they live in `packages/shared`. The iOS app mirrors the ones it uses in `apps/ios/Hatbot/Core/Models.swift`, so change both together. The iOS decoder tolerates unknown events and enum values.
- **Swift on Linux:** the toolchain is in `/opt/swift61` (reinstall it if it's gone; no Docker here). `swift test -Xswiftc -use-ld=lld --scratch-path /tmp/hbswiftbuild` in `apps/ios` tests `Hatbot/Core`; `swiftc -parse` checks the views' syntax. SwiftUI can't be type-checked on Linux; CI on the GitHub mirror builds the app.
- **Licences:** no copyleft dependencies (PLAN §2), not even MPL. That's why the live view is our own MJPEG stream and not noVNC (MPL).

## 1. Trust-tracking gaps (PLAN §6.1): decided 2026-10-10

These came out of the M4 security review.

1. **`memory_write` from a tainted chat or task:** left as it is, by the owner's choice. Memory, skills included, stays trusted on every read. If it ever needs closing, flagging tainted writes to `skills/` would cover most of the risk.
2. **Thread summaries** (Haiku, `agent/thread.ts`) don't carry taint. Left for now: the path from a summary to an unapproved change is long.
3. **SSH logs and files:** done. `ssh_check logs`/`errors` and `ssh_read_file` are untrusted and taint the task.

## 2. M5 — Teach-by-showing (built, not tried live)

- **Brain:** `apps/brain/src/teach/` (recorder, skills index, service) and `routes/teach.ts`. Live input is recorded from `routes/desktop.ts` while a recording runs; the recording holds the screen lane. The draft is one Opus call (`purpose: "teach"` in the ledger) and stays in `teach_sessions` until the owner saves it.
- **Secrets:** desktop-agent's `inspect()` now reports `secret` (password, one-time-code, card fields, frames). Typing there, or where nothing focused can be seen, is only counted. **desktop-agent needs redeploying** for the `secret` flag; an old agent still has `type === "password"` checked.
- **Use:** background tasks get a `<skills>` list; `run_desktop_task` takes `skill`, and the desktop model gets the file's steps in `<skill>`. Chat sees skills through INDEX.md's Skills section.
- **Decided:** no recording dot; a plain "Recording. Show Hatbot how." banner.
- **Not done:** the iOS app has no teach mode. Handing back from the app ends a recording without a skill.

## 3. iOS app — remaining items (PLAN §11, "iOS app")
- **Built, not yet compiled by CI:** the Memory tab (files, read and edit, history, diff, revert), Schedules & Triggers under Settings (schedules made and edited here; triggers edited, switched, re-keyed and deleted, but made on the web), and Settings → Notifications (web or app). SwiftUI can't be type-checked on Linux, so the first CI run on the GitHub mirror is the real check.
- **Optional:** Settings → Plugins and teach mode aren't in the app. The plan doesn't ask for them.

## Desktop shell (built 2026-10-10, not deployed)
- `desktop_shell` in desktop tasks runs commands through `hatbot-desktop-shell` (`apps/desktop-agent/src/shell.ts`), relayed by desktop-agent's `POST /exec`. The owner chose to add it for experiments.
- **Run `infra/deploy.sh` once** for the desktop: updates from the Settings button use the installed copy of `desktop-deploy.sh`, which doesn't know the new unit. Until then the tool answers that the shell isn't running.

## Commands in containers (built 2026-10-11, not set up)
- `ssh_pct_exec` in the SSH plugin, for hosts marked "Proxmox host". The owner runs `infra/pct-exec-setup.sh` on the Proxmox host, then adds it in Settings → Plugins → SSH. The wrapper's `pct exec` path is only tested on the real host.

## Web, homelab plugins, browser input (built 2026-10-12, not tried live)
- **Web search and fetch** are Anthropic's server tools, the basic versions (`WEB_TOOLS` in `apps/brain/src/agent/tools.ts`) on both models. The dynamic-filtering versions would save tokens on Opus but bring a code container into every conversation. What they read taints the conversation or task. Each search is billed at $0.01 in the spend ledger.
- **Plugins:** Proxmox Backup Server, Home Assistant and Uptime Kuma, tested only against stand-in servers. Their env files are in `infra/README.md`. Redeploy the brain once so its unit loads them.
- **Task tools:** `wait` gives up the slot and wakes early on an event; `notify_owner` sends at most 5 notifications per task.
- **Browser input** (`apps/desktop-agent/src/human.ts`): curved pointer paths, held clicks, a person's typing pace. Re-run `infra/desktop-provision.sh` for the extra fonts. Still a tell: WebGL renders in software (no GPU in the container). The container's timezone should match the owner's.
- **Captchas:** the desktop model clicks a plain checkbox once; image and puzzle challenges go to the owner.

## Attachments and code (built 2026-10-12, not tried live)
- **Both ways:** the owner uploads with `POST /attachments` and then posts the ids with the message. The model gets these directly: images up to 5 MB, PDFs up to 20 MB, and text up to 400 KB. Anything else is reached through `code_run`. Attached files taint the conversation. Hatbot sends files back with `send_file`, from the sandbox or from a desktop task's browser download (saved in desktop-agent's state dir). A task's files show on the messages that show the task. Files live in the archive under `files/` and are limited to 25 MB.
- **Code:** the Code plugin (`apps/brain/src/plugins/code/`) is off until it's switched on in Settings → Plugins. `code_run` runs as the desktop shell user and goes through the usual write gating. Commands that fetch from the network make it untrusted.
- **To set up:** re-run `infra/desktop-provision.sh` (Python, numpy, pandas, matplotlib, poppler, jq and more), redeploy desktop-agent (`/files` and `/download`), and redeploy the brain (migration 17).
- **Unchecked:** the web composer was never looked at in a browser. The iOS views were only syntax-checked.

## Chat commands (built 2026-10-13, not tried live)
- `/new`, `/stop [task]`, `/task <what>` and `/remember <fact>` run in the brain without the model (`Thread.post` in `apps/brain/src/agent/thread.ts`; the list is `CHAT_COMMANDS` in `packages/shared`, mirrored in `apps/ios/Hatbot/Core/Thread.swift`). An unknown `/word` is an ordinary message.
- `/new` starts a `fresh` episode (migration 18): no recent messages and no taint carried over, only the running summary. `/task` runs your words as an untainted background task. `/remember` appends to the Notes section of INDEX.md, as the owner. The model hears about commands in `<owner_commands>` with your next message.
- **To set up:** redeploy the brain (migration 18). The web composer was checked in headless Chromium; the iOS views were only syntax-checked.

## Incognito (built 2026-10-13, not tried live)
- The chat toolbar's incognito button (web and iOS) switches to a conversation apart from the thread. `incognito: true` on `POST /thread/messages`; `GET /thread/messages?incognito=1` lists it; `DELETE /thread/incognito` ends it. The owner chose these rules:
  - **No history:** no summary, no earlier messages, no `search_history`, no task news. It isn't summarized, unread or in the search index.
  - **Memory read-only, lookups only:** memory reads, schedule and trigger lists, plugins' read tools, web search, `ask_opus`. No writes, tasks or schedules; `/task` and `/remember` answer that they don't work there.
  - **Deleted** (messages, files, model turns) when you leave, after 30 idle minutes, on `/new`, or when the brain restarts. Spend stays in the ledger without it. `secure_delete` and a WAL checkpoint keep the text out of the database files; a PBS backup taken while one is open still has it.
- **To set up:** redeploy the brain (migration 19). The web view was checked in headless Chromium; the iOS views were only syntax-checked.

## More than one bot (built 2026-10-14, not tried live)
- PLAN §14, milestones B1–B5: bots with their own role, chat, memory folder (`bots/<id>/`), plugins, model and browser profile; `ask_bot` hand-offs, at most 3 deep; group chats of 2–6 bots, where `@name` picks who answers and at most 4 bot replies follow each message. Spend limits stay global. §14.5 says how it's built.
- **To set up:** redeploy the brain (migration 20 moves the thread into conversation 1, Hatbot's chat). **Run `infra/deploy.sh` once** for the desktop: it installs `hatbot-chromium.service`, which replaces the autostart Chromium, and the per-bot profiles need it. An update from the Settings button uses the old installer; until the full deploy, every bot shares the one browser profile.
- **Checked:** the web views in headless Chromium (chat list, bot and group pages, the schedule's "Runs as", @ autocomplete, sender names). The iOS views were only syntax-checked.
- **Not tried:** two bots answering in a group with the real model, and per-bot profiles on the real desktop.

## Copying files (built 2026-10-14, not tried live)
- `ssh_copy_file` in the SSH plugin copies any file up to 25 MB between hosts, containers on a Proxmox host (through `hatbot-pct-exec`), the desktop's sandbox, and the chat: the owner's attachments in, or out to the owner under the reply or on the task (`CallContext.sendFile`). Plugins get the sandbox and the chat's files as `PluginContext.files`.
- Writes on a host follow `ssh_write_file`'s rules; in a container, outside /root and /tmp asks. Only a write on a host counts against the chat's two changes. A host's file copied into the sandbox taints the conversation, as `ssh_read_file` does. In a tainted conversation, sending to the owner asks too, like every write.
- Bytes go over ssh's stdin and stdout, so nothing new is needed on hosts; the container path relies on `pct exec` passing stdin through, untested on the real host.

## Looking after things, GitHub, Siri and sharing (built 2026-10-15, not tried live)
The owner asked for all of these at once. PLAN §15 describes them.
- **Brain:** Check everything (Settings, `infra/smoke.sh`), watchers (`watch_*` in the chat), search, Run again, the heartbeat (off by default), the weekly report (on, Monday 09:00), memory tidy-ups and skill fixes as proposals (the weekly tidy-up is off by default), the GitHub plugin, and `POST /thread/ask` for Siri.
- **To set up:** redeploy the brain (migrations 24 and 25). **Redeploy desktop-agent:** watchers fetch pages through its new `/fetch`, and Check everything reads its new health fields. For GitHub, create `/etc/hatbot/github.env` with `GITHUB_TOKEN` (`infra/README.md`) and run `infra/brain-deploy.sh` once so the unit loads it.
- **Plugin signals** for the heartbeat: Uptime Kuma (monitors down) and PBS (failed tasks, full datastores). A plugin adds one with `signals()` on its instance.
- **GitHub:** a commit of many files is one commit through the git tree API (the contents API makes one per file). Tested only against a stand-in server.
- **iOS:** Search in the drawer; Watchers, Check everything and Heartbeat under Settings, with the weekly report and memory tidy-up switches; proposals and skills that went wrong in Memory; Run again on an ended task. App Intents (Ask Hatbot, Give Hatbot a Task, Send to Hatbot) and a share extension. The token moved into the App Group's Keychain access group on first launch, so the extension can read it; `build-ipa.sh` signs both ad hoc with their entitlements, since SideStore reads the App Group from them, and the SideStore source lists the entitlement. **Unchecked:** none of the iOS views, the intents or the extension have been compiled (only syntax-checked); the first CI run is the real check. If SideStore refuses the App Group, take `entitlements` and the extension out of `project.yml`; the app works without them.
- **Checked:** brain tests, `tsc -b`, Biome, the iOS core's 37 tests, and the web pages (Search, watchers, Check everything, Heartbeat, Settings, a proposal) in headless Chromium against a dev brain.

## The improvement pass (built 2026-10-15, not tried live)
An audit of every part, then fixes across all of them. The commits from "Desktop: the shell can't reach Chromium's DevTools…" onwards.
- **Desktop and infra:** the shell can't reach DevTools (nft `meta skuid` on the DynamicUser range), desktop-agent or the screen (Xvnc `-nolisten local`, unconfirmed on TigerVNC; `verify.sh` checks it). Timeouts on xdotool and ffmpeg, faster screenshots, a live view that sends only changed frames (5 fps unless you have control), coalesced input, `/fetch` checked at every redirect, `GET /health?deep=1`, `POST /browser/reset`, restart limits off, the database copied before a release switch and put back on rollback, the brain updated before the desktop, optional signed-commit updates (`HATBOT_UPDATE_SIGNERS`, `infra/README.md`), more blocked ranges and optional `HATBOT_PUBLIC_IPS`. CI builds the web app, runs shellcheck and the firewall test, and builds iOS on `packages/shared` changes.
- **Agent runtime:** no summary while a reply runs or waits; files kept by reference, not base64 in turns; a new episode past 90k tokens and tool results cleared past 70k in tasks; tasks cache their system prompt; `ask_opus`'s answer in Haiku's context; mid-stream retries; Try again on an errored reply; a background task gives its slot up while its desktop task runs; at most 3 s waiting for the last summary; page screening in parallel, once per page, asking when it fails; tasks stopped by a restart are told in their chats with one notification (not re-queued); effort changes keep the cache (beta `mid-conversation-output-config-2026-07-01`).
- **Brain services:** migration 26 (indexes, webhook deliveries seen, kept 30 days); takeover survives a restart; a deleted bot's watchers go to Hatbot; plugins in error restart on a backoff; the heartbeat keeps its last 20 finds; paging on tasks, approvals and memory history; storage sizes and growth in Check everything and the weekly report; a nightly `VACUUM INTO` copy in `<archive>/db/` (7 kept); memory writes that read first go through the write queue, edits on an older copy get a 409, search wants every word; hook bodies capped at 256 KB; spend by purpose; tidy-up and skill fixes answer 202 and arrive as `proposal.updated`.
- **Web:** streaming redraws once a frame; only a 401 signs you out; fast reconnects that merge the thread; drafts per chat; phone composer; the live view streams only when visible; Tasks lists what needs you and pages back; memory conflicts; lazy pages and no zod (636 → 440 kB); Inter split by script, Noto with Cyrillic and Greek; the duplicated CSS folded; scroll-to-bottom, Stop, Cmd-K; title and icon badge; drag and drop; a service worker for the app shell.
- **iOS:** reload after the background; per-request timeouts; a revoked token signs out; streaming, typing and Markdown performance; ImageIO photos (share extension memory); drafts per chat; search opens the message; landscape Live with pinch zoom; Spend charts, limits, devices, test approval; Try again; haptics; VoiceOver; iPad sidebar; an on-device cache; quick actions, Spotlight, icon badge. **Widget and Pause all control** are one commit ("iOS: a home-screen widget…"), a third App ID in SideStore: revert it alone if the build or SideStore refuses it. None of the SwiftUI was compiled here.
- **To set up:** redeploy the brain (migration 26). **Run `infra/deploy.sh` once from the host** for the desktop's unit changes (the Update button uses the old installer), re-run `host-setup.sh` for the new firewall ranges, then `verify.sh`. A new IPA from CI.

## 4. Later (not v1, don't start without the owner)
- **After v1** (PLAN §11): email via Proton Bridge, an open-source release.
- **Negotiation** (PLAN §16): planned 2026-10-16, not started. N1 first. Scout's part needs a handoff in Scout's own repo.

## Things the owner should know when testing M4
- **Kuma prompt:** existing Uptime Kuma triggers keep their old prompt. Re-save them with the new default (`KUMA_PROMPT` in `apps/web/src/pages/Schedules.tsx`) to get investigate → one restart → verify.
- **Plugin pages:** Settings → Plugins was never looked at in a browser, only checked through the API and typecheck.
- **Secrets:** they go in `/etc/hatbot/forgejo.env` and `/etc/hatbot/mcp.env`; `infra/brain-deploy.sh` wires them in.
