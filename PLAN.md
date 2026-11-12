# Hatbot — Plan

A self-hosted, always-on personal agent built on Claude, running on the owner's Proxmox homelab.

This file lists only what's still to do and what's left out on purpose. What's built is in the code. The full design as it stood when built is `git show 89745c8:PLAN.md`; the code's `PLAN.md §N` comments refer to it.

---

## 0. Modular split (decided and built 2026-10-29)
Hatbot is a core plus plugins in `plugins/<id>`, on `@hatbot/plugin-sdk`. The design as decided is in `git show 43ae48ac:PLAN.md`. Built: the SDK; the connectors, Scout, Own code and T3 Code as packages; providers as plugins (Anthropic, OpenAI-compatible) with five roles; automation, research, boxes and desktop (connection, take over, live view, Teach) as plugins; installs from `plugins.json` or a git URL at a commit, uninstall, and deleting a plugin's data; the web hiding a plugin's views while it's off; the desktop's and boxes guest's scripts in their plugins' `infra/`, each guest optional on Proxmox and over SSH.

Not as decided:
- **Desktop tasks and marketplace stay in the core**, switched off with their plugins rather than moved: `run_desktop_task`, its prompt lines and routes come only with the Desktop plugin, and negotiation and listing tools only with Scout. Moving them would put the core loop's insides (approvals, the review, steering, the desktop's gates) into the SDK.
- **An installed plugin restarts the brain** (exit 75; systemd starts it again), since routes can't be added to a running server. Under `bun run dev` the brain just stops: start it again.

Left:
- An installed plugin's own settings form: the web app is built with the first-party ones, so an installed plugin's page has its switch, its environment and secrets, and its tools.
- iOS: the web view for installed plugins' pages, and choosing a model provider on first run. The iOS app still assumes the desktop and boxes are there.
- Trying an install from a real forge, and a plugin with its own npm packages, on the brain guest (`bun install` under `ProtectSystem=strict`).

