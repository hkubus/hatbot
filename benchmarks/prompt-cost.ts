// The tokens one chat turn and one background task send to the model, as the brain builds them.
// Nothing is billed: FakeModel records each request it was given.
//
//   bun benchmarks/prompt-cost.ts
//   ANTHROPIC_API_KEY=… bun benchmarks/prompt-cost.ts
//
// With a key, Anthropic's token counting (free) counts each part. Without one it's four
// characters a token, which comes out at about half the real count. Deferred tools cost nothing
// until the model's tool search loads them, so they're counted on their own; server tools (web
// search, tool search) can't be counted, so they're only numbered.
import { PLUGINS } from "../apps/brain/src/plugins";
import { FakeModel, text } from "../apps/brain/test/fake-model";
import { bot, testApp } from "../apps/brain/test/helpers";

type Tool = { name?: string; type?: string; defer_loading?: boolean };
type Request = {
  model: string;
  system?: unknown;
  tools?: Tool[];
  messages: unknown[];
};
type Parts = {
  system: number;
  tools: number;
  toolsN: number;
  deferred: number;
  deferredN: number;
  messages: number;
  server: number;
};

const key = process.env.ANTHROPIC_API_KEY;
// The SDK is the brain's dependency, not the repo root's.
const { default: Anthropic } = await import(
  Bun.resolveSync("@anthropic-ai/sdk", `${import.meta.dir}/../plugins/anthropic`)
);
const client = key ? new Anthropic({ apiKey: key }) : null;

const estimate = (v: unknown) =>
  !v || (Array.isArray(v) && !v.length) ? 0 : Math.ceil(JSON.stringify(v).length / 4);
const PING = [{ role: "user", content: "hi" }];

async function partsOf(r: Request): Promise<Parts> {
  const all = r.tools ?? [];
  const own = all.filter((t) => !t.type || t.type === "custom");
  const loaded = own.filter((t) => !t.defer_loading);
  const deferred = own.filter((t) => t.defer_loading).map(({ defer_loading, ...t }) => t);
  const counts = {
    toolsN: loaded.length,
    deferredN: deferred.length,
    server: all.length - own.length,
  };
  if (!client)
    return {
      system: estimate(r.system),
      tools: estimate(loaded),
      deferred: estimate(deferred),
      messages: estimate(r.messages),
      ...counts,
    };
  const count = async (p: { system?: unknown; tools?: unknown[]; messages: unknown[] }) =>
    (await client.beta.messages.countTokens({ model: r.model, ...p })).input_tokens;
  const system = r.system;
  const [bare, sys, withTools, full, withDeferred] = await Promise.all([
    count({ messages: PING }),
    count({ system, messages: PING }),
    count({ system, tools: loaded, messages: PING }),
    count({ system, tools: loaded, messages: r.messages }),
    deferred.length ? count({ system, tools: [...loaded, ...deferred], messages: PING }) : 0,
  ]);
  return {
    system: sys - bare,
    tools: withTools - sys,
    deferred: deferred.length ? withDeferred - withTools : 0,
    messages: full - withTools + bare,
    ...counts,
  };
}

const pad = (n: number, w: number) => String(n).padStart(w);
async function show(label: string, r: Request | undefined) {
  if (!r) throw new Error(`${label}: no request was made.`);
  const p = await partsOf(r);
  console.log(
    `${label.padEnd(36)} ${pad(p.system + p.tools + p.messages, 7)} tok  system ${pad(p.system, 6)}` +
      `  tools ${pad(p.tools, 6)} (${pad(p.toolsN, 3)})  deferred ${pad(p.deferred, 6)} (${pad(p.deferredN, 3)})` +
      `  messages ${pad(p.messages, 5)}  server tools ${p.server}`,
  );
}

const startsTask = () =>
  new FakeModel([
    {
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "run_task",
          input: { title: "Look", goal: "Look at the NAS" },
        } as never,
      ],
    },
    { content: [text("Started it.")] },
    { content: [text("The NAS is fine.")] },
  ]);
const finishes = () =>
  new FakeModel([
    {
      content: [
        {
          type: "tool_use",
          id: "toolu_3",
          name: "finish_task",
          input: { outcome: "done", summary: "The NAS is fine.", notify: false },
        } as never,
      ],
    },
  ]);

