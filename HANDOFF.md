# Handoff — what's left after M5

Written 2026-10-10. `PLAN.md` is the source of truth; this file says where things stand and what to build next.
Delete it, or fold it into `PLAN.md`, once the work below is done.

## Where things stand

- **Built:** M0–M5 and the iOS app (see the checklists in `PLAN.md` §11). M4 and M5 are built and committed but not yet deployed or tried live.
- **Not yet tried live** (the owner does these): the M2 lock-screen approval, the M3 morning schedule, Forgejo webhook and Kuma alert, all of M4 and M5, and the first iOS install from SideStore.
- **Checks:** 142 tests (brain and desktop-agent) and 19 iOS core tests pass, and Biome and `tsc -b` are clean.

## How to work here

- **Run:** `export PATH=$HOME/.bun/bin:$PATH` (`bun` isn't on PATH). Then `bun test`, `bun run check` (Biome) and `bun run typecheck`, all three before every commit.
- **Commits:** one commit per finished piece, on `main`, in the style of the history ("Plugins: …", "MCP plugin: …"). Commit locally; push only when the owner asks. End commit messages with the `Co-Authored-By` line your harness gives you.
- **Stopping the dev brain:** use `fuser -k <port>/tcp`. `pkill -f "bun src/main.ts"` kills your own shell.
- **Forgejo** (`git.gaycats.ovh`) sometimes hangs or resets connections. Retry later; the GitHub mirror runs CI.
- **Code style:** match the surrounding code. Comments are sparse and explain *why*; user-facing text is plain, short English.
- **UI style:** no decorative clutter, meaning no status dots, subtext, kickers or meta chips.
- **Shared types:** they live in `packages/shared`. The iOS app mirrors the ones it uses in `apps/ios/Hatbot/Core/Models.swift`, so change both together. The iOS decoder tolerates unknown events and enum values.
- **Swift on Linux:** this machine has no toolchain; use Docker's `swift:6.1` image (command in `apps/ios/README.md`) for `swift test` on `Hatbot/Core` and `swiftc -parse` on the views. CI on the GitHub mirror builds the app.
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

## 4. Later (not v1, don't start without the owner)
- **GitHub plugin**, next to Forgejo. Same shape as `apps/brain/src/plugins/forgejo/`.
- **After v1** (PLAN §11): email via Proton Bridge, more than one agent, a heartbeat that acts on its own, an open-source release.

## Things the owner should know when testing M4
- **Kuma prompt:** existing Uptime Kuma triggers keep their old prompt. Re-save them with the new default (`KUMA_PROMPT` in `apps/web/src/pages/Schedules.tsx`) to get investigate → one restart → verify.
- **Plugin pages:** Settings → Plugins was never looked at in a browser, only checked through the API and typecheck.
- **Secrets:** they go in `/etc/hatbot/forgejo.env` and `/etc/hatbot/mcp.env`; `infra/brain-deploy.sh` wires them in.