## 0.1 Fewer approvals (decided and built 2026-10-29)
Only money (purchases, payments, offers outside a negotiation's mandate), account security, home access (locks, the alarm, garage doors and gates), your careful marks and "Always ask" tools, and Haggler's holds ask you. Everything else goes to the safety review, which blocks what it finds unsafe instead of asking. A blocked step offers Run anyway or Always, and a task stops after 3 blocks in a row or 20 in all. A suspected prompt injection changes nothing, and the screener is gone. A task has no spending limit of its own; the daily and monthly ones stay. "Ready to list" in Scout is the listing's approval. A negotiation starts without asking unless its mandate allows contact details, or Settings → Safety says to ask (2026-10-31). Memory files, schedules and watchers change without proposals; after untrusted content the review checks them. A desktop task's message to a person waits 30 s for you to stop it, unless you approved it yourself. Locks and doors a schedule's run asks about can be allowed for that schedule. A notification's Approve, for what it can't approve itself, opens the iOS app, which approves behind Face ID. On the desktop (2026-11-06), only a step that buys, pays or changes the account stops for confirm_intent; the review looks at other held steps where they are, and icon buttons, a form's submit, words like Confirm or Save, and frames that don't look like payment aren't held.

The plugin SDK changed with it: `suspected` and `mark` are gone, and `taint(by)` takes one argument. Installed plugins built on the old SDK need updating.

Left:
- Only a desktop task's sends wait 30 s. A plugin's writes that reach people (forge comments, MCP tools) go at once, after the review.
- Face ID approval only works with Settings → Notifications → "Tapping one opens" set to the iOS app; with the web app, Approve just shows the approval. Not tried on a device: the iOS views compile only in CI.

## 1. Deploy and try live
Built, but not yet deployed or tried live:
- **Boxes** (2026-10-18 and 2026-10-19). Not tried yet: a real `hatbot-boxes` guest under systemd (the units, polkit, DynamicUser, the firewall, and the runner reading its secrets inside `hatbox@`'s sandbox); `boxes_look` drawn by `hatbot-render` under systemd; boxes in the iOS app on a device; `hatbox.ask` and `hatbox.feed` against a brain; and the model making a box, a server box, or one that uses ask, send, feed, notifications or secrets.
- **Hand-offs in the other bot's chat, and the code bot** (2026-10-19).
- **Hatbot handing the other bots their work** (2026-10-20).
- **Logins from Scout** (2026-10-26): a marketplace login you share in Scout (Settings → Marketplace accounts → Share with connected apps, which needs Scout's sign-in on) goes in Haggler's browser as its task gets the screen. Not tried against a real marketplace: whether a login captured on another computer, with another address and browser, still works there or asks to verify.
- **Listings blocks** (2026-10-26): things for sale as a row of cards in a reply, their photos fetched by the brain from OLX's, Allegro's and Vinted's image servers only. Not tried: whether those servers answer the brain, and whether the model passes Scout's `image` through as the photo.
- **More chart kinds** (2026-10-26): reference lines on line and bar charts, and meter, calendar, treemap, compare, offers and gallery blocks, on the web and iOS. Not tried: whether the model picks them when it should. The iOS views haven't been compiled outside CI.
- **Threads** (built 2026-10-25 and 26 on `t3/bot-threads`, brought into the core 2026-10-29; the design is §4 of `git show 803634ad:PLAN.md`): side conversations in a bot's own chat, opened by the bot, a task, a negotiation, the heartbeat or a watcher, or by you with Reply in thread. Not tried: whether the model opens one when it should and keeps quick answers in the chat, and the iOS views outside CI.
- **T3 Code** in place of Claude Code (2026-10-22): connecting it, `t3_code` in a real project, and a box made through `boxes_t3`. Not tried against a real T3 Code: what `t3_thread_launch` answers, and whether item positions in `t3_thread_read` start at 0 or 1.

- **Helpers and hatbot_about** (2026-10-30): `ask_helpers` in the chat and tasks hands up to 5 parts to helpers on the small model with the bot's lookups, memory and the web, and nothing that changes anything; after untrusted content a brief can't hold links. `hatbot_about` describes how Hatbot works and how it's set up now. Not tried: whether the model splits work across helpers when it should, and whether a bot asked about itself reads `hatbot_about` instead of memory.
- **Your computers** (2026-10-29): the `computer` plugin, for the owner's own computers through the desktop app (`apps/desktop`, Tauri; tried on niri; on Windows through GDI, SendInput and UI Automation, with commands in PowerShell). The app dials in with a device token; only the computer turns its use on, while the web and iOS can pause it or turn it off. Commands, files and desktop tasks run on it as the owner: `run_desktop_task` takes a computer by name, using it is asked once a task (Safety's "Using your computers"), and the task waits while the computer is offline, locked, paused or in the owner's hands. Each screen has its own lane, so the desktop and every computer run a task at once. Live picks the screen to watch on the web and iOS. Not tried: the brain against the real desktop app, AT-SPI's and UI Automation's answers in real apps, anything on a real Windows (only compiled from Linux and run in CI), and how often a zoomed screenshot is enough to judge a click nothing can name.
- **Hatbot on your computer alone** (2026-11-01): the desktop app's first start asks whether to run Hatbot here or connect to a server. Here, it downloads and builds the brain at its own commit and runs it as a systemd user service (on Windows, `hatbot.exe --brain` at sign-in), signed in through a token file and with no password, and can let other devices in once a password is set. Not tried: a first setup on a real desktop with an empty Bun cache, an update through pacman, and the brain on Bun on Windows.
- **Guided setup** (2026-11-01): after the password page, the web app asks for a model provider and its key (checked, with the roles filled in), then the bot interviews you on the Hard parts model, topic by topic, changing settings, plugins, bots and memory directly, with secrets in forms the model never sees. `deploy.sh` and the Linux app no longer ask for the key or ntfy; the apps wait until it's finished; Settings → Account runs it again. Not tried: a real model running the interview, a plugin's sign-in coming back to it, and the Linux and iOS apps' waiting screens on a real desktop and phone.
- **Secrets** (2026-11-05): `secrets_ask` asks you to type a secret into its approval (a password field; Save), kept in `secrets.json` under a name, never in the database or the model's turns. The model writes `{{secret:NAME}}` in `ssh_write_file`, `computer_put_file` and `code_write_file`, which put the value in; `ssh_keep_secret` and `computer_keep_secret` keep a file's text as one without reading it. After untrusted content, a write with a secret in it asks you, past the review and Safety. A kept value in any tool's output or error shows as its placeholder. Settings → Secrets lists, adds, shows and deletes them (web only). Not tried: a real model asking for one when it should instead of in the chat, and the iOS field outside CI.
- **Scripts** (2026-11-09): a bot saves fixed steps as JSON (`script_save`: tool calls, if, each, set, add, notify, post, a task for what needs judgement, stop), and they run without a model from the chat or a task (`script_run`), a schedule, a watcher (with what it saw as its input), or Run now on its page under Automations. A script that changes things is approved once as it's written, by the chat's approval or by saving it yourself; its runs then skip the review, while money, accounts, home access and careful marks still ask every run. After the same tool calls in 3 replies in 30 days, the bot offers once to save them as one. Not tried: whether the model writes working scripts, offers them when it should, and runs one instead of doing it by hand.
- **iOS look** (2026-11-10): the web's Material 3 Expressive in the page (Google Sans, the lime's tinted surfaces, pill buttons, segmented lists, the drawer as Material's) and Liquid Glass only on bars, menus and what floats over the page, as Google's iOS apps do. Not tried: any of it on a device or in Xcode (only `swiftc -parse` here); whether `.bold()` and `.fontWeight` on Google Sans pick its bold and semibold faces; and whether the tiles get the section's rounded corners outside.
- **Clearing a chat** (2026-11-06): Clear chat on a bot's or group's page deletes its messages, files, summary and threads for good (incognito and tasks stay); for a bot other than Hatbot, its `bots/<id>/` notes too if you tick it, as a commit in Memory. Not tried: the iOS buttons outside CI.

## 2. Small gaps
- Your computers: no settings page for them in the iOS app, and Teach works only on the desktop.
- Box secrets can only be set in the web app: the iOS app ignores `BoxDetail.secrets`.
- The iOS app decodes negotiation events but doesn't show negotiations.
- Scripts: the iOS app doesn't list them or pick one for a schedule; webhook triggers can't run one; repeats are noticed only in the chat, not across a schedule's task runs.

---

## 3. Negotiation
Hatbot haggles on OLX, Allegro Lokalnie and Vinted as the Haggler bot, inside a mandate, with market data from Scout (`../scout`) over the MCP plugin. N1 and N2 are built (2026-10-16) and tested against a stand-in desktop-agent and Scout, but not tried live: there's no marketplace account yet.

Built 2026-10-26, not tried live: `negotiate_inspect` (a listing's live page and up to 5 photos, read from the desktop, which needs Update for `/fetch/image`), the search method in Scout's notes (keep looking until a listing meets every must-have), and N4, several sellers at once under one approval, where the first agreement ends the others. The sellers it drops aren't told; a short "bought elsewhere" would need a send past the mandate check. Photos are picked by the marketplaces' image hosts and page order, checked against one page from each site on 2026-10-26.

Built 2026-10-31, not tried live: the opening offer is 90% of the asking price (the target when that's lower), since sellers ignored lower ones; and on Vinted and OLX a message with a price first goes as the site's own offer, through its offer button, with the price box checked to hold exactly the approved price, once. The buttons' labels (Zaproponuj cenę, Make an offer) are from memory, not checked on a live page. Allegro Lokalnie has no offer button: there the price goes in the chat only. Since 2026-11-04 an answer that's only a price, or yes to the other side's offer through the site, can go with `offer_only`: the site's offer button, or the Accept button (Akceptuj, Accept) on their offer at exactly the agreed price, goes alone, and the text only where there's no button. The Accept button's labels are from memory too.

Built 2026-11-02, not tried live: N3, waking (`negotiate/inbox.ts`). Every 10 minutes, while a negotiation has written to a seller (or for two weeks after a deal), the brain reads `scout_inbox` without the model, and `scout_conversation` for each of its conversations that changed. A seller's new message is recorded and screened like a desktop read's, and starts a short task that answers it; at night it waits for 08:00. A read on the desktop is answered by whoever asked for it. Our message unanswered for a day starts a task that nudges the seller once, and the next day gives up. Letting a held negotiation carry on wakes the bot too. Scout's answers to our offers through the site's button (accepted, declined) count as the seller's. Not checked: how Scout's message ids and texts line up with what the desktop reads on a real conversation.

Built 2026-11-02, not tried live: N5, selling (`negotiate/selling.ts`). Where a listing Hatbot posted is up, the inbox read also looks at conversations where we're the seller. One about our listing (by the id in its address, else by its exact title) opens a negotiation of its own at once, since marking the flip ready was the go-ahead: asking at the posted price, with a floor of Scout's break-even plus the margin in Settings (10% by default, never above the asking price), and a task answers the buyer from the listing as posted. A price under the floor asks. Every buyer of one flip shares a want, so the first agreement ends the others: they're sent a fixed "it's sold" through the send gate, Scout records the sale (`scout_flip_update`, which needs Allow), and the chat says it's coming off the other marketplaces (L5). Not checked: whether OLX's and Vinted's ids in Scout match the listing addresses, and the sellers' side of the offer buttons. Buyers aren't nudged, and a closed one who writes again is left alone.

### 3.1 Milestones
- **N1, finish**: once Haggler has its own marketplace account, show it one negotiation per site (teach-by-showing) for its playbook skill. Done when one OLX negotiation runs end to end.
- **N3, live**: done when a seller's reply gets an answer within 15 minutes, with nobody in the chat, on a real account.
- **N5, live**: done when a buyer on a real listing gets an answer and a sale is recorded in Scout.
- **N6, listing** (planned 2026-10-22): you mark a flip "Ready to list" in Scout, and Haggler posts it on the marketplaces you picked without asking again. See 3.3.
- **Maybe later**: `scout_send_message`, if sending from the desktop turns out too slow.

### 3.2 Scout's part
Built in Scout (price reference, comparables, outcomes and the listing detail's negotiation block on 2026-10-16), in the shapes the brain reads; Hatbot's Scout plugin offers them since 2026-11-11. Read tools, all `readOnlyHint`:
- **`scout_price_reference {query, sources}`** → `best.{typicalPrice, p25, samples, name, basis, ready}`: the appraisal's typical price; when it has none, the appraisal uses `scout_watch_analytics`.
- **`scout_comparables {listingKey}`** → `comparables[].{title, price, url}`: live alternatives for the same item, the fallback and honest leverage.
- **`scout_listing_detail`** has a `negotiation` block (days listed, price drops, the negotiable flag, the seller and their other listings, relists), `live: true` to check the listing on the marketplace now and `sellerListings: true`. The brain reads `listing.{url, title, price, marketplace, typical, watchId, priceNegotiable, postedAt|firstSeenAt}` and `history[].{price, observedAt}`. Still to do: check the listing with `live: true` before an offer and before paying (P1-3).
- **`scout_inbox(marketplace, since?)`** and **`scout_conversation(id)`**, through Scout's stored marketplace sessions (N3, built in Scout): Scout's plugin offers them to the brain alone; over the MCP plugin they need Chat.

For logins (built in Scout, 2026-10-26): **`scout_shared_sessions`** → `sessions[].{marketplace, label, revision}` and **`scout_shared_session {marketplace}`** → `{revision, storageState}`, Playwright storage state. Only connected apps get them, only for the sessions you shared, and the brain alone calls them (`desktop/logins.ts`); desktop-agent takes cookies only for the marketplaces' sites.

One write tool:
- **`scout_record_outcome {negotiationId, listingKey, outcome, price, asking, currency}`**: the final price, kept apart from Scout's asking-price statistics, as flips are, and shown as a figure of its own ("you pay about 84% of asking for GPUs on OLX"). The brain sends it when the bot closes a buying negotiation with `negotiate_close`, keyed `hatbot:<id>`, in PLN only. Scout's plugin offers it to the brain alone; over the MCP plugin it needs Allow.

For N6, Scout's handoff is `../scout/docs/hatbot-listing-plan.md`. In short:
- `scout_flips_to_list` (read): flips marked ready, each with `id, updatedAt, channels[]` and each channel's `{status, url?, error?}`.
- `scout_flip {id}` (read): `title, description, condition, category, delivery, prices{channel}, photos[].id`.
- `scout_flip_photo {id}` (read): one photo, `{mime: "image/jpeg", base64}`, as text, since the MCP plugin drops image content.
- `scout_flip_listed {flipId, channel, status, url?, error?}` (write): the outcome of one channel, `listed`, `failed` or `declined`. Haggler needs it on Allow.
- `scout_flips_to_take_down` (read): sold flips still up where Hatbot posted them, other than where they sold and what the owner ticked, each `{id, title, soldOn, saleChannel, channels[{channel, url}]}` (L5).
- `scout_flip_taken_down {flipId, channel}` (write): ticks one in Scout's delist checklist; refused once the sale is taken back. Haggler needs it on Allow.
- No word for selling in their descriptions: the MCP plugin's money words would make them purchases, and the brain couldn't read them.

### 3.3 N6, listing
You mark a flip ready in Scout and pick channels, which is the approval; Haggler posts it on each channel and Scout gets the URLs back. Haggler only, since it holds the marketplace logins. Blocked live on the same thing as N1: Haggler's own accounts.

**L1, Scout** (in Scout's repo, from its handoff; started in Scout's own T3 thread on 2026-10-24): the ready state, the four tools above, the button on the web and iOS, and delivery details (Vinted's parcel size, OLX and Allegro Lokalnie delivery and pickup) in the listing draft.

L2 (photo uploads on the add-listing pages) and L3 (the lister, `apps/brain/src/listings/`) are built (2026-10-24) and tested against a stand-in Scout and desktop-agent, not live. Not checked yet: the add-listing pages' addresses (`UPLOAD_PAGES` in `packages/shared/src/desktop.ts`) and their publish buttons' labels (`listings/gate.ts`).

Scout is connected with a button: Settings → Plugins → Scout (2026-10-25). Scout's side, the sign-in (MCP's OAuth with PKCE) and Connected apps, is being built on its `feat/hatbot-listing` branch.

**L4, live.** Once L1 and the sign-in are in Scout, connect it. Teach Haggler one listing per site, for its playbook skills ("list on OLX", "list on Allegro Lokalnie", "list on Vinted"); categories and delivery are where it'd stumble. Done when one real flip goes from "Ready to list" to a live OLX listing with its URL in Scout, with nobody at the keyboard after marking it.

**L5, taking a sold flip down** (built 2026-11-05, tested against a stand-in Scout and desktop, not live; Scout's side merged as its PR #39). Recording the sale is the go-ahead, whether the owner records it in Scout or Haggler does (N5). Each tick reads `scout_flips_to_take_down`, and each listing to take down gets a row in `flip_takedowns` and a desktop task of its own, "Take down on OLX: …", ahead of any posting. Where it sold is left up: the buyer may still be paying there. Only listings Hatbot posted, so ones with a URL in Scout; one listed by hand isn't touched. The task opens the listing; if it's gone already, it says so with `record_taken_down`, otherwise it ends it with the site's own button ("Zakończ" on OLX and Allegro Lokalnie, "Usuń" on Vinted) and then says so. Its gate (`takeDownRefused`) keeps it on that marketplace, off the add-listing page, and to short typing; a delete or a confirmation goes through `confirm_intent` and the review as usual. The brain then ticks it in Scout. A task that ends without `record_taken_down` isn't tried again: the chat says to take it down by hand. A listing the owner ticks first, or a sale taken back, drops its row and stops its task. Not checked: the sites' end buttons and their confirmation steps; a skill per site (`take-down-on-olx`) can teach them.

**Not in N6:** answering buyers (N5), editing or relisting a live listing, and paid promotion.

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
- Research keeps the pages its helpers fetched only for the run: a refresh, or a run a restart cut short, fetches them again.
- Settings → Plugins, Approvals and guardrails, and teach mode stay web-only; the iOS app has only the safety review's switch.
- To-do items aren't handed to other bots with `@name`; ask the bot in the chat instead.
- Your computers: what's on their screens isn't read or screened for prompt injection, only window titles are noted; the task is tainted by the first screenshot, so its consequential steps ask anyway. `computer_get_file` refuses private keys and password stores rather than asking.
- Secrets: hiding them in tool output matches the value exactly, so one encoded, split or shorter than 6 characters still shows, and screenshots aren't hidden at all. A secret written into the sandbox can be sent anywhere by a later `code_run`, which reaches the internet. Hiding guards against accidents, not against a model working to read one.
- T3 Code: its sign-in lasts 30 days with no refresh, so it has to be connected again; threads to carry on are kept in memory, which a restart forgets; a box's files over 100 KB can't be handed to it in one message.

**Not planned:**
- Messengers (Signal, Telegram, Matrix): Hatbot's own web and iOS apps are enough.
- Email and calendar, until after v1. Proton Bridge needs a paid Proton plan.
- Open-ended goals, and more than one user.
- Boxes shared by public link, WebSockets from box backends, and box languages other than TypeScript.

## 5. Maybe later
- Teams.
- The desktop as a KVM VM instead of an LXC, if RAM allows.
