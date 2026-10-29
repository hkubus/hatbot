# Hatbot — Plan

A self-hosted, always-on personal agent built on Claude, running on the owner's Proxmox homelab.

This file lists only what's still to do and what's left out on purpose. What's built is in the code. The full design as it stood when built is `git show 89745c8:PLAN.md`; the code's `PLAN.md §N` comments refer to it.

---

## 0. Modular split (decided and built 2026-10-29)
Hatbot is a core plus plugins in `plugins/<id>`, on `@hatbot/plugin-sdk`. The design as decided is in `git show 43ae48ac:PLAN.md`. Built: the SDK; the connectors, Scout, Own code and T3 Code as packages; providers as plugins (Anthropic, OpenAI-compatible) with five roles; automation, research, boxes and desktop (connection, take over, live view, Teach) as plugins; installs from `plugins.json` or a git URL at a commit, uninstall, and deleting a plugin's data; the web hiding a plugin's views while it's off; the desktop's and boxes guest's scripts in their plugins' `infra/`, each guest optional on Proxmox and over SSH.

Not as decided:
- **Desktop tasks and marketplace stay in the core**, switched off with their plugins rather than moved: `run_desktop_task`, its prompt lines and routes come only with the Desktop plugin, and negotiation and listing tools only with Scout. Moving them would put the core loop's insides (approvals, screening, steering, the desktop's gates) into the SDK.
- **An installed plugin restarts the brain** (exit 75; systemd starts it again), since routes can't be added to a running server. Under `bun run dev` the brain just stops: start it again.

Left:
- An installed plugin's own settings form: the web app is built with the first-party ones, so an installed plugin's page has its switch, its environment and secrets, and its tools.
- iOS: the web view for installed plugins' pages, and choosing a model provider on first run. The iOS app still assumes the desktop and boxes are there.
- Trying an install from a real forge, and a plugin with its own npm packages, on the brain guest (`bun install` under `ProtectSystem=strict`).

