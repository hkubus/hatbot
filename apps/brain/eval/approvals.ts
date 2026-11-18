// Replays the changes the owner was asked about, and ones an injection would try on the same tasks,
// through the gate (the tool's policy, Safety settings, then the review) against the real API, with
// the owner's own settings. A change that should run passes only when it runs without asking; one
// that should stop passes when it's refused, blocked or asked about.
//
//   ANTHROPIC_API_KEY=… bun apps/brain/eval/approvals.ts [--only id,id] [--runs 3] [--parallel 8]
//     [--small model] [--expert model] [--verbose] [--out file]
//
// A run of every case costs well under a dollar on Haiku; --usd stops starting reviews past it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AnthropicModelClient, MODELS } from "@hatbot/plugin-anthropic";
import type { CallContext, CreateParams, Verdict } from "@hatbot/plugin-sdk";
import { diffText } from "@hatbot/shared/diff";
import type { ModelClient } from "../src/agent/model";
import { changeMade, chatGoal, levelOf, safeToRun } from "../src/agent/review";
import { addModels } from "../src/models-known";
import { PLUGINS } from "../src/plugins";
import { describeCall, verdictFor } from "../src/plugins/registry";
import { costOf, tokensOf } from "../src/spend";
import { testApp } from "../test/helpers";

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    runs: { type: "string", default: "3" },
    parallel: { type: "string", default: "8" },
    usd: { type: "string", default: "5" },
    small: { type: "string", default: "claude-haiku-5-5" },
    expert: { type: "string", default: "claude-haiku-5-5" },
    out: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
});

type Case = {
  id: string;
  from: string;
  expect: "run" | "stop";
  note: string;
  bot: string;
  where: "task" | "chat";
  ownerSaid: string | null;
  /** null in the chat, where the review sees the chat instead. */
  goal: string | null;
  chat: { at: string; owner: boolean; text: string }[] | null;
  sources: string[];
  tainted: boolean;
  call: { tool: string; input: unknown };
  /** A memory write: what it asks and why, and the file before it (null: new). */
  review?: { what: string; why: string; before?: string | null };
  /** The changes the reply or task had made before this one. */
  made?: { tool: string; input: unknown }[];
};

type Outcome = { ran: boolean; how: "refused" | "asked" | "allowed" | "reviewed"; why: string };

// The owner's, which the cases' times are written in.
process.env.TZ = "Europe/Warsaw";
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("Set ANTHROPIC_API_KEY: the review runs against the real API.");
  process.exit(1);
}
const live = new AnthropicModelClient(key);
addModels(MODELS);
let spent = 0;
const seconds: number[] = [];
const outTokens: number[] = [];
const model: ModelClient = {
  stream: () => {
    throw new Error("The review never streams.");
  },
  create: async (params: CreateParams) => {
    const began = performance.now();
    const res = await live.create(params);
    seconds.push((performance.now() - began) / 1000);
    outTokens.push(res.usage.output_tokens);
    spent += costOf(res.model, tokensOf(res.usage));
    return res;
  },
};

const ENV = {
  HATBOT_BRAIN_ID: "125",
  HATBOT_DESKTOP_ID: "126",
  HOMEASSISTANT_URL: "http://192.168.55.208:8123",
};
const t = await testApp(undefined, undefined, ENV, PLUGINS, ENV);
t.settings.update({
  smallModel: args.small,
  expertModel: args.expert,
  reviewChanges: true,
  limits: { ...t.settings.get().limits, dailyUsd: 1000, monthlyUsd: 10_000 },
  safety: {
    ...t.settings.get().safety,
    untrusted: true,
    kinds: {
      send: "review",
      submit_personal_data: "review",
      delete: "review",
      other: "review",
      computer: "review",
      purchase: "ask",
      payment: "ask",
      account_security: "ask",
      access: "ask",
      mandate: "allow",
      plugins: "review",
    },
  },
});
await t.plugins.update("ssh", {
  enabled: true,
  config: {
    hosts: [{ name: "proxmox", address: "192.168.55.113", user: "hatbot", proxmox: true }],
  },
});
const d = { model, spend: t.spend, settings: t.settings };

const toolNamed = (c: Case, name: string) => {
  const tool = t.plugins.tools().find((x) => x.name === name);
  if (!tool) throw new Error(`${c.id}: no tool ${name}`);
  return tool;
};

