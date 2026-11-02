# Hatbot against its competitors — gaps, fixes and small wins

Researched 2026-11-02 against live docs, repos and the code. The competitors are
**OpenAI Dots**, **Grok Bot** (xAI), **Hermes Agent** (Nous Research) and
**OpenBot**. "OpenBot" is ambiguous, so both real ones are covered: CopilotKit's
governance-first OpenBot and nightly-labs' local-first OpenBot.

Web search was down for part of the research (the search API returned HTTP
402), so several claims come from direct fetches of primary sources. Press
coverage is marked as such.

---

## 0. The finding that reframes this

All four are **always-on agents that do background work while you're away,
have their own computer, and let you watch and take over**. Hatbot already has
that core: desktop tasks with a live MJPEG view and takeover
(`routes/desktop.ts`, `desktop/service.ts`), teach-by-demonstration
(`teach/`), model-reviewed approvals (`agent/review.ts`: Haiku, then Opus),
schedules, triggers and watchers. So the missing things are not the headline
features. They are the **edges**: identity, input, output, notification,
recovery and cost.

Where Hatbot is already ahead, and should say so:

| Hatbot | The others |
|---|---|
| Owns its data; the brain is yours, on your homelab | Dots is cloud-only and **not sold in the EEA, Switzerland or the UK**; Grok Bot is cloud-only, "on-premises not supported" |
| Claude-only, one owner, no multi-provider sprawl | Grok Bot has no model picker at all |
| Untrusted-content taint, screenshot-and-approve, a model-reviewed gate on top of static policy | No competitor markets taint tracking |
| One price, your API key; spend ledger with per-reply and per-task cost | Dots starts at $100/month; ChatGPT agent caps Plus at 40 messages/month |
| Self-hosted, MIT, no copyleft | OpenBot (CopilotKit) needs a CopilotKit "Intelligence" license key; OpenBot (nightly) runs agents with `danger-full-access` by default |

---

## 1. Feature matrix (✔ has it · ◐ partial · ✘ doesn't)

| Area | Hatbot | OpenAI Dots | Grok Bot | Hermes Agent | OpenBot (CopilotKit / nightly-labs) |
|---|---|---|---|---|---|
| Self-hosted | ✔ | ✘ cloud only | ✘ cloud only | ✔ or Nous Portal | ✔ (needs CopilotKit key) / ✔ local app |
| Platforms | web, iOS, Linux GTK | web (desktop only), macOS/Win, iOS/Android, Slack, Teams, SMS | desktop, iOS, Android, X, Slack | TUI, desktop, web dashboard, 25+ chat apps | web + Slack/Teams/SMS / Electron + iOS + Android |
| Background/always-on tasks | ✔ tasks, boxes | ✔ its whole premise | ✔ | ✔ + kanban, `/bg` | ✔ |
| Computer use + live takeover | ✔ | ✔ take over / return | ✔ preview + take over | ✔ preview + Bot Screen | ✔ take the wheel / ✔ |
| Scheduling | ✔ cron + one-shot schedules | ✔ | ✔ routines, 50 per bot | ✔ cron, per-job models | ✔ routines / ✔ + webhooks |
| Event triggers | ✔ webhook + Uptime Kuma; **model can't create them** | ✔ Gmail, Slack, GitHub | ✔ Slack, GitHub, Linear, Sentry, PagerDuty, email, webhook | ✔ webhook routes, `no-agent` scripts | ✔ app events / ✔ webhooks |
| Approvals | ✔ 10 kinds, phone approve/deny, Haiku→Opus review, always-allowed rules | ✔ Custom Rules + auto-review | ✔ Auto Review + Ask-first/Allow rules | ✔ smart/manual/off + hardline blocklist | ✔ policy gateway / manual |
| Who started it, to policy | ◐ the task/user reaches `policy(input, task)`, but no refusal audit | ✘ | ✘ | ◐ fail-closed for cron | ✔ `initiator.*` CEL; ✔/✘ |
| Audit of what was refused | ✘ | ✘ | ✘ | ✘ | ✔ (with the rule named) |
| Memory | ✔ git repo, owner-revertable | ✔, delete only with the dot | ✔ per bot, no screen | ✔ bounded MEMORY.md/USER.md, frozen per session | ✔ / ✔ per agent |
| MCP | ✔ (stdio/HTTP, arbitrary servers) | ◐ Business/Enterprise only | ✔ remote | ✔ OAuth, catalog, allowlists | ✔ / ✔ |
| Built-in connectors | via MCP plugins | ✔ ~4,000 apps | ✔ Gmail, Drive, Notion, 1Password… | ✔ catalog | ✔ |
| **Voice** | ✘ | ✔ call your dot | ✔ voice chat, memos | ✔ wake word, barge-in, Discord voice | ✘ / ✘ |
| **Image generation** | ✘ (charts, matplotlib) | ✔ | ✔ Imagine | ✔ | ✘ / ✘ |
| Documents as output | ✘ | ✔ docs/sheets/slides | ◐ | ◐ | ✘ |
| Messaging surfaces | ✘ on purpose (PLAN §4) | ✔ SMS/Slack/Teams | ✔ X Chat, Slack | ✔ 25+ | ✔ |
| Own email address | ✘ (PLAN §4: no email) | ◐ personal mailbox | ✔ `@mail.grokbot.com` | ✔ gateway | ✘ |
| Vault / secrets never seen | ✔ secrets store + take-over for cards | ✔ Secure Forms | ✔ Vault, 1Password | ✔ browser vault | ✔ encrypted write-only |
| Bots with their own identity & memory | ✔ bots, groups, `ask_bot` | ◐ specialist dots | ✔ roster, primary bot | ✔ profiles, Bot Mode | ◐ dept bots |
| Bot-to-bot async hand-off | ✔ `ask_bot` | ✔ | ✔ | ✔ `message_agent`, `hermes peer` | ◐ channels |
| Skills | ✔ teach-by-showing, `skills/` | ◐ | ✔ Teach a task | ✔ auto-created | ✔ library |
| Export/backup, portability | ◐ memory is git; **no export** | ◐ data export, incomplete | ✘ | ✔ git-tracked memory | ✔ import from Grok/Hermes |
| Cost visibility | ✔ spend page, limits, per-task | ✘ | ✘ | ✔ per-job stats | ✘ / ✘ |
| Multi-user/teams | ✘ on purpose | ◐ | ✔ shared bots | ✔ gateway allowlists | ✔ / ✘ |