## 1. Deploy and try live
Built, but not yet deployed or tried live:
- **Boxes** (2026-10-18 and 2026-10-19). Not tried yet: a real `hatbot-boxes` guest under systemd (the units, polkit, DynamicUser, the firewall, and the runner reading its secrets inside `hatbox@`'s sandbox); `boxes_look` drawn by `hatbot-render` under systemd; boxes in the iOS app on a device; `hatbox.ask` and `hatbox.feed` against a brain; and the model making a box, a server box, or one that uses ask, send, feed, notifications or secrets.
- **Hand-offs in the other bot's chat, and the code bot** (2026-10-19).
- **Hatbot handing the other bots their work** (2026-10-20).
- **Logins from Scout** (2026-10-26): a marketplace login you share in Scout (Settings → Marketplace accounts → Share with connected apps, which needs Scout's sign-in on) goes in Haggler's browser as its task gets the screen. Not tried against a real marketplace: whether a login captured on another computer, with another address and browser, still works there or asks to verify.
- **Listings blocks** (2026-10-26): things for sale as a row of cards in a reply, their photos fetched by the brain from OLX's, Allegro's and Vinted's image servers only. Not tried: whether those servers answer the brain, and whether the model passes Scout's `image` through as the photo.
- **More chart kinds** (2026-10-26): reference lines on line and bar charts, and meter, calendar, treemap, compare, offers and gallery blocks, on the web and iOS. Not tried: whether the model picks them when it should. The iOS views haven't been compiled outside CI.
- **T3 Code** in place of Claude Code (2026-10-22): connecting it, `t3_code` in a real project, and a box made through `boxes_t3`. Not tried against a real T3 Code: what `t3_thread_launch` answers, and whether item positions in `t3_thread_read` start at 0 or 1.

- **Your computers** (2026-10-29): the `computer` plugin, for the owner's own Linux computers through the Linux app (`apps/linux`, Rust and iced, on niri). The app dials in with a device token; only the computer turns its use on, while the web and iOS can pause it or turn it off. Commands, files and desktop tasks run on it as the owner: `run_desktop_task` takes a computer by name, using it is asked once a task (Safety's "Using your computers"), and the task waits while the computer is offline, locked, paused or in the owner's hands. Each screen has its own lane, so the desktop and every computer run a task at once. Live picks the screen to watch on the web and iOS. Not tried: the brain against the real Linux app, AT-SPI's answers in real apps, and how often a zoomed screenshot is enough to judge a click nothing can name.

## 2. Small gaps
- Your computers: no settings page for them in the iOS app, and Teach works only on the desktop.
- Check everything has no line for the boxes guest; only `verify.sh` checks it, from the host.
- Box secrets can only be set in the web app: the iOS app ignores `BoxDetail.secrets`.
- The iOS app decodes negotiation events but doesn't show negotiations.

---

## 3. Negotiation
Hatbot haggles on OLX, Allegro Lokalnie and Vinted as the Haggler bot, inside a mandate you approve, with market data from Scout (`../scout`) over the MCP plugin. N1 and N2 are built (2026-10-16) and tested against a stand-in desktop-agent and Scout, but not tried live: there's no marketplace account yet.

Built 2026-10-26, not tried live: `negotiate_inspect` (a listing's live page and up to 5 photos, read from the desktop, which needs Update for `/fetch/image`), the search method in Scout's notes (keep looking until a listing meets every must-have), and N4, several sellers at once under one approval, where the first agreement ends the others. The sellers it drops aren't told; a short "bought elsewhere" would need a send past the mandate check. Photos are picked by the marketplaces' image hosts and page order, checked against one page from each site on 2026-10-26.

### 3.1 Milestones
- **N1, finish**: once Haggler has its own marketplace account, show it one negotiation per site (teach-by-showing) for its playbook skill. Done when one OLX negotiation runs end to end.
- **N3, waking**: Scout's inbox tools. A poller without the model reads `scout_inbox` every 10 minutes while any negotiation is open, taking over `negotiate_check`'s routine reads. A new seller message is stored and screened (the scam check on recorded messages is built), then starts a short background task for that negotiation with its record; nothing waits in a long task for days. When the follow-up time passes without a reply, a task starts to nudge the seller or give up. Approving a scam hold should wake Haggler too. Done when a seller's reply gets an answer within 15 minutes, with nobody in the chat.
- **N5, selling**: answering buyers on your listings. The floor comes from Scout's flips: the buy price, fees and a margin.
- **N6, listing** (planned 2026-10-22): you mark a flip "Ready to list" in Scout, approve it with one tap, and Haggler posts it on the marketplaces you picked. See 3.3.
- **Maybe later**: `scout_send_message`, if sending from the desktop turns out too slow.

### 3.2 Scout's part
This goes in Scout's own repo, as a handoff there, in the shapes the brain reads. Read tools, all `readOnlyHint`:
- **`scout_price_reference {query, sources}`** → `best.{typicalPrice, p25, samples, name, basis, ready}`. P0-4 in Scout's `HAT_DEALS_HANDOFF.md`, never built; that handoff is otherwise stale. Until it exists the appraisal uses `scout_watch_analytics`.
- **`scout_comparables {listingKey}`** → `comparables|listings|items[].{title, price, url}`: live alternatives for the same item, the fallback and honest leverage.
- **`scout_listing_detail`** gains days listed, price drops, relists, the seller's other listings and the negotiable flag, and `live: true` (P1-3), to check the listing before an offer and before paying. The brain already reads `listing.{url, title, price, marketplace, typical, watchId, priceNegotiable, postedAt|firstSeenAt}` and `history[].{price, observedAt}`.
- **`scout_inbox(marketplace, since?)`** and **`scout_conversation(id)`**, through Scout's stored marketplace sessions (N3).

For logins (built in Scout, 2026-10-26): **`scout_shared_sessions`** → `sessions[].{marketplace, label, revision}` and **`scout_shared_session {marketplace}`** → `{revision, storageState}`, Playwright storage state. Only connected apps get them, only for the sessions you shared, and the brain alone calls them (`desktop/logins.ts`); desktop-agent takes cookies only for the marketplaces' sites.

One write tool:
- **`scout_record_outcome {listingKey, outcome, price, asking, currency}`**: the final price, kept apart from Scout's asking-price statistics, as flips are, and shown as a figure of its own ("you pay about 84% of asking for GPUs on OLX").

For N6, Scout's handoff is `../scout/docs/hatbot-listing-plan.md`. In short:
- `scout_flips_to_list` (read): flips marked ready, each with `id, updatedAt, channels[]` and each channel's `{status, url?, error?}`.
- `scout_flip {id}` (read): `title, description, condition, category, delivery, prices{channel}, photos[].id`.
- `scout_flip_photo {id}` (read): one photo, `{mime: "image/jpeg", base64}`, as text, since the MCP plugin drops image content.
- `scout_flip_listed {flipId, channel, status, url?, error?}` (write): the outcome of one channel, `listed`, `failed` or `declined`. Haggler needs it on Allow.
- No word for selling in their descriptions: the MCP plugin's money words would make them purchases, and the brain couldn't read them.

### 3.3 N6, listing
You mark a flip ready in Scout and pick channels; Hatbot asks once; Haggler posts it on each channel and Scout gets the URLs back. Haggler only, since it holds the marketplace logins. Blocked live on the same thing as N1: Haggler's own accounts.

**L1, Scout** (in Scout's repo, from its handoff; started in Scout's own T3 thread on 2026-10-24): the ready state, the four tools above, the button on the web and iOS, and delivery details (Vinted's parcel size, OLX and Allegro Lokalnie delivery and pickup) in the listing draft.

L2 (photo uploads on the add-listing pages) and L3 (the lister, `apps/brain/src/listings/`) are built (2026-10-24) and tested against a stand-in Scout and desktop-agent, not live. Not checked yet: the add-listing pages' addresses (`UPLOAD_PAGES` in `packages/shared/src/desktop.ts`) and their publish buttons' labels (`listings/gate.ts`).

Scout is connected with a button: Settings → Plugins → Scout (2026-10-25). Scout's side, the sign-in (MCP's OAuth with PKCE) and Connected apps, is being built on its `feat/hatbot-listing` branch.

**L4, live.** Once L1 and the sign-in are in Scout, connect it. Teach Haggler one listing per site, for its playbook skills ("list on OLX", "list on Allegro Lokalnie", "list on Vinted"); categories and delivery are where it'd stumble. Done when one real flip goes from "Ready to list" to a live OLX listing with its URL in Scout, with nobody at the keyboard after the tap.

**Not in N6:** answering buyers (N5), taking a sold flip off its other channels (Scout already has the checklist), editing or relisting a live listing, and paid promotion.

---

## 4. Left on purpose
Known gaps, kept because closing them costs more than they risk (the owner's call, 2026-10-18).
- stdio MCP servers run as the `hatbot` user, which can read `/etc/hatbot/*.env` and `secrets.json`. Running each as its own user would need a root-side launcher.
- Attachments are sent inline with every request, up to 20 MB, and a desktop task sends its screenshots again each step, not through the Files API, which keeps files at Anthropic until deleted.
- No cache mark on the app's system-note turns: the docs don't say system messages take `cache_control`.
- The try-again and chart-fix notes are user turns opening "(No message from the owner: …)": the API takes a system message only after a user turn.
- No Chromium policy (`URLBlocklist` for `javascript:`) in `plugins/desktop/infra/desktop-deploy.sh`; the brain refuses typed script addresses instead.
- Outside negotiations, Enter in a custom element with a closed shadow root isn't held; only Teach treats it as secret.
- desktop-agent keeps its own list of payment hosts for Teach's card-frame check, apart from the brain's.
- The mandate check works from word lists. It holds an IBAN written like a phone number as a phone number, and can't catch an acceptance in words it doesn't know while naming our price inside the mandate, new plain words for paying off the platform, or trades ("300 zł i moją starą kartę").
- Research has no page reader that runs JavaScript (it could send out what the task has read; such pages go to `run_desktop_task`), and isn't started from schedules.
- Settings → Plugins, Approvals and guardrails, and teach mode stay web-only; the iOS app has only the safety review's switch.
- To-do items aren't handed to other bots with `@name`; ask the bot in the chat instead.
- Your computers: what's on their screens isn't read or screened for prompt injection, only window titles are noted; the task is tainted by the first screenshot, so its consequential steps ask anyway. `computer_get_file` refuses private keys and password stores rather than asking.
- T3 Code: its sign-in lasts 30 days with no refresh, so it has to be connected again; threads to carry on are kept in memory, which a restart forgets; a box's files over 100 KB can't be handed to it in one message.

**Not planned:**
- Messengers (Signal, Telegram, Matrix): Hatbot's own web and iOS apps are enough.
- Email and calendar, until after v1. Proton Bridge needs a paid Proton plan.
- Open-ended goals, and more than one user.
- Boxes shared by public link, WebSockets from box backends, and box languages other than TypeScript.

## 5. Maybe later
- Teams.
- The desktop as a KVM VM instead of an LXC, if RAM allows.
