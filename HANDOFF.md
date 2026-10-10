# Handoff — what's left after M4

Written 2026-10-10. `PLAN.md` is the source of truth; this file says where things stand and what to build next.
Delete it, or fold it into `PLAN.md`, once the work below is done.

## Where things stand

- **Built:** M0–M4 and the iOS app (see the checklists in `PLAN.md` §11). M4 is built and committed but not yet deployed or tried live.
- **Not yet tried live** (the owner does these): the M2 lock-screen approval, the M3 morning schedule, Forgejo webhook and Kuma alert, all of M4, and the first iOS install from SideStore.
- **Checks:** 112 tests pass, and Biome and `tsc -b` are clean.

## How to work here

- **Run:** `export PATH=$HOME/.bun/bin:$PATH` (`bun` isn't on PATH). Then `bun test`, `bun run check` (Biome) and `bun run typecheck`, all three before every commit.
- **Commits:** one commit per finished piece, on `main`, in the style of the history ("Plugins: …", "MCP plugin: …"). Commit locally; push only when the owner asks. End commit messages with the `Co-Authored-By` line your harness gives you.
- **Stopping the dev brain:** use `fuser -k <port>/tcp`. `pkill -f "bun src/main.ts"` kills your own shell.
- **Forgejo** (`git.gaycats.ovh`) sometimes hangs or resets connections. Retry later; the GitHub mirror runs CI.
- **Code style:** match the surrounding code. Comments are sparse and explain *why*; user-facing text is plain, short English.
- **UI style:** no decorative clutter, meaning no status dots, subtext, kickers or meta chips. The one exception still to settle is the M5 recording indicator (see below).
- **Shared types:** they live in `packages/shared`. The iOS app mirrors the ones it uses in `apps/ios/Hatbot/Core/Models.swift`, so change both together. The iOS decoder tolerates unknown events and enum values.
- **Swift on Linux:** `cd apps/ios && /opt/swift61/usr/bin/swift test -Xswiftc -use-ld=lld` tests `Hatbot/Core`. SwiftUI files can only be `swiftc -parse`d here; CI on the GitHub mirror builds the app.
- **Licences:** no copyleft dependencies (PLAN §2), not even MPL. That's why the live view is our own MJPEG stream and not noVNC (MPL).

## 1. Decisions the owner still has to make (ask before building)

These came out of the M4 security review. They're trust-tracking gaps (PLAN §6.1), left open on purpose.

1. **`memory_write` from a tainted chat or task.** Content that came from strangers can end up in memory, and memory is trusted on every later read. The options:
   - Ask for approval when tainted.
   - Record which files a tainted context wrote (for example, a `tainted` front-matter flag or a table), and treat reading them as untrusted.
   - Leave it as it is.

   Ask the owner which. The second option keeps "notes for next run" working.
2. **Thread summaries** (Haiku, `agent/thread.ts`) don't carry taint. Once tainted messages are summarised away, the taint is lost. A likely fix is to mark a summary tainted when any message it covers came from a tainted episode, and taint episodes that inherit it.
3. **SSH output** is trusted, as the plan says, but `ssh_check logs` / `errors` and `ssh_read_file` can contain text strangers wrote (web server logs, for example). The plugin API already supports a per-input `untrusted: (input) => boolean`.

## 2. M5 — Teach-by-showing (the next milestone)

Spec: PLAN §1, §2 ("Teach-by-showing"), §5.4 (Opus writes the skill), §7.2 (`skills/<name>.md` in the memory repo), §7.1 (`skills_index` table, not created yet), §8 (`POST /teach/start`, `POST /teach/stop` → draft skill, `POST /teach/:id/save`) and §10.5 (teach mode UI).

### Record mode
- **Hook point:** `apps/brain/src/routes/desktop.ts`, in `onMessage` of `/desktop/live`. Every owner input (`LiveInput`: move, button, wheel, key) passes through there while `desktop.get().control === "owner"`.
- **Session:** start and stop it with the teach endpoints. Only record between an explicit start and stop, never during ordinary takeovers (logins, 2FA).
- **What to log:**
  - Timestamped events. Merge moves; keep button down/up with coordinates, wheel, and keys.
  - A screenshot at each button-down and each Enter, using `desktop.agent.screenshot()` from `desktop/client.ts`. Store them through the archive writer (`archive.ts` `saveScreen`).
  - The URL and title from `desktop.agent.context()` (CDP) whenever they change.
- **Passwords: this is a must.** Typed text in password fields must not be recorded. Check the focused element through CDP (`apps/desktop-agent/src/cdp.ts`; `inspect` exists in the client) and replace those keystrokes with a placeholder. When in doubt, drop typed text and keep placeholders.
- **Storage:** a new migration in `apps/brain/src/db/migrations.ts` (the latest is 8): `teach_sessions` (id, started, stopped, status, draft) and the event rows, or a JSON blob.
- **Screen lane:** recording needs the owner in control, so it holds the lane like a takeover does (PLAN §5.6).

### Draft the skill
- **Call:** one Opus 5.5 call (`claude-opus-5-5`; model ids live in `config.ts`) with the event log, URL/title changes and a downscaled subset of the screenshots. Record it in the spend ledger (`spend.ts`) like other calls.
- **Output:** a markdown skill with a name, when to use it, the steps, and `{{placeholders}}` for anything that varies (names, dates, amounts) or was redacted.
- **Trust:** screenshots show third-party page text, so the draft is untrusted until the owner saves it. The owner's review and save is what makes it trusted.

### Save, index, use
- **Save:** `POST /teach/:id/save` with the edited markdown writes `skills/<name>.md` through the memory store (a commit by the owner) and updates INDEX.md and the `skills_index` table.
- **Use:** the skills list (name + one line on when to use it) should go into the task prompts in `tasks/agent-run.ts` and `tasks/desktop-run.ts`. Chat already sees INDEX.md (`agent/thread.ts`). The agent reads a skill with `memory_read`.

### Web UI
- **Where:** the Live page (`apps/web/src/pages/Tasks.tsx` / the live view component) and the review step (a draft editor; reuse the Memory editor from `pages/Memory.tsx`).
- **What PLAN §10.5 asks for:** a red recording dot, *"Recording — show Hatbot how"*, and **Stop & create skill**. That clashes with the no-status-dots rule, so ask the owner. A plain "Recording" label with the button may be enough.
- **Tests:** `apps/brain/test/fake-desktop.ts` and `fake-model.ts` already cover the desktop and model sides.

## 3. iOS app — remaining items (PLAN §11, "iOS app")
- **Memory** (tree, file, history) and **Schedules & Triggers** in the app. The brain endpoints already exist (PLAN §8).
- **ntfy notifications open the app:** add `hatbot://tasks/<id>` / `hatbot://approvals/<id>` as click URLs. Today `click` is a web URL (`approvals.ts`, `triggers.ts`, `tasks/desktop-run.ts`). The owner may also use the web app, so make it a setting (open in web or app); don't just switch it.
- **Optional:** Settings → Plugins (switch, Test, settings forms) isn't in the app. The plan doesn't ask for it.

## 4. Later (not v1, don't start without the owner)
- **GitHub plugin**, next to Forgejo. Same shape as `apps/brain/src/plugins/forgejo/`.
- **After v1** (PLAN §11): email via Proton Bridge, more than one agent, a heartbeat that acts on its own, an open-source release.

## Things the owner should know when testing M4
- **Kuma prompt:** existing Uptime Kuma triggers keep their old prompt. Re-save them with the new default (`KUMA_PROMPT` in `apps/web/src/pages/Schedules.tsx`) to get investigate → one restart → verify.
- **Plugin pages:** Settings → Plugins was never looked at in a browser, only checked through the API and typecheck.
- **Secrets:** they go in `/etc/hatbot/forgejo.env` and `/etc/hatbot/mcp.env`; `infra/brain-deploy.sh` wires them in.
