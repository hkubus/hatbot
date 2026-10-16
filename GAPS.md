# Gaps — the next pass

Written 2026-10-16 from a review of what Hatbot lacks. The owner agreed to fix everything here. `PLAN.md` is still the source of truth, and `HANDOFF.md` says where things stand. Read its "How to work here" first: run tests, Biome and `tsc -b` before every commit, make one commit per piece on `main`, and don't push. Delete this file once it's done, after folding anything still true into `PLAN.md`.

Paths are relative to the repo root, and line numbers are as of commit `ec8179b`.

## Out of scope (the owner's call)
- **Messengers** (Signal, Telegram, Matrix). Being reachable only through Hatbot's own web and iOS app is fine. Don't propose them.
- **Email and calendar.** They stay under "After v1" (PLAN §11).

## Order
1. **Part A:** small fixes and the deploy checklist. Do these now.
2. **Part B:** the owner deploys and runs the acceptance tests. Fix whatever breaks.
3. **Part C:** the larger fixes, in the order given. Start them when the owner says the live run is done, or tells you to go ahead anyway. No other new features until then.

---

## Part A — now

### A1. `code_run` says it reaches the LAN
`apps/brain/src/plugins/code/index.ts:26` says the sandbox "reaches the internet and the LAN". It doesn't: the desktop's firewall drops every private range (PLAN §6.4). The model will try LAN work there and waste turns. Change it to "It reaches the internet but not your LAN, and can't see the browser or the screen."

### A2. A dead-man ping
Nothing tells the owner when the brain itself is down. Check everything and the heartbeat both run inside it.
- **The ping:** read `HATBOT_PING_URL` from `/etc/hatbot/secrets.env`, which the unit already loads (`infra/brain-deploy.sh:58`). Every 60 s, send a GET to it from the 10 s loop in `apps/brain/src/main.ts:175-183`. Send `status=up&msg=OK` when a trivial database query works, and `status=down&msg=<error>` when it doesn't. Keep pinging while paused, because a paused brain is still alive. A failed ping is logged and never thrown.
- **Why a URL:** Uptime Kuma's Push monitor takes exactly this, and so does any other dead-man service. The URL is a secret, because anyone holding it can fake "up".
- **Check everything:** add a check (`apps/brain/src/checks.ts:141-166`) with the last ping's time and result. Skip it when no URL is set.
- **Docs:** in `infra/README.md`, add how to make a Kuma Push monitor (60 s interval, 2 retries) whose notification goes straight to ntfy. It mustn't go through Hatbot, because Hatbot is what's down.
- **Tests:** the ping fires and reports down on a database error, against a stand-in server.

### A3. Heartbeat on by default
Set `DEFAULT_SETTINGS.heartbeat.enabled` to `true` (`apps/brain/src/settings.ts:52-54`). It only calls Haiku when something new turns up. Find out whether saved settings keep the old `false` on an existing install. If they do, say so in HANDOFF so the owner switches it on.

### A4. PLAN drift
Fix where PLAN no longer matches the code:
- **The status line** (`PLAN.md:10`) still says "M5 is next".
- **§1 "v1 is not"** lists more than one agent and a proactive heartbeat, and both are built (§14, §15).
- **§6.3** describes a `waiting_budget` state that doesn't exist. In the code, a task over its own limit asks for approval (`apps/brain/src/tasks/agent-run.ts:332-341`, `desktop-run.ts:703-711`). A daily or monthly limit fails the task at once (`agent-run.ts:528`, `desktop-run.ts:702`).