console.log(
  client
    ? "Counted by Anthropic's token counting, for each request's model."
    : "Estimated at four characters a token; set ANTHROPIC_API_KEY to count them.",
);

{
  const model = new FakeModel([{ content: [text("Hello there.")] }]);
  const t = await testApp(model);
  await t.thread.post("hi").done;
  await show("chat: first turn", model.requests[0]);
}

{
  const model = new FakeModel([
    {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "search_history",
          input: { query: "zebras" },
        } as never,
      ],
    },
    { content: [text("Found it.")] },
  ]);
  const t = await testApp(model);
  await t.thread.post("what did we say about zebras").done;
  await show("chat: turn with a tool result", model.requests[1]);
}

{
  const chat = startsTask();
  const work = finishes();
  const t = await testApp(chat, work);
  await t.thread.post("check the nas").done;
  await t.tasks.idle();
  await show("task: first turn", work.requests[0]);
}

{
  // A bot with no desktop and no boxes can't use their tools: they aren't sent, nor deferred.
  const model = new FakeModel([{ content: [text("Hi.")] }]);
  const t = await testApp(model);
  t.agent.configured = false;
  t.hatbox.configured = false;
  await t.thread.post("hi").done;
  await show("chat: no desktop, no boxes", model.requests[0]);
}

// Every first-party plugin on, for a bot that has them all (plugins: null), as a sysadmin bot does.
const ENV = {
  PROXMOX_URL: "https://192.168.55.10:8006",
  PROXMOX_NODE: "pve",
  PROXMOX_TOKEN_ID: "hatbot@pve!brain",
  PROXMOX_TOKEN_SECRET: "x",
  PROXMOX_TLS_FINGERPRINT: "AB:CD",
  PBS_URL: "https://192.168.55.11:8007",
  PBS_TOKEN_ID: "hatbot@pbs!brain",
  PBS_TOKEN_SECRET: "x",
  PBS_TLS_FINGERPRINT: "AB:CD",
  HOMEASSISTANT_URL: "http://192.168.55.12:8123",
  HOMEASSISTANT_TOKEN: "x",
  UPTIME_KUMA_URL: "http://192.168.55.13:3001",
  UPTIME_KUMA_API_KEY: "x",
  FORGEJO_URL: "https://git.example",
  FORGEJO_TOKEN: "x",
  GITHUB_TOKEN: "x",
  HATBOT_SELF_REPO: "owner/hatbot",
  T3_TOKEN: "x",
  SCOUT_TOKEN: "x",
};
const CONFIG: Record<string, unknown> = {
  ssh: {
    hosts: [
      { name: "proxmox", address: "192.168.55.113", proxmox: true },
      { name: "vps", address: "192.168.55.114" },
    ],
  },
  scout: { url: "https://scout.example" },
  t3: { url: "https://t3.example" },
};
async function everything(chat: FakeModel, work: FakeModel, plugins: string[] | null) {
  const t = await testApp(chat, work, {}, PLUGINS, ENV);
  for (const p of t.plugins.list())
    await t.plugins.update(p.id, {
      enabled: true,
      ...(CONFIG[p.id] ? { config: CONFIG[p.id] } : {}),
    });
  const b = bot(t, "Sysadmin");
  if (plugins) t.bots.update(b.id, { plugins });
  return { t, thread: t.chats.direct(b.id) };
}

{
  const chat = startsTask();
  const work = finishes();
  const { t, thread } = await everything(chat, work, null);
  await thread.post("check the nas").done;
  await t.tasks.idle();
  const on = t.plugins.list().filter((p) => p.state === "ready");
  console.log(`\nEvery plugin that comes up here: ${on.map((p) => p.id).join(", ")}`);
  await show("every plugin: chat, first turn", chat.requests[0]);
  await show("every plugin: task, first turn", work.requests[0]);
}

{
  const chat = startsTask();
  const work = finishes();
  const { t, thread } = await everything(chat, work, ["scout", "research"]);
  await thread.post("check the nas").done;
  await t.tasks.idle();
  await show("marketplace bot: chat, first turn", chat.requests[0]);
  await show("marketplace bot: task, first turn", work.requests[0]);
}

process.exit(0);
