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

## 4. Threads
Planned 2026-10-25. A thread is a side conversation in a bot's chat, on one topic, with a title. A bot opens one when it has something for you that shouldn't interrupt the main chat or get lost in it: Haggler wanting your view on a counter-offer, Sysadmin reporting what it found. You can open one too. Several run at once, each with its own reply queue, so the bot answers in one while the main chat is busy. When it's settled, the bot or you resolve it, and its outcome goes into what the main chat knows.

### 4.1 How
- **Data**: a conversation of a new kind, `thread`, with `parent_id` (the bot's own chat), `key` (one thread per subject: `negotiation:12`), `opened_by_task_id`, `resolved_at` and `outcome`. A `thread` message in the parent chat links to it and is its card in the timeline. Threads stay out of the chat list; `GET /conversations/:id/threads` lists a chat's. Only in a bot's own chat, not in groups.
- **What the bot sees in a thread**: its memory index, the parent chat's summary, the thread's own summary and recent messages, and what opened it (the task's summary, the negotiation's record). Not the main chat's recent messages. The same tools as in the main chat.
- **What the main chat sees**: the open threads (id, title, last line), and each resolved thread's outcome through its summary. `thread_read` reads one in full when you ask; what it reads brings that thread's taint with it.
- **Tools**: `thread_open {title, message, key?}` in chats and tasks; `thread_post {id | key, message}` in tasks; `thread_resolve {outcome}` in a thread. None asks: they only write to you. At most 12 open threads per bot, and one `thread_open` per task.
- **You**: Reply in thread on a bot's message or a task card; Resolve; writing in a resolved thread opens it again.
- **Tasks**: a task started in a thread reports there. A background task (a schedule, the heartbeat, a watcher, a negotiation) that opens or posts in a thread reports there, not in the main chat, and asks its `ask_owner` questions there.
- **Taint**: each thread has its own. A thread that reads a seller's messages or logs doesn't taint the main chat; one opened by a tainted task starts tainted, and its opening message is untrusted. A tainted thread's title reaches the main chat as untrusted.
- **Notifications**: a new thread a task opens notifies (it needs you; one opened in the chat you're in doesn't), opening `/chat/:id?thread=<threadId>`, with a `hatbot://` link for iOS. Replies in a thread don't, as in the chat.
- **Clients**: the web and iOS stores hold one chat's messages; they need one list per open conversation, and `message.created` matched to any of them. On the web a thread opens in a panel beside the chat (in the chat's place on a phone); its card shows the title and the latest reply, or the outcome once resolved. A Threads button in the chat's header lists them. A bot's unread count includes its threads'.

### 4.2 Milestones
- **T1, brain** is built (2026-10-25): the data, thread conversations and their context, `thread_open`, `thread_read` and `thread_resolve` in the chat, and `GET /conversations/:id/threads` and `POST /conversations/:id/resolve`.
- **T2, web** is built (2026-10-25): the store's second pane, the panel at `?thread=<id>`, the card, the list at `?threads`, Resolve, and Reply in thread (`POST /conversations/:id/threads`).
- **T3, tasks** is built (2026-10-25): `thread_open` (with `key`) and `thread_post` in background tasks, which then report and ask in the thread unless started from a chat; the notification and its `hatbot://threads/<id>` link; Reply in thread on an ended task's card.
- **T4, bots** is built (2026-10-25): every negotiation opens its thread (`negotiation:<id>`, named by its want, not the seller's title) and reports there, its mandate and holds included; ending it resolves the thread. The heartbeat's and prompt-less watchers' findings go to a thread per subject (`heartbeat`, `watch:<id>`), or a note in the chat while 12 are open. Prompt lines for chats and tasks. Negotiations from before T4 stay in their chat.
- **T5, iOS** is built (2026-10-25): a thread opens in the chat's place, with a back button to its chat and Resolve; the card, the Threads list in a bot's chat, Reply in Thread, and the `hatbot://threads/<id>` link. Not tried on a device yet.
- **Needs you** is built (2026-10-26): `thread_open` and `thread_post` take `needs_you` when the bot needs your answer; the thread shows in the attention colour, open ones like it first, until you write in it or it's resolved, and a task's mark notifies you. A thread with an approval or question waiting in it shows the same. The chat's bot sees which threads wait for you.

**Not in threads:** groups, threads inside threads, more than one bot in a thread, moving messages between threads, and the Linux app (it's being removed).

---

## 5. Left on purpose
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
- Settings → Plugins, Approvals and guardrails, and teach mode stay web-only; the iOS app has only the safety review's switch.
- To-do items aren't handed to other bots with `@name`; ask the bot in the chat instead.
- T3 Code: its sign-in lasts 30 days with no refresh, so it has to be connected again; threads to carry on are kept in memory, which a restart forgets; a box's files over 100 KB can't be handed to it in one message.

**Not planned:**
- Messengers (Signal, Telegram, Matrix): Hatbot's own web and iOS apps are enough.
- Email and calendar, until after v1. Proton Bridge needs a paid Proton plan.
- Open-ended goals, and more than one user.
- Boxes shared by public link, WebSockets from box backends, and box languages other than TypeScript.
- A Linux app (one was built and dropped, 2026-10-26): the web app is enough.

## 6. Maybe later
- Teams.
- The desktop as a KVM VM instead of an LXC, if RAM allows.