### A5. One deploy checklist
HANDOFF's "To set up" notes are spread across a dozen sections. Replace them with one ordered list at the top of `HANDOFF.md`, keeping the per-feature notes short. The order matters: `host-setup.sh` runs the provision scripts, so it goes before `deploy.sh`.
1. **iOS build:** the owner pushes `main`. The GitHub mirror's CI builds the iOS app for the first time, since no SwiftUI has been compiled yet. Fix the compile errors from the CI log. If SideStore refuses the App Group, the widget's App ID or the share extension, HANDOFF says what to take out.
2. **Host setup:** on the host, copy `infra/` over (`infra/README.md`, "Run it"). Set `HATBOT_PUBLIC_IPS` in `/etc/hatbot/host.env` if the router forwards ports. Run `./host-setup.sh` again: it brings the new firewall ranges, and the provision scripts bring fonts, Python and the sandbox tools.
3. **Deploy:** run `./deploy.sh 124:/root/hatbot`. It runs brain migrations up to the latest and installs the desktop units: `hatbot-chromium`, the shell, `/fetch`, `/files`, and browser profiles.
4. **Env files:** create one for each plugin the owner wants (`github.env`, `forgejo.env`, `pbs.env`, `homeassistant.env`, `uptimekuma.env`, `mcp.env`; see `infra/README.md`, "Plugins"), plus `HATBOT_PING_URL` from A2. Then restart the brain.
5. **Optional:** run `./pct-exec-setup.sh`, then add the host in Settings → Plugins → SSH with "Proxmox host" on.
6. **Checks:** run `./verify.sh`, then Settings → Check everything (or `infra/smoke.sh`), then a test approval from the lock screen.
7. **Kuma triggers:** re-save existing Uptime Kuma triggers with the new default prompt (`KUMA_PROMPT` in `apps/web/src/pages/Schedules.tsx`).
8. **iOS install:** install the IPA from the SideStore source.

---

## Part B — the live run (the owner, with you fixing)

These double as acceptance tests for parts that have never run live. Write each result in HANDOFF: passed, or what broke and the commit that fixed it.

1. **Forgejo alert:** add a Kuma monitor on `git.gaycats.ovh` that notifies Hatbot's Kuma trigger, and stop Forgejo. Passes when Hatbot reads the service over SSH, restarts it once, checks it's back, and reports in chat and on ntfy.
2. **netlog chart:** add the host that runs `/root/netlog` (CT 124) as an SSH host. Ask Hatbot to copy `loss.csv` and chart the last 7 days' loss for each target. Passes when the chart arrives as a file. Then make it a Monday schedule.
3. **CI watcher:** ask for a watcher on `github_ci` for `hkubus/hatbot` `main`, condition "contains failure". Passes when a failing run sends a notification.
4. **OVH invoice:** teach it once on the desktop, save the skill, then run it as a task. Passes when the PDF arrives through `send_file`. Note which model drove it and whether it needed a takeover.
5. **Share sheet:** share a Safari link with "summarize". Passes when the summary appears in chat.
6. **Also try:** a desktop task that needs a login (takeover both ways), two bots in a group, an incognito chat, `/task` and `/remember`, and Run again on an ended task.

---

## Part C — the larger fixes

### C1. Code work checks itself through CI
Code tasks can't verify their changes. `github_ci` returns only each check's name, result, title and link, with no ids and no logs (`apps/brain/src/plugins/github/index.ts:295-338`). The sandbox has Python and Bun but no Rust or Swift, and only 1.5 GiB shared with Chromium. Use the repo's own CI as the build machine instead of adding toolchains.
- **Ids from `github_ci`:** add each check run's `id` to its output. For GitHub Actions, the check run id is the job id; confirm this in GitHub's docs.
- **New read tool `github_ci_log(repo, job_id)`:** `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` answers with a redirect to a short-lived URL. Return the part around the first `##[error]`, or the end of the log, capped at about 20 KB. Mark it **untrusted**, because a pull request can print anything into a log. The token already has "actions read" (`infra/README.md`, Plugins). Use the existing `api()` helper (`:60-98`), which returns text for a non-JSON accept.
- **The loop**, written into the plugin's `guidance` (`:519`):
  1. Commit to a branch, never the default branch. A branch commit doesn't ask on its own. After the task has read a log it's tainted, so later pushes go through Haiku's review (PLAN §6.1), which passes a fix to the work at hand.
  2. Alternate `github_ci` and `wait` until the run ends.
  3. On a failure, read the log, fix, and push again. Stop after 3 rounds.
  4. Open the PR with the CI result in its body.
  5. A repo with no CI says so and proceeds without it.
