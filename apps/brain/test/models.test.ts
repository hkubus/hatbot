import { expect, test } from "bun:test";
import {
  definePlugin,
  type ModelInfo,
  type ModelMessage,
  type ModelProvider,
  needsSetup,
  ready,
} from "@hatbot/plugin-sdk";
import { z } from "zod";
import { Models } from "../src/agent/models";
import { safeToRun } from "../src/agent/review";
import { priceOf } from "../src/spend";
import { FakeModel } from "./fake-model";
import { signIn, testApp } from "./helpers";
import { stopPluginsAfterEach, track } from "./plugin-helpers";

stopPluginsAfterEach();

const info = (id: string, computerUse: boolean): ModelInfo => ({
  id,
  name: id,
  price: { input: 1, output: 2, cacheRead: 0.1 },
  capabilities: { computerUse },
});

/** Answers every request with its own name, so the test sees which one was asked. */
function provider(id: string, models: ModelInfo[], on = true) {
  const answer = (model: string) =>
    ({
      model,
      content: [{ type: "text", text: id }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }) as unknown as ModelMessage;
  const client: ModelProvider = {
    models: () => models,
    stream: async (p) => answer(p.model),
    create: async (p) => answer(p.model),
  };
  return definePlugin({
    id,
    name: id,
    description: "",
    config: z.object({}),
    defaultOn: true,
    start: () => (on ? ready([], { models: client }) : needsSetup("Add a key.")),
  });
}

test("each request goes to the provider that offers its model, priced from its catalogue; none that's on, it fails", async () => {
  const t = track(
    await testApp(undefined, undefined, {}, [
      provider("alpha", [info("alpha-big", true)]),
      provider("beta", [info("beta-small", false)]),
      provider("gamma", [info("gamma-1", true)], false),
    ]),
  );
  await t.plugins.startAll();
  const models = new Models(t.plugins);
  const ask = (model: string) =>
    models.create({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  const by = async (model: string) => JSON.stringify((await ask(model)).content);

  expect(await by("beta-small")).toContain('"beta"');
  expect(await by("alpha-big")).toContain('"alpha"');
  expect(priceOf("beta-small")).toEqual({ input: 1, output: 2, cacheRead: 0.1 });
  await expect(ask("gamma-1")).rejects.toThrow("no model provider that's on offers gamma-1");

  const { cookie } = signIn(t);
  const listed = await (await t.call("GET", "/models", undefined, { cookie })).json();
  expect(listed).toEqual([
    { id: "alpha-big", name: "alpha-big", provider: "alpha", computerUse: true },
    { id: "beta-small", name: "beta-small", provider: "beta", computerUse: false },
  ]);
});

test("Settings and bots take only a model a provider that's on offers, and the desktop only one that can use a computer", async () => {
  const t = track(
    await testApp(undefined, undefined, {}, [
      provider("beta", [info("beta-small", false)]),
      provider("gamma", [info("gamma-1", true)]),
    ]),
  );
  await t.plugins.startAll();
  const { cookie } = signIn(t);
  const put = (body: object) => t.call("PUT", "/settings", body, { cookie });

  // A model whose provider was on once isn't on offer once it's off.
  await t.plugins.update("gamma", { enabled: false });
  expect((await put({ chatModel: "gamma-1" })).status).toBe(400);

  const unknown = await put({ chatModel: "nobody-1" });
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toMatchObject({ field: "chatModel" });
  const desktop = await put({ desktopModel: "beta-small" });
  expect(desktop.status).toBe(400);
  expect(await desktop.json()).toMatchObject({ field: "desktopModel" });
  expect((await put({ taskModel: "beta-small" })).status).toBe(200);
  expect(t.settings.get().taskModel).toBe("beta-small");

  const bot = await t.call("POST", "/bots", { name: "Cook", chatModel: "nobody-1" }, { cookie });
  expect(bot.status).toBe(400);
});

test("the review asks the small model first and the expert model before a no", async () => {
  const t = await testApp();
  t.settings.update({ smallModel: "claude-opus-5-5", expertModel: "claude-haiku-5-5" });
  const fake = new FakeModel();
  fake.onCreate = () => JSON.stringify({ safe: false, why: "no" });
  const review = await safeToRun(
    { model: fake, spend: t.spend, settings: t.settings },
    { taskId: 1 },
    { ownerSaid: "restart it", goal: "Restart the box.", sources: [] },
    { tool: "box_restart", input: {}, what: "Restart", why: "It asks." },
  );
  expect(fake.creates.map((c) => c.model)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  expect(review.by).toBe("Haiku 5.5");
});