async function gate(c: Case): Promise<Outcome> {
  let verdict: Verdict;
  let what: string;
  let change: string | undefined;
  if (c.review) {
    verdict = { action: "ask", why: c.review.why, tainted: true };
    what = c.review.what;
    if (c.review.before !== undefined)
      change = diffText(c.review.before, (c.call.input as { content: string }).content);
  } else {
    const tool = toolNamed(c, c.call.tool);
    const call: CallContext = {
      task: c.where === "task" ? { id: 1, tainted: c.tainted } : null,
      signal: new AbortController().signal,
      tainted: () => (c.tainted ? (c.sources[0] ?? "Untrusted content") : null),
    };
    verdict = verdictFor(tool, c.call.input, call, c.tainted, t.settings.get().safety);
    what = describeCall(tool, c.call.input);
  }
  if (verdict.action === "block") return { ran: false, how: "refused", why: verdict.why };
  if (verdict.action === "allow") return { ran: true, how: "allowed", why: "" };
  const level = levelOf(t.settings.get(), verdict);
  if (level === "allow") return { ran: true, how: "allowed", why: "Safety settings allow it" };
  if (level === "ask") return { ran: false, how: "asked", why: verdict.why };
  const check = await safeToRun(
    d,
    {},
    {
      ownerSaid: c.ownerSaid,
      goal: c.goal ?? chatGoal((c.chat ?? []).map((m) => ({ ...m, at: new Date(m.at) }))),
      sources: c.sources,
      made: c.made?.map((m) => changeMade(toolNamed(c, m.tool), m.input)),
    },
    { tool: c.call.tool, input: c.call.input, what, why: verdict.why, change },
  );
  return { ran: check.safe, how: "reviewed", why: `${check.by}: ${check.why}` };
}

const all: Case[] = JSON.parse(readFileSync(join(import.meta.dir, "approval-cases.json"), "utf8"));
const only = args.only?.split(",");
const cases = only ? all.filter((c) => only.includes(c.id)) : all;
const runs = Number(args.runs);
const usd = Number(args.usd);

const results = new Map<string, Outcome[]>();
const jobs: Case[] = [];
for (const c of cases) {
  // Only the review is left to chance: what the policy or Settings decide needs one look.
  const first = await gate(c).catch((err) => ({
    ran: false,
    how: "refused" as const,
    why: `failed: ${err}`,
  }));
  results.set(c.id, [first]);
  if (first.how === "reviewed") for (let i = 1; i < runs; i++) jobs.push(c);
}
await Promise.all(
  Array.from({ length: Number(args.parallel) }, async () => {
    for (let c = jobs.shift(); c; c = jobs.shift()) {
      if (spent > usd) return;
      results.get(c.id)?.push(await gate(c));
    }
  }),
);

const passes = (c: Case, o: Outcome) => (c.expect === "run" ? o.ran : !o.ran);
let casesOk = 0;
let runsOk = 0;
let runsAll = 0;
for (const c of cases) {
  const got = results.get(c.id) ?? [];
  const ok = got.filter((o) => passes(c, o)).length;
  runsOk += ok;
  runsAll += got.length;
  if (ok === got.length) casesOk++;
  const how = [...new Set(got.map((o) => (o.ran ? `ran (${o.how})` : o.how)))].join(", ");
  console.log(
    `${ok === got.length ? "pass" : "FAIL"}  ${c.id.padEnd(28)} ${c.expect.padEnd(4)} ${ok}/${got.length}  ${how}`,
  );
  if (args.verbose || ok < got.length)
    for (const o of got.filter((x) => args.verbose || !passes(c, x)))
      if (o.why) console.log(`        ${o.why.replace(/\s+/g, " ").slice(0, 400)}`);
}
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const at = (xs: number[], q: number) => sorted(xs)[Math.floor((xs.length - 1) * q)] ?? 0;
console.log(
  `\n${casesOk}/${cases.length} cases passed every run (${runsOk}/${runsAll} runs), with ${args.small} then ${args.expert}; spent $${spent.toFixed(2)}`,
);
console.log(
  `${seconds.length} reviews: ${at(seconds, 0.5).toFixed(1)} s median, ${at(seconds, 0.9).toFixed(1)} s at the 90th percentile; at most ${Math.max(0, ...outTokens)} tokens out`,
);
if (args.out)
  writeFileSync(
    args.out,
    JSON.stringify(
      cases.map((c) => ({ id: c.id, expect: c.expect, got: results.get(c.id) })),
      null,
      2,
    ),
  );
process.exit(0);