- **Forgejo:** it has no runners, so leave `forgejo_ci` alone.
- **Tests:** in `apps/brain/test/github-plugin.test.ts`, add a jobs-log route with a redirect to the stand-in server. The tool returns the trimmed failure, marked untrusted. `github_ci` lists ids.

### C2. Desktop: Haiku first, Opus when Haiku fails
Haiku desktop tasks are cheap but fail more (72% on OSWorld). Opus is reliable but costs more. Today there's no fallback: the model is fixed on the task row when it's created (`apps/brain/src/tasks/service.ts:308-309`).
- **Default:** set `desktopModel` to `claude-haiku-5-5` (`apps/brain/src/settings.ts:50`). As in A3, check what an existing install keeps.
- **Escalation:** add a setting, on by default, next to the desktop model. Web: `apps/web/src/pages/Settings.tsx:346`. iOS: `SettingsView.swift:92-94` and `AppStore.swift:910`. Add the shared type, mirrored in `apps/ios/Hatbot/Core/Models.swift`.
  - **When:** a Haiku desktop task ends `failed` because it hit `MAX_STEPS` or the 30-minute cap (`apps/brain/src/tasks/desktop-run.ts:30-31, 693-697`), was refused, was cut off, or finished as failed on its own.
  - **What happens:** it runs once more on Opus. Extend `rerun` (`service.ts:507-534`) with a model override; it already keeps origin, bot, payload and taint. Give Opus Haiku's summary of what it tried.
  - **No escalation for:** budget stops, cancellations, takeovers that timed out, or a "Blocked: …" ending about a login or captcha (`desktop-run.ts:827-829`), because Opus can't solve those either.
  - **The chat:** the escalation shows in the same task card, or as a linked one.
- **Numbers:** in the weekly report (`apps/brain/src/report.ts:88-159`), add one line per desktop model: done, failed, and escalated-then-done. Query `lane = 'screen'` without the `parent_id IS NULL` filter (`:98-104`), so desktop tasks started by background tasks count too.
- **PLAN:** update §5.4.
- **Tests:** on a Haiku task's step-cap failure, an Opus rerun starts. Cancellations, budget stops and blocked endings don't escalate. The report line comes out right.

### C3. Memory search that ranks
`MemoryStore.search` (`apps/brain/src/memory/store.ts:222`) is a `git grep --all-match`. Every word must appear, with no stemming and no ranking, so "what runs scout" misses a note that says "Scout runs on CT 130". Its callers are `memory_search` (`apps/brain/src/agent/tools.ts:253-257`) and global search (`apps/brain/src/search.ts:66`). Both expect `SearchHit {path, line, text}`; keep that shape so neither UI changes.
- **Migration 27:** a plain FTS5 table, `memory_fts(path UNINDEXED, line UNINDEXED, text, tokenize='porter unicode61')`. Fill it with one row per markdown section (split on headings), using the section's first line number.
- **Keeping it current:** rebuild at startup, which also covers hand edits made outside Hatbot. On every `memory.committed` event, reindex the files changed in that commit (`git diff --name-only <sha>^ <sha>`; the event carries only `sha`). Copy `Skills.watch()` (`apps/brain/src/teach/skills.ts:57-61`, wired at `apps/brain/src/main.ts:47-48`).
- **Query:** OR the words, rank with `bm25()`, use `snippet()` for the text, and prefix-match the last word as `ftsQuery()` does (`apps/brain/src/search.ts:10-14`). Fall back to the old grep if the FTS query fails.
- **Not now:** meaning-based search. There's no embedding API from Anthropic, and a local model on a host without a GPU isn't worth it at this size.
- **Tests:** in `memory.test.ts` and `search.test.ts`: stemming, a partial match ranked below a full one, and a reindex after write, delete, revert and a proposal apply.

