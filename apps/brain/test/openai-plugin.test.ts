import { expect, test } from "bun:test";
import { openaiPlugin } from "@hatbot/plugin-openai";
import { retryDelays } from "@hatbot/plugin-sdk";
import { Models } from "../src/agent/models";
import { priceOf } from "../src/spend";
import { signIn, testApp } from "./helpers";
import { stopPluginsAfterEach, track } from "./plugin-helpers";

stopPluginsAfterEach();

const LISTING = {
  data: [
    {
      id: "acme/smart",
      name: "Acme: Smart",
      pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000005" },
      supported_parameters: ["tools", "reasoning"],
      architecture: { input_modalities: ["text", "image", "file"] },
    },
    { id: "acme/plain", name: "Acme: Plain", supported_parameters: ["temperature"] },
    { id: "acme/text", name: "Acme: Text", supported_parameters: ["tools"] },
  ],
};

const sse = (chunks: object[]) =>
  new Response(
    `: OPENROUTER PROCESSING\n\n${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

/** OpenRouter as the plugin sees it: what each request asked, and scripted answers. */
async function openRouter(answers: Response[], base = "https://openrouter.ai/api/v1") {
  const asked: { url: string; body: Record<string, unknown> | null; key: string | null }[] = [];
  const t = track(
    await testApp(undefined, undefined, {}, [openaiPlugin], {
      OPENAI_API_KEY: "sk-or-test",
      OPENAI_BASE_URL: base,
    }),
  );
  t.outside.fetch = async (url, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    asked.push({ url, body, key: new Headers(init?.headers).get("authorization") });
    if (url === `${base}/models`) return Response.json(LISTING);
    return answers.shift() ?? new Response(null, { status: 500 });
  };
  await t.plugins.update("openai", { enabled: true });
  return { t, asked, models: new Models(t.plugins) };
}

test("an OpenAI-compatible API answers in the Messages API's shape, streamed, with its tools, prices and usage", async () => {
  const { t, asked, models } = await openRouter([
    sse([
      { id: "gen-1", choices: [{ delta: { reasoning: "Checking the disks." } }] },
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "proxmox_list", arguments: '{"no' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'de":"pve"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      },
    ]),
  ]);
  expect(t.plugins.get("openai")?.state).toBe("ready");
  // Only the models that take tools are offered.
  const { cookie } = signIn(t);
  expect(await (await t.call("GET", "/models", undefined, { cookie })).json()).toEqual([
    { id: "acme/smart", name: "Acme: Smart", provider: "openai", computerUse: false },
    { id: "acme/text", name: "Acme: Text", provider: "openai", computerUse: false },
  ]);
  expect(priceOf("acme/smart")).toEqual({ input: 2, output: 10, cacheRead: 0.5 });

  const said: string[] = [];
  const thought: string[] = [];
  const res = await models.stream(
    {
      model: "acme/smart",
      max_tokens: 1000,
      system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
      tools: [
        {
          name: "proxmox_list",
          description: "Lists guests",
          input_schema: { type: "object", properties: { node: { type: "string" } } },
        },
        { type: "web_search_20250305", name: "web_search" },
      ],
      messages: [
        { role: "user", content: "What's running?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Hm.", signature: "x" },
            { type: "text", text: "Looking." },
            { type: "tool_use", id: "call_0", name: "proxmox_list", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_0",
              content: [
                { type: "text", text: "pve" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "AAAA" },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      onText: (d) => said.push(d),
      onThinking: (d) => thought.push(d),
      onFailedUsage: () => {},
    },
  );

  const sent = asked.at(-1);
  expect(sent?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(sent?.key).toBe("Bearer sk-or-test");
  expect(sent?.body).toMatchObject({
    model: "acme/smart",
    max_tokens: 1000,
    stream: true,
    reasoning: { effort: "high" },
    tools: [{ type: "function", function: { name: "proxmox_list", description: "Lists guests" } }],
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "What's running?" }] },
      {
        role: "assistant",
        content: "Looking.",
        tool_calls: [
          { id: "call_0", type: "function", function: { name: "proxmox_list", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_0", content: "pve" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      },
    ],
  });
  // Its web search is left out: OpenRouter's would be billed and its pages not marked untrusted.
  expect(sent?.body?.tools).toHaveLength(1);
  expect(sent?.body?.plugins).toBeUndefined();

  expect(said).toEqual(["Hel", "lo"]);
  expect(thought).toEqual(["Checking the disks."]);
  expect(res.stop_reason).toBe("tool_use");
  expect(res.content).toEqual([
    { type: "text", text: "Hello", citations: null },
    { type: "tool_use", id: "call_1", name: "proxmox_list", input: { node: "pve" } },
  ] as typeof res.content);
  expect(res.usage).toMatchObject({
    input_tokens: 600,
    cache_read_input_tokens: 400,
    output_tokens: 50,
  });
});

test("an OpenAI-compatible API's passing failures are tried again, and its refusals say what it said", async () => {
  const saved = retryDelays.ms;
  retryDelays.ms = [0, 0];
  try {
    const answer = {
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    };
    const { asked, models } = await openRouter([
      Response.json({ error: { message: "Rate limited" } }, { status: 429 }),
      Response.json(answer),
      Response.json({ error: { message: "Context too long" } }, { status: 400 }),
    ]);
    const ask = () =>
      models.create({
        model: "acme/smart",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      });

    const res = await ask();
    expect(res.content).toEqual([
      { type: "text", text: "OK", citations: null },
    ] as typeof res.content);
    expect(res.stop_reason).toBe("end_turn");
    const tries = asked.length;
    await expect(ask()).rejects.toThrow("the API said 400: Context too long");
    expect(asked.length).toBe(tries + 1);
  } finally {
    retryDelays.ms = saved;
  }
});

const ask = (models: Models, model = "acme/smart") =>
  models.stream(
    {
      model,
      max_tokens: 10,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "AAAA" },
            },
          ],
        },
      ],
    },
    { onFailedUsage: () => {} },
  );

test("a call cut off at the token limit isn't run", async () => {
  const { models } = await openRouter([
    sse([
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { name: "x_run", arguments: '{"a' } }] },
            finish_reason: "length",
          },
        ],
      },
    ]),
  ]);
  const res = await ask(models);
  expect(res.stop_reason).toBe("max_tokens");
  // Streamed without an id, it still gets one to answer.
  expect((res.content[0] as { id: string }).id).toStartWith("call_");
});

test("a stream that ends before its answer is tried again", async () => {
  const saved = retryDelays.ms;
  retryDelays.ms = [0, 0];
  try {
    const { asked, models } = await openRouter([
      sse([{ choices: [{ delta: { content: "Hel" } }] }]),
      sse([{ choices: [{ delta: { content: "Hel" }, finish_reason: "error" }] }]),
      sse([{ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }]),
    ]);
    const res = await ask(models);
    expect(res.content).toEqual([
      { type: "text", text: "Hello", citations: null },
    ] as typeof res.content);
    expect(asked.filter((a) => a.url.endsWith("/chat/completions"))).toHaveLength(3);
  } finally {
    retryDelays.ms = saved;
  }
});

test("a model is sent only what it takes", async () => {
  const done = sse([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
  const { asked, models } = await openRouter([done]);
  await ask(models, "acme/text");
  expect(asked.at(-1)?.body).toMatchObject({
    max_tokens: 10,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { type: "text", text: "(An image this model can't see.)" },
          { type: "text", text: "(A PDF this model can't read.)" },
        ],
      },
    ],
  });
  expect(asked.at(-1)?.body?.reasoning).toBeUndefined();

  // OpenAI's own API names the limit differently.
  const other = await openRouter(
    [sse([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }])],
    "https://api.example.com/v1",
  );
  await ask(other.models);
  expect(other.asked.at(-1)?.body).toMatchObject({ max_completion_tokens: 10 });
  expect(other.asked.at(-1)?.body?.max_tokens).toBeUndefined();
});