---

## 2. Gaps that matter, ranked

### Tier 1 — the competitors' headline differences, but each has a catch

1. **Voice in and out.** Every big consumer agent has it now (Dots lets you
   call it; Hermes has a wake word and barge-in). It is the single most visible
   gap on a phone. A cheap version that fits Hatbot: hold-to-talk in the iOS
   app and web using the OS speech APIs (no keys, no new dependency), putting
   the transcript in the composer for you to edit. Push-to-talk only; not
   hands-free. ⚠️ Needs a decision first: sending audio or transcripts of what
   you say to Apple/Google is a privacy choice the owner should make, and
   iOS's `requiresOnDeviceRecognition` keeps it on the phone at a quality
   cost. **Not built; owner's call.**

2. **An agent's own email address as an input.** Dots (mailbox) and Grok Bot
   (`@mail.grokbot.com`, with plus-aliases for routines) both turn a mail
   address into a trigger and an inbox. Hatbot leaves email out on purpose
   (PLAN §4: Proton Bridge needs a paid plan; no email). The gap is real, but
   it is a PLAN decision, not an oversight.

3. **Messaging surfaces.** Hermes' 25+ chat apps, Dots' SMS/Slack/Teams and
   Grok Bot's X Chat all meet people where they already are. Hatbot's own
   answer is its web, iOS and Linux apps (PLAN §4). Worth revisiting only as
   a bridge over the existing ntfy channel, or through MCP.

4. **Documents as deliverables.** Dots makes docs, sheets and slides as
   first-class outputs; OpenBot too. Hatbot has charts, files from tasks, and
   boxes (mini web apps). A one-page "make me a PDF/DocX and hand it to me"
   is a `send_file` away if a converter runs in the Code sandbox; Hatbot
   already has the delivery half.

### Tier 2 — genuinely missing, cheap, and fits the product

5. **Event triggers the model can create.** Dots, Grok Bot and Hermes (even
   with script-only `no-agent` jobs) let the agent wire "when my pull request
   opens" or "when a seller replies" itself. In Hatbot the model can only
   list and adjust triggers, never create one (`trigger_list`,
   `trigger_update`); the owner makes webhooks by hand. Biggest automation gap
   after voice.
6. **Image generation.** Dots, Grok, Hermes all have it. Hatbot draws charts
   and matplotlib figures in a sandbox, which covers "make me a graph", but
   not "make me a picture".
7. **Audit of refusals.** Every refused or denied action, with the rule that
   refused it. Only CopilotKit and Kortix have it, so it would be a
   differentiator, not catch-up. Fits Hatbot's approval architecture
   (`approvals` table already records the kind and decision).
8. **Export.** Memory is a git repo you own, but **chats, tasks, boxes and
   spend can't be taken out**. Nightly-labs OpenBot even imports from Grok Bot
   and Hermes; Hatbot has no import either. Good against lock-in; most of
   this is already in SQLite.
9. **Per-task cost at a glance in chat.** Tasks show it on their own page
   (`Tasks.tsx:258`) and the reply shows live usage, but a row of past tasks
   carries none. Cosmetic next to (7), same mental model.