### C4. Tainted writes to what every context reads become proposals
This reverses HANDOFF §1.1. The owner agreed on 2026-10-16. Today a tainted chat or task can write `skills/` or an `INDEX.md`, and that text is trusted on every later read. This is a way for an injection to persist.
- **Scope:** `memory_write` and `memory_delete` (`apps/brain/src/agent/tools.ts:224-248`) on `skills/**`, the root `INDEX.md` and `bots/*/INDEX.md`, while the chat episode or task is tainted. Other files still commit directly. Owner writes, `/remember` and teach-by-showing are unchanged.
- **Plumbing for tasks:** the chat already passes `tainted` (`apps/brain/src/agent/thread.ts:1800`). Tasks don't: add `tainted` to `toolContext` (`apps/brain/src/tasks/service.ts:585-597`), reading the task's `taintedBy`, which is kept current at `apps/brain/src/tasks/agent-run.ts:175-180`.
- **The proposal:** a new kind, `write`. Proposals have a CHECK constraint, so this needs a table-rebuild migration (`apps/brain/src/db/migrations.ts:483`, the `REBUILD` marker at `:2`).
  - Add the kind to the shared type (`packages/shared/src/index.ts:467`) and handle it on iOS (`apps/ios/Hatbot/Core/Looking.swift:110-113`, `Views/LookingViews.swift:539`, `Views/MemoryView.swift:138`) and on the web's memory page.
  - Its reason names the untrusted sources, never their text.
  - `store()` (`apps/brain/src/memory/proposals.ts:356`) dismisses an older pending proposal of the same kind. For `write`, key that on the path, so two writes to different files both stay.
  - `apply()`'s default branch (`:271`) already commits with a conflict check.
  - Send one low-priority ntfy per proposal; proposals only notify on failure today.
- **The tool's reply:** "Saved as a proposal; the owner applies it", so the model doesn't retry.
- **Docs:** update PLAN §6.1 and HANDOFF §1.
- **Tests:** a tainted chat and a tainted task each make a proposal for `skills/x.md` and commit directly for `notes/x.md`. An untainted write commits directly. Apply and Dismiss work, and staleness works.

### C5. A spending reserve for alerts
When the daily limit is spent, a Kuma alert's task fails before any model call. The owner gets "Failed: <monitor> is down" with "Stopped: Today's $10 limit would be exceeded." (`apps/brain/src/tasks/agent-run.ts:525-528`, `apps/brain/src/tasks/service.ts:762, 780-789`), and nothing investigates. Spend limits are global and shared by every bot, so any busy day can cause this.
- **Setting:** `limits.alertReserveUsd`, default `1`. It goes in `apps/brain/src/settings.ts:5-9` and `:42`, and in the shared `Limits` (`packages/shared/src/index.ts:497`). Show it on the web in `apps/web/src/pages/Settings.tsx:163-181` and on iOS in `apps/ios/Hatbot/Views/SpendView.swift:48-105` and `Core/Models.swift:473`.
- **The rule:**
  - `spend.check` (`apps/brain/src/spend.ts:279`) takes whether the work may use the reserve.
  - Tasks whose `origin` is `alert` or `heartbeat`, and heartbeat triage (`apps/brain/src/heartbeat.ts:222`), may spend up to the full daily and monthly limits.
  - Everything else stops at the limit minus the reserve.
  - Pass `task.origin` from `apps/brain/src/tasks/agent-run.ts:525` and `apps/brain/src/tasks/desktop-run.ts:699`. A desktop child inherits its parent's origin (`agent-run.ts:211`), so it's covered.
- **When even the reserve is gone:** an alert task's failure should say "Not investigated: today's limit is spent" and include the alert's own text.
- **Tests:** at $9.50 of $10, a chat task stops and an alert task runs. At $10, the alert's notification carries the alert text.

