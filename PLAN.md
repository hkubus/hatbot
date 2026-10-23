# Hatbot — Plan

A self-hosted, always-on personal agent built on Claude, running on the owner's Proxmox homelab.

This file lists only what's still to do and what's left out on purpose. What's built is in the code. The full design as it stood when built is `git show 89745c8:PLAN.md`; the code's `PLAN.md §N` comments refer to it.

---

## 1. Deploy and try live
Built, but not yet deployed or tried live:
- **Boxes** (2026-10-18 and 2026-10-19). Not tried yet: a real `hatbot-boxes` guest under systemd (the units, polkit, DynamicUser, the firewall, and the runner reading its secrets inside `hatbox@`'s sandbox); `box_look` drawn by `hatbot-render` under systemd; boxes in the iOS app on a device; `hatbox.ask` and `hatbox.feed` against a brain; and the model making a box, a server box, or one that uses ask, send, feed, notifications or secrets.
- **Hand-offs in the other bot's chat, and the code bot** (2026-10-19).
- **Hatbot handing the other bots their work** (2026-10-20).
- **T3 Code** in place of Claude Code (2026-10-22): connecting it, `t3_code` in a real project, and a box made through `box_t3`. Not tried against a real T3 Code: what `t3_thread_launch` answers, and whether item positions in `t3_thread_read` start at 0 or 1.
- **The Linux app** (L1–L6, 2026-10-20 and 2026-10-21). Done when you can chat, approve and take over from it.

## 2. Small gaps
- Check everything has no line for the boxes guest; only `verify.sh` checks it, from the host.
- Box secrets can only be set in the web app: the iOS app ignores `BoxDetail.secrets`.
- The iOS app decodes negotiation events but doesn't show negotiations.

---

## 3. Negotiation
Hatbot haggles on OLX, Allegro Lokalnie and Vinted as the Haggler bot, inside a mandate you approve, with market data from Scout (`../scout`) over the MCP plugin. N1 and N2 are built (2026-10-16) and tested against a stand-in desktop-agent and Scout, but not tried live: there's no marketplace account yet.

### 3.1 Milestones
- **N1, finish**: once Haggler has its own marketplace account, show it one negotiation per site (teach-by-showing) for its playbook skill. Done when one OLX negotiation runs end to end.
- **N3, waking**: Scout's inbox tools. A poller without the model reads `scout_inbox` every 10 minutes while any negotiation is open, taking over `negotiate_check`'s routine reads. A new seller message is stored and screened (the scam check on recorded messages is built), then starts a short background task for that negotiation with its record; nothing waits in a long task for days. When the follow-up time passes without a reply, a task starts to nudge the seller or give up. Approving a scam hold should wake Haggler too. Done when a seller's reply gets an answer within 15 minutes, with nobody in the chat.
- **N4, several sellers**: more than one open negotiation per want (now one per listing and one per want). The first agreement locks the want, and `negotiate_close` declines the others.
- **N5, selling**: answering buyers on your listings. The floor comes from Scout's flips: the buy price, fees and a margin.
- **N6, listing** (planned 2026-10-22): you mark a flip "Ready to list" in Scout, approve it with one tap, and Haggler posts it on the marketplaces you picked. See 3.3.
- **Maybe later**: `scout_send_message`, if sending from the desktop turns out too slow.

### 3.2 Scout's part
This goes in Scout's own repo, as a handoff there, in the shapes the brain reads. Read tools, all `readOnlyHint`:
- **`scout_price_reference {query, sources}`** → `best.{typicalPrice, p25, samples, name, basis, ready}`. P0-4 in Scout's `HAT_DEALS_HANDOFF.md`, never built; that handoff is otherwise stale. Until it exists the appraisal uses `scout_watch_analytics`.
- **`scout_comparables {listingKey}`** → `comparables|listings|items[].{title, price, url}`: live alternatives for the same item, the fallback and honest leverage.
- **`scout_listing_detail`** gains days listed, price drops, relists, the seller's other listings and the negotiable flag, and `live: true` (P1-3), to check the listing before an offer and before paying. The brain already reads `listing.{url, title, price, marketplace, typical, watchId, priceNegotiable, postedAt|firstSeenAt}` and `history[].{price, observedAt}`.
- **`scout_inbox(marketplace, since?)`** and **`scout_conversation(id)`**, through Scout's stored marketplace sessions (N3).

One write tool:
- **`scout_record_outcome {listingKey, outcome, price, asking, currency}`**: the final price, kept apart from Scout's asking-price statistics, as flips are, and shown as a figure of its own ("you pay about 84% of asking for GPUs on OLX").

For N6, Scout's handoff is `../scout/docs/hatbot-listing-plan.md`. In short:
- `scout_flips_to_list` (read): flips marked ready, each with `id, updatedAt, channels[]` and each channel's `{status, url?, error?}`.
- `scout_flip {id}` (read): `title, description, condition, category, delivery, prices{channel}, photos[].id`.
- `scout_flip_photo {id}` (read): one photo, `{mime: "image/jpeg", base64}`, as text, since the MCP plugin drops image content.
- `scout_flip_listed {flipId, channel, url?, error?}` (write): the outcome of one channel.
- No word for selling in their descriptions: the MCP plugin's money words would make them purchases, and the brain couldn't read them.

### 3.3 N6, listing
You mark a flip ready in Scout and pick channels; Hatbot asks once; Haggler posts it on each channel and Scout gets the URLs back. Haggler only, since it holds the marketplace logins. Blocked live on the same thing as N1: Haggler's own accounts.

**L1, Scout** (in Scout's repo, from its handoff): the ready state, the four tools above, the button on the web and iOS, and delivery details (Vinted's parcel size, OLX and Allegro Lokalnie delivery and pickup) in the listing draft.

**L2, uploads on the desktop.** desktop-agent refuses file inputs (`page.ts`), and the browser can't see the shell's files. A new `upload` feature:
- The brain stages files for one task (`stageFiles(taskId, files)`); desktop-agent writes them where the browser user can read them, and deletes them when the task ends or after an hour.
- `set_files {ref, fileIds}` puts them on a file input with CDP's `DOM.setFileInputFiles`.
- Only on the add-listing pages (`olx.pl/adding/`, `allegrolokalnie.pl/o/oferty/wystaw`, `vinted.pl/items/new`), only with files staged for that task. Anything else is still refused.
- `desktopReady()` for listing also needs the `upload` feature.
- Tests: an allow and a refuse (another page; a file not staged for the task), and a Chromium test that a staged file lands on a real file input.

**L3, the lister** (`apps/brain/src/listings/`, in the core next to `negotiate/`, for the same reason: it starts tasks and drives the desktop).
- *Poller:* every 5 minutes, without the model, the brain reads `scout_flips_to_list` (like `watch/service.ts`'s `read()`). Nothing to list, nothing happens. Scout's tools are found by suffix as in `appraise.ts`, and need Haggler to have them.
- *Table* `flip_listings (flip_id, channel, flip_updated_at, status, approval_id, task_id, url, error)`, unique on flip and channel, so a restart or a second tick never asks or posts twice. Statuses: `asking, queued, posting, listed, failed, declined, cancelled`.
- *One tap:* a new flip raises one approval of the new kind `listing`, in plain text, for all its channels: "List 'RTX 3070 Gaming OC' on OLX for 1199 zł and Vinted for 1149 zł? 6 photos." with the title, description, condition and delivery below. A phone notification may approve it (add `listing` to `approvals.ts`'s phone kinds); it's never left to Haiku's review. Marking a flip in Scout doesn't count as approving it: Scout's MCP output is untrusted, and a listing draft can come from the seller's own text. Declining records `declined` in Scout and drops it.
- *Changes after the tap:* if the flip's `updatedAt` moves before it's posted, the approval is asked again with the new text. If it's no longer ready (you cancelled in Scout), its queued tasks are dropped and nothing is posted.
- *Posting:* one desktop task per channel, as Haggler, `runKey listing:<flip>:<channel>`, one at a time per marketplace. The brain fetches the photos with `scout_flip_photo` and stages them (L2). The task's brief holds the approved listing as data, and the site's playbook skill.
- *The gate:* like negotiation's exact-text gate (`negotiate/gate.ts`), a `listing_tasks` row makes `desktop-run.ts` allow, on that channel's add-listing page only, typing exactly the approved title, description and price, setting the staged photos, picking category, condition and delivery, and pressing Publish once, without asking again. Anything else consequential (paying for promotion, "wyróżnij", a phone or address change) still asks, and payment hosts are refused as now.
- *After Publish:* the task finishes with the new listing's URL; the brain checks it's on that marketplace's host and records it with `scout_flip_listed`. A failure is recorded there too, with a plain sentence, and said in Haggler's chat.
- *Types:* `ListingStatus` and the `listing` approval kind in `packages/shared`, mirrored in `Models.swift` and `models.rs`. No new screens: the approval and tasks show where they already do.
- *Tests:* end to end, a ready flip against a stand-in Scout and desktop-agent goes from one approval to two tasks to two URLs in Scout. A test each for: no second approval on the next tick; a changed flip asks again; a cancelled flip posts nothing; the gate refuses text that isn't the approved text, and a second Publish.

**L4, live.** Teach Haggler one listing per site, for its playbook skills ("list on OLX", "list on Allegro Lokalnie", "list on Vinted"); categories and delivery are where it'd stumble. Done when one real flip goes from "Ready to list" to a live OLX listing with its URL in Scout, with nobody at the keyboard after the tap.

**Not in N6:** answering buyers (N5), taking a sold flip off its other channels (Scout already has the checklist), editing or relisting a live listing, and paid promotion.

---

## 4. Left on purpose
Known gaps, kept because closing them costs more than they risk (the owner's call, 2026-10-18).
- stdio MCP servers run as the `hatbot` user, which can read `/etc/hatbot/*.env` and `secrets.json`. Running each as its own user would need a root-side launcher.
- Attachments are sent inline with every request, up to 20 MB, and a desktop task sends its screenshots again each step, not through the Files API, which keeps files at Anthropic until deleted.
- No cache mark on the app's system-note turns: the docs don't say system messages take `cache_control`.
- The try-again and chart-fix notes are user turns opening "(No message from the owner: …)": the API takes a system message only after a user turn.
- No Chromium policy (`URLBlocklist` for `javascript:`) in `desktop-deploy.sh`; the brain refuses typed script addresses instead.
- Outside negotiations, Enter in a custom element with a closed shadow root isn't held; only Teach treats it as secret.
- desktop-agent keeps its own list of payment hosts for Teach's card-frame check, apart from the brain's.
- The mandate check works from word lists. It holds an IBAN written like a phone number as a phone number, and can't catch an acceptance in words it doesn't know while naming our price inside the mandate, new plain words for paying off the platform, or trades ("300 zł i moją starą kartę").
- Research has no page reader that runs JavaScript (it could send out what the task has read; such pages go to `run_desktop_task`), and isn't started from schedules.
- Settings → Plugins and teach mode stay web-only.
- To-do items aren't handed to other bots with `@name`; ask the bot in the chat instead.
- T3 Code: its sign-in lasts 30 days with no refresh, so it has to be connected again; threads to carry on are kept in memory, which a restart forgets; a box's files over 100 KB can't be handed to it in one message.

**Not planned:**
- Messengers (Signal, Telegram, Matrix): Hatbot's own web, iOS and Linux apps are enough.
- Email and calendar, until after v1. Proton Bridge needs a paid Proton plan.
- Open-ended goals, and more than one user.
- Boxes shared by public link, WebSockets from box backends, and box languages other than TypeScript.
- The Linux app's disk cache of chats, tray icon or running in the background, and Flatpak.

## 5. Maybe later
- Teams.
- The desktop as a KVM VM instead of an LXC, if RAM allows.
