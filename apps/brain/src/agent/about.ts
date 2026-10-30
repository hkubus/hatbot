// hatbot_about: how Hatbot works and how it's set up now, from the running brain, so a bot answers
// questions about itself from what's true rather than from old notes in its memory.
import type { PluginTool } from "@hatbot/plugin-sdk";
import { type Bot, SAFETY_KINDS, type SafetyKind } from "@hatbot/shared";
import type { Tasks } from "../tasks/service";

const HOW = `How Hatbot works
- Hatbot is a brain on the owner's server (a Proxmox guest, or a Debian machine reached over SSH) with plugins, each switched on per bot. Optional guests of its own: the desktop (Chromium and a terminal, which desktop tasks drive) and the boxes guest (the small apps it builds). It never builds or runs code it didn't ship: code runs in the desktop's sandbox, on the boxes guest, or on the owner's computer through T3 Code.
- Every tool either looks or changes something. A change asks the owner only for money (purchases, payments, mandates, offers outside one), account security, home access (locks, the alarm, garage doors, gates), using the owner's own computers (once a task), tools the owner marked "Always ask" or careful, and Haggler's holds. Settings → Safety sets each kind. Every other change goes to the safety review (the small model), which lets it through or blocks it instead of asking; the owner can run a blocked step anyway, once or always. A task stops after 3 blocks in a row or 20 in all.
- Untrusted content is anything from outside: web pages, forge text, command and log output, MCP output, attachments, what boxes give back. Reading it taints the task or conversation; from then on its changes are reviewed with that in mind, and what it reports is marked as data, not instructions.
- An approval nobody answers expires after 24 hours and the task stops. "Always" approvals are kept as rules the owner can see and remove in Settings. A desktop task's message to a person waits 30 seconds for the owner to stop it, unless the owner approved it.
- Pause all (in Settings, or a notification's button) stops running tasks and replies and starts nothing new until resumed.
- Spending has daily and monthly limits for everything; the last part of each is kept for alerts. Research tasks have a limit each; other tasks have none of their own.
- Memory is a git repo of markdown files: every write is a commit the owner can review and revert.
- Every task keeps a timeline of its steps: tool calls, approvals, blocks and notes.
- On a Proxmox install, the brain's API token can audit, power guests on and off, and snapshot Hatbot's own guests. The SSH plugin reaches containers only through /usr/local/sbin/hatbot-pct-exec, which runs one command in one running container and refuses Hatbot's own; the hatbot user's sudo allows that program and nothing else.
- Helpers (ask_helpers) run on the small model with this bot's lookups and the web, and can't change anything.`;

const KINDS: Record<SafetyKind, string> = {
  send: "messages to people",
  submit_personal_data: "personal details in forms",
  delete: "deleting",
  other: "other changes",
  purchase: "purchases",
  payment: "payments",
  account_security: "account security",
  access: "home access",
  computer: "using your computers",
};
const LEVELS = { ask: "asks you", review: "the safety review decides", allow: "goes ahead" };

const usd = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;

export function aboutHatbot(tasks: Tasks, bot: Bot, release: string | null): string {
  const { d } = tasks;
  const s = d.settings.get();
  const spent = d.spend.summary();
  const mine = Object.entries(s.safety.tools);
  const rules = d.approvals.rules().filter((r) => r.botId === bot.id);
  const now = [
    `Now${release ? ` (release ${release.slice(0, 12)})` : ""}`,
    `- ${s.paused ? "Paused: nothing runs until the owner resumes." : "Not paused."}`,
    `- Models: chat ${s.chatModel}, tasks ${s.taskModel}, desktop ${s.desktopModel}, small jobs ${s.smallModel}, hard parts ${s.expertModel}.`,
    `- Spending: ${usd(spent.todayUsd)} of ${usd(s.limits.dailyUsd)} today, ${usd(spent.monthUsd)} of ${usd(s.limits.monthlyUsd)} this month (the last ${usd(s.limits.alertReserveUsd)} kept for alerts); a research task may spend ${usd(s.limits.researchUsd)}.`,
    `- Safety: ${SAFETY_KINDS.map((k) => `${KINDS[k]} ${LEVELS[s.safety.kinds[k]]}`).join("; ")}. After untrusted content, ${s.safety.untrusted ? "every change is checked, even ones that would otherwise go ahead" : "changes are handled as before it"}. The chat runs at most ${s.safety.chatCommands} commands a reply.`,
    ...(mine.length
      ? [
          `- Tools the owner set: ${mine.map(([t, l]) => `${t} ${l === "ask" ? "always asks" : "never asks"}`).join(", ")}.`,
        ]
      : []),
    rules.length
      ? `- Allowed with Always (${rules.length}): ${rules
          .slice(0, 20)
          .map((r) => `${r.summary}${r.schedule ? ` (in "${r.schedule}")` : ""}`)
          .join("; ")}${rules.length > 20 ? "; …" : ""}.`
      : "- Nothing allowed with Always.",
  ];
  return [HOW, now.join("\n"), pluginsOf(tasks, bot)].join("\n\n");
}

/** This bot's plugins that are on, each with what its tools look at and what they change. */
function pluginsOf(tasks: Tasks, bot: Bot): string {
  const { plugins, bots } = tasks.d;
  const by = new Map<string, { name: string; description: string; tools: PluginTool[] }>();
  for (const t of plugins.tools(bot.plugins, bots.leftToOthers(bot))) {
    const p = plugins.pluginOf(t.name);
    const key = p?.id ?? "other";
    const entry = by.get(key) ?? {
      name: p?.name ?? "Other",
      description: p?.description ?? "",
      tools: [],
    };
    entry.tools.push(t);
    by.set(key, entry);
  }
  const lines = [...by.values()].map(({ name, description, tools }) => {
    const looks = tools.filter((t) => t.access === "read").map((t) => t.name);
    const changes = tools.filter((t) => t.access !== "read").map((t) => t.name);
    return [
      `- ${name}${description ? `: ${description}` : ""}`,
      ...(looks.length ? [`  Looks: ${looks.join(", ")}`] : []),
      ...(changes.length ? [`  Changes: ${changes.join(", ")}`] : []),
    ].join("\n");
  });
  return `${bot.name}'s plugins that are on\n${lines.join("\n")}`;
}