### C6. Watchers that run a page's scripts
A page watcher does a plain GET with no JavaScript (`apps/desktop-agent/src/fetch.ts:80`), so pages built in the browser come back empty.
- **The switch:** add `render?: boolean` to `WatchSource` (`packages/shared/src/watch.ts:6-20`). Sources are stored as JSON, so no migration is needed. Render watchers have a 15-minute minimum interval (`MIN_WATCH_MINUTES`, `:66`) to spare RAM.
- **A render service:** a small `hatbot-render` unit, built like `hatbot-desktop-shell` (`apps/desktop-agent/src/shell.ts`, the unit in `infra/desktop-deploy.sh:111-138`).
  - It runs with `DynamicUser` and `MemoryMax=500M`, and listens on a Unix socket that desktop-agent relays as `POST /render`.
  - It runs `chromium --headless=new --dump-dom --virtual-time-budget=15000 --user-data-dir=<throwaway> <url>`. There are no logins, it isn't the bots' browser, and there's no DevTools port.
  - It renders one page at a time, with a 20 s timeout, and returns the HTML capped at 2 MiB, as `/fetch` does.
  - Check `--dump-dom` and `--virtual-time-budget` on the installed Chromium. If they don't work, drive it over `--remote-debugging-pipe`.
  - Don't open a DevTools TCP port. The loopback rule (`infra/desktop-deploy.sh:88`) rejects all TCP on `lo` from the DynamicUser range, replies included. That rule is also what stops a page from reaching the main Chromium's DevTools (9222) or desktop-agent.
- **Isolation:** the host firewall already keeps it off the LAN. The desktop has 1536 MB plus 1 GB swap (`infra/host-setup.sh:46-47`), Chromium has no cap, and the shell is capped at 1 GB, so keep the render unit's cap.
- **Brain:** `read()` (`apps/brain/src/watch/service.ts:432-470`) calls `desktop.render(url)` when the switch is on. Add it to the client next to `fetch` (`apps/brain/src/desktop/client.ts:162`). Extraction is unchanged (`apps/brain/src/watch/extract.ts`), and the values stay untrusted.
- **UI and tools:**
  - Web: a "Run the page's scripts" switch beside the page/tool toggle (`apps/web/src/pages/Watchers.tsx:319-328`), and in the preview.
  - Chat: the `watch_create` and `watch_update` tool schemas (`apps/brain/src/agent/tools.ts:145, 474-576`).
  - iOS: there's no watcher editor, so only show the switch in `WatcherDetailView` (`apps/ios/Hatbot/Views/LookingViews.swift:164`).
- **Check everything:** report whether rendering works.
- **Not for:** sites with bot protection. They'll block it too, so say so in the tool description.
- **Tests:**
  - desktop-agent: the render route against a local page that writes its text with a script.
  - brain: the render path, using `apps/brain/test/fake-desktop.ts`.
  - The owner runs `deploy.sh` for the new unit; add it to the checklist.

### C7. Getting ready to open-source (last)
- **Licence:** ask the owner. MIT and Apache-2.0 both fit the no-copyleft rule.
- **The owner's domain:** `gaycats.ovh` appears only as defaults, comments and iOS identifiers:
  - `infra/deploy.sh:51` (default URL) and `infra/host-setup.sh:592` (a message): make the default URL empty, so `deploy.sh` asks for it.
  - The iOS bundle prefix and App Group: `apps/ios/project.yml` (lines 4, 21, 36, 57, 73, 96, 108, 124), `apps/ios/sidestore-source.py:23,30`, `apps/ios/Widgets/HatbotWidgets.swift:17-18`, `apps/ios/Hatbot/App/HatbotApp.swift:76,78` and `apps/ios/Hatbot/App/AppGroup.swift:8`.
  - Make the bundle prefix one XcodeGen setting that everything derives from, keeping the owner's value in CI.
- **Install guide:** a README section with the requirements (Proxmox, two LXCs, an Anthropic API key, ntfy) and the Part A checklist.
- **Licence audit:** a script that lists every dependency's licence and fails on copyleft, run in CI.