### Tier 3 — small UX and reliability wins found in the code

These are the "one-line misses" the audit turned up. Several are already
fixed in this session (see §3).

- ✅ **Continue a stopped reply.** `/stop` and Pause cut a reply off with no
  way to go on: only failed replies had "Try again". Fixed (see §3).
- **No command palette.** ⌘K goes to search only. A palette over searches,
  chats, boxes, tasks and commands (the app already has `matchingCommands`)
  would be a day's work.
- **No rename, folders or pinning for conversations.** Groups can be
  renamed (`updateGroup`), single chats cannot.
- **No web push.** Notifications only through ntfy.
- **No resuming after a failed task other than rerun**; no "continue" for a
  truncated reply other than the new command.
- **No duplicate for schedules and watchers.**
- **No artifact viewer.** Code that writes an HTML page ends up in a box
  (§ `box_create`); there is no "show this HTML here" outside boxes.
- **PLAN §2 items**: box secrets only in web, negotiations not shown on iOS.
- **OpenBot's initiator-aware policy.** `policy(input, task)` sees the task,
  but nothing tells the plugin whether a person or a schedule started it, so
  a rule can't refuse an unattended run what it allows a person. Small,
  contained change to the `CallContext`.

---

## 3. Built in this session

**Chat: `/continue` carries on a reply `/stop` cut off, from where it
stopped** (`9ae6e5d`). A stopped reply keeps what it wrote and ends in
`_Stopped._`; the new Continue action (web and iOS) or `/continue` writes it
on **in place**: what it had goes in as its own turn, then a no-message turn
saying to carry on, so the bot resumes instead of repeating itself. A reply
cut off by a restart works the same way. Asked while a reply is still being
written, it says to stop it first, and answers at once instead of queueing
behind the reply (`enqueue`), which would never run until the reply ended.

Tests: `apps/brain/test/thread.test.ts` —
"`/continue` goes on from where a stopped reply got to, and says why when it
can't" and "`/continue` while a reply is still being written says to stop it
first".

---

## 4. If three things were built next

1. **Voice-to-text in the composer, push-to-talk only** (iOS + web, on-device
   where possible), since it is the one consumer-grade feature every
   competitor has and Hatbot has none. Owner's call on privacy.
2. **`trigger_create` and a trigger the model can wire**, because every rival
   turns events into routines without the owner.
3. **A refusal audit in Settings → Safety** (what was refused, by which rule,
   when), to make the strongest part of Hatbot visible instead of implicit.

---

## Sources

OpenAI Dots and ChatGPT agent: [Dots feature page](https://chatgpt.com/features/dots/),
[Dots help](https://help.openai.com/en/articles/20001530), [ChatGPT agent help](https://help.openai.com/en/articles/11752874-chatgpt-agent),
[Dots safety](https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/),
[scheduled tasks](https://help.openai.com/en/articles/10291617), [custom MCP (Business/Enterprise only)](https://help.openai.com/en/articles/12584461),
[Atlas retirement](https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work),
[Operator](https://openai.com/index/introducing-operator/),
[pricing/launch coverage](https://www.theverge.com/ai-artificial-intelligence/1003399/meta-openai-ai-agents-muse-dots-battle).

Grok Bot: [overview](https://docs.x.ai/grok-bot/overview), [computer and apps](https://docs.x.ai/grok-bot/computer-and-apps.md),
[approvals, security and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy.md),
[skills, routines and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations.md),
[chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration.md), [bots](https://docs.x.ai/grok-bot/bots.md),
[shared bots](https://docs.x.ai/grok-bot/shared-bots.md), [mobile](https://docs.x.ai/grok-bot/mobile.md), [FAQ](https://docs.x.ai/grok-bot/faq.md).

Hermes Agent: [repo](https://github.com/NousResearch/hermes-agent), [docs](https://hermes-agent.nousresearch.com/docs/),
[tools reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference),
[memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory),
[cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron),
[MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp),
[voice mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode),
[security](https://hermes-agent.nousresearch.com/docs/user-guide/security),
[bot mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode).

OpenBot: [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot), [nightly-labs/openbot](https://github.com/nightly-labs/openbot),
[openbot.run](https://openbot.run/), [meetopenbot/openbot](https://github.com/meetopenbot/openbot), [regnull/openbot](https://github.com/regnull/openbot).

Ecosystem comparison: [LibreChat](https://github.com/LibreChat-AI/LibreChat), [Open WebUI](https://github.com/open-webui/open-webui),
[Goose](https://github.com/aaif-goose/goose), [Letta](https://github.com/letta-ai/letta-code),
[Kortix](https://github.com/kortix-ai/suna), [OpenHands](https://github.com/OpenHands/OpenHands), [Khoj](https://github.com/khoj-ai/khoj).
