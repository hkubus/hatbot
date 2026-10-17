import { expect, test } from "bun:test";
import type { Attachment, ThreadMessage } from "@hatbot/shared";
import { inlineLimit } from "../src/attachments";
import type { CallContext } from "../src/plugins/plugin";
import { estimateTokens } from "../src/spend";
import { FakeModel, text, toolUse } from "./fake-model";
import { ORIGIN, setUpOwner, type TestApp, testApp } from "./helpers";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

/** Turns as sent, but for where each request marks the cache. */
const unmarked = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x)));

async function upload(t: TestApp, cookie: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  return t.app.request("/api/v1/attachments", {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
    body: form,
  });
}

test("you upload a photo, send it with a message, and the model sees it; it taints the chat", async () => {
  const chat = new FakeModel([{ content: [text("A cat.")] }, { content: [text("Hi.")] }]);
  const t = await testApp(chat);
  const { cookie } = await setUpOwner(t);

  const res = await upload(t, cookie, new File([PNG], "cat.png", { type: "image/png" }));
  expect(res.status).toBe(201);
  const a = (await res.json()) as Attachment;
  expect(a).toMatchObject({
    name: "cat.png",
    mediaType: "image/png",
    size: PNG.length,
    from: "owner",
  });

  const posted = await t.call(
    "POST",
    "/thread/messages",
    { text: "", attachmentIds: [a.id] },
    { cookie },
  );
  expect(posted.status).toBe(202);
  expect(((await posted.json()) as ThreadMessage).attachments?.[0]?.id).toBe(a.id);
  await t.thread.idle();

  const blocks = chat.requests[0]?.messages.at(-1)?.content as { type: string; text?: string }[];
  expect(blocks.map((b) => b.type)).toEqual(expect.arrayContaining(["text", "image"]));
  expect(blocks.some((b) => b.text?.includes("(no text, only files)"))).toBe(true);
  expect(blocks.some((b) => b.text?.startsWith(`Attachment #${a.id}: "cat.png"`))).toBe(true);
  const episode = t.db.query<{ tainted_by: string }, []>("SELECT tainted_by FROM episodes").get();
  expect(episode?.tainted_by).toBe('Attached file "cat.png"');
  expect(t.thread.list()[0]?.attachments?.map((x) => x.id)).toEqual([a.id]);

  // Already on a message: it can't be posted again.
  const again = await t.call(
    "POST",
    "/thread/messages",
    { text: "hi", attachmentIds: [a.id] },
    { cookie },
  );
  expect(again.status).toBe(202);
  await t.thread.idle();
  expect(t.thread.list().find((m) => m.text === "hi")?.attachments).toBeUndefined();

  // The turn keeps the file's id, not its bytes; each request has the bytes, the same each time.
  const b64 = Buffer.from(PNG).toString("base64");
  const stored = t.db
    .query<{ content: string }, []>(
      "SELECT content FROM episode_turns WHERE role = 'user' AND content LIKE '[%' ORDER BY id LIMIT 1",
    )
    .get()?.content;
  expect(stored).not.toContain(b64);
  expect(stored).toContain(`"id":${a.id}`);
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } };
  expect(chat.requests[0]?.messages[0]?.content).toContainEqual(image as never);
  expect(unmarked(chat.requests[1]?.messages[0]?.content)).toContainEqual(image);
});

test("files past what a request can carry are named for code_run, the same on every request", async () => {
  const chat = new FakeModel([
    { content: [text("One.")] },
    { content: [text("Two.")] },
    { content: [text("Three.")] },
  ]);
  const t = await testApp(chat);
  const { cookie } = await setUpOwner(t);
  const send = async (name: string, words: string) => {
    const a = (await (
      await upload(t, cookie, new File([PNG], name, { type: "image/png" }))
    ).json()) as Attachment;
    await t.call("POST", "/thread/messages", { text: words, attachmentIds: [a.id] }, { cookie });
    await t.thread.idle();
    return a;
  };
  // An 11-byte PNG is 16 characters of base64: room for one.
  const saved = inlineLimit.bytes;
  inlineLimit.bytes = 20;
  try {
    const first = await send("one.png", "first");
    const second = await send("two.png", "second");
    await t.thread.post("third").done;
    const images = (i: number) =>
      JSON.stringify(chat.requests[i]?.messages).split('"image"').length - 1;
    expect([images(0), images(1), images(2)]).toEqual([1, 1, 1]);
    const last = JSON.stringify(chat.requests[2]?.messages);
    expect(last).toContain(`Attachment #${second.id}: \\"two.png\\"`);
    expect(last).toContain(`files: [${second.id}]`);
    expect(last).not.toContain(`files: [${first.id}]`);
    // What the first two requests sent comes back the same in the third.
    const head = unmarked(chat.requests[1]?.messages.slice(0, 3));
    expect(unmarked(chat.requests[2]?.messages.slice(0, 3))).toEqual(head);
  } finally {
    inlineLimit.bytes = saved;
  }
});

test("turns stored with the bytes themselves still go out as they are", async () => {
  const chat = new FakeModel([{ content: [text("one")] }, { content: [text("two")] }]);
  const t = await testApp(chat);
  await t.thread.post("first").done;
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  };
  t.db
    .query("UPDATE episode_turns SET content = ? WHERE id = 1")
    .run(JSON.stringify([{ type: "text", text: "old" }, image]));
  await t.thread.post("second").done;
  expect(unmarked(chat.requests[1]?.messages[0]?.content)).toContainEqual(image);
});

test("the estimate before a request counts images and PDFs by size, not their base64", () => {
  const mb = "A".repeat(1024 * 1024);
  const tokens = estimateTokens([
    {
      role: "user",
      content: [
        { type: "text", text: "x".repeat(350) },
        { type: "image", source: { type: "base64", media_type: "image/png", data: mb } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: mb } },
        {
          type: "document",
          source: { type: "text", media_type: "text/plain", data: "y".repeat(700) },
        },
      ],
    },
  ]);
  // 100 + 200 of text, an image, and a 768 KB PDF.
  const expected = 300 + 1600 + 768 * 25;
  expect(tokens).toBeGreaterThan(expected);
  expect(tokens).toBeLessThan(expected + 50);
});

test("a file is checked again each time it's shown, and an incognito one isn't kept", async () => {
  const chat = new FakeModel([{ content: [text("A cat.")] }, { content: [text("Shh.")] }]);
  const t = await testApp(chat);
  const { cookie } = await setUpOwner(t);
  const get = (id: number, headers: Record<string, string> = {}) =>
    t.app.request(`/api/v1/attachments/${id}`, { headers: { cookie, ...headers } });
  const send = async (incognito: boolean) => {
    const a = (await (await upload(t, cookie, new File([PNG], "cat.png"))).json()) as Attachment;
    // Not sent yet: it may be going to an incognito conversation.
    expect((await get(a.id)).headers.get("cache-control")).toBe("no-store");
    await t.call(
      "POST",
      "/thread/messages",
      { text: "", attachmentIds: [a.id], incognito },
      { cookie },
    );
    await t.thread.idle();
    return a;
  };

  const kept = await send(false);
  const first = await get(kept.id);
  expect(first.headers.get("cache-control")).toBe("private, no-cache");
  const etag = first.headers.get("etag") ?? "";
  expect(etag).toStartWith(`"${kept.id}-`);
  const again = await get(kept.id, { "if-none-match": etag });
  expect(again.status).toBe(304);

  const secret = await send(true);
  const shown = await get(secret.id);
  expect(shown.headers.get("cache-control")).toBe("no-store");
  expect(shown.headers.get("etag")).toBeNull();
  // Leaving incognito deletes it, and the id isn't given to the next file.
  await t.call("DELETE", "/thread/incognito", undefined, { cookie });
  expect((await get(secret.id)).status).toBe(404);
  const next = (await (await upload(t, cookie, new File([PNG], "dog.png"))).json()) as Attachment;
  expect(next.id).toBeGreaterThan(secret.id);
});

test("a name in any language is kept in the download's filename*", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const name = "Zażółć 'gęślą' (1).pdf";
  const a = (await (
    await upload(t, cookie, new File(["%PDF-1.4"], name, { type: "application/pdf" }))
  ).json()) as Attachment;
  const res = await t.app.request(`/api/v1/attachments/${a.id}?download`, { headers: { cookie } });
  const header = res.headers.get("content-disposition") ?? "";
  expect(header).toStartWith(`attachment; filename="Za____ 'g__l_' (1).pdf"`);
  const encoded = /filename\*=UTF-8''(\S+)$/.exec(header)?.[1] ?? "";
  expect(encoded).toBe("Za%C5%BC%C3%B3%C5%82%C4%87%20%27g%C4%99%C5%9Bl%C4%85%27%20%281%29.pdf");
  expect(decodeURIComponent(encoded)).toBe(name);
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
});

test("downloads: images inline, anything else as a file, never sniffed", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const png = (await (await upload(t, cookie, new File([PNG], "cat.png"))).json()) as Attachment;
  const html = (await (
    await upload(
      t,
      cookie,
      new File(["<script>alert(1)</script>"], "x.html", { type: "text/html" }),
    )
  ).json()) as Attachment;
  expect(png.mediaType).toBe("image/png"); // from the extension

  const get = (id: number) => t.app.request(`/api/v1/attachments/${id}`, { headers: { cookie } });
  const img = await get(png.id);
  expect(img.headers.get("content-type")).toBe("image/png");
  expect(img.headers.get("content-disposition")).toStartWith('inline; filename="cat.png"');
  expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  const page = await get(html.id);
  expect(page.headers.get("content-type")).toBe("application/octet-stream");
  expect(page.headers.get("content-disposition")).toStartWith("attachment;");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");

  expect((await t.app.request(`/api/v1/attachments/${png.id}`)).status).toBe(401);
  expect((await get(999)).status).toBe(404);
  const empty = await upload(t, cookie, new File([], "empty.txt"));
  expect(empty.status).toBe(400);
  const bad = await t.call(
    "POST",
    "/thread/messages",
    { text: "x", attachmentIds: [999] },
    { cookie },
  );
  expect(bad.status).toBe(400);
  const none = await t.call("POST", "/thread/messages", { text: "" }, { cookie });
  expect(none.status).toBe(400);
});

test("what the model gets: text inline, PDFs as documents, the rest through the sandbox", async () => {
  const t = await testApp();
  const save = (name: string, bytes: Uint8Array | string, mediaType = "") =>
    t.attachments.save({
      bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
      name,
      mediaType,
      from: "owner",
    });
  const csv = await save("data.csv", "a,b\n1,2\n");
  const pdf = await save("doc.pdf", new Uint8Array([37, 80, 68, 70]));
  const zip = await save("all.zip", new Uint8Array([80, 75, 3, 4]));
  const blocks = await t.attachments.blocks([csv, pdf, zip]);
  expect(blocks[1]).toMatchObject({
    type: "document",
    source: { type: "text", data: "a,b\n1,2\n" },
  });
  expect(blocks[3]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
  expect((blocks[4] as { text: string }).text).toContain(
    `code_run can copy it into the sandbox (files: [${zip.id}])`,
  );
});

test("code_run copies files into the sandbox and runs; its output is untrusted", async () => {
  const t = await testApp();
  await t.plugins.update("code", { enabled: true });
  const run = t.plugins.tools().find((x) => x.name === "code_run");
  if (!run) throw new Error("no code_run");
  const a = await t.attachments.save({
    bytes: new TextEncoder().encode("1,2"),
    name: "my data.csv",
    mediaType: "text/csv",
    from: "owner",
  });
  const call: CallContext = {
    task: { id: 1, tainted: false },
    signal: new AbortController().signal,
  };
  const out = await run.run({ command: "python3 sum.py in/*", timeout_s: 60, files: [a.id] }, call);
  expect(out).toBe(`Copied in: in/${a.id}-my_data.csv\nExit code 0\nran python3 sum.py in/*`);
  expect(new TextDecoder().decode(t.agent.files.get(`in/${a.id}-my_data.csv`))).toBe("1,2");
  await expect(run.run({ command: "ls", timeout_s: 60, files: [999] }, call)).rejects.toThrow(
    "There's no attachment #999.",
  );
  // The sandbox keeps what it fetched: any command's output may be a page's.
  expect(run.untrusted).toBe(true);
});

test("send_file puts the sandbox's file under the reply", async () => {
  const chat = new FakeModel([
    { content: [toolUse("send_file", { path: "out/chart.png" })] },
    { content: [text("Here's the chart.")] },
  ]);
  const t = await testApp(chat);
  t.agent.files.set("out/chart.png", PNG);
  await t.thread.post("chart it").done;
  const reply = t.thread.list().at(-1);
  expect(reply?.text).toBe("Here's the chart.");
  expect(reply?.attachments).toMatchObject([
    { name: "chart.png", mediaType: "image/png", from: "hatbot" },
  ]);
  expect(t.events.some((e) => e.type === "message.attachment" && e.id === reply?.id)).toBe(true);
});

test("a desktop task sends a browser download; it shows on the task and its message", async () => {
  const work = new FakeModel([
    { content: [toolUse("send_file", { download_id: "d1", name: "invoice.pdf" })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Got the invoice." })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.agent.downloads.set("d1", { name: "download.pdf", bytes: new Uint8Array([37, 80, 68, 70]) });
  const task = t.tasks.createDesktopTask({
    title: "Invoice",
    goal: "Get it",
    successCriteria: "",
    origin: "chat",
  });
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.status).toBe("done");
  expect(t.attachments.forTask(task.id)).toMatchObject([
    { name: "invoice.pdf", mediaType: "application/pdf" },
  ]);
  expect(t.tasks.steps(task.id).some((s) => s.name === "send_file")).toBe(true);
});

test("a background task hands the chat a JSON file; the bot reads it and the chat doesn't show it", async () => {
  const series = JSON.stringify({ x: ["Mon", "Tue"], cpu: [12, 40] });
  const chat = new FakeModel([
    { content: [toolUse("run_task", { title: "CPU this week", goal: "Get CPU per day" })] },
    { content: [text("On it.")] },
    {
      content: [text('```chart\n{"type": "line", "x": ["Mon"], "series": [{"data": [12]}]}\n```')],
    },
  ]);
  const work = new FakeModel([
    {
      content: [
        toolUse("send_to_chat", { name: "cpu.json", content: series }),
        toolUse("send_to_chat", { path: "out/cpu.png" }),
      ],
    },
    {
      content: [toolUse("finish_task", { outcome: "done", summary: "CPU per day.", notify: true })],
    },
  ]);
  const t = await testApp(chat, work);
  t.agent.files.set("out/cpu.png", PNG);
  t.thread.post("chart CPU this week");
  await t.thread.idle();
  await t.tasks.idle();
  await t.thread.idle();

  const [task] = t.tasks.list();
  expect(t.attachments.forTask(task?.id as number)).toMatchObject([
    { name: "cpu.json", mediaType: "application/json", forChat: true },
    { name: "cpu.png", mediaType: "image/png", forChat: true },
  ]);
  expect(t.tasks.steps(task?.id as number).filter((s) => s.name === "send_to_chat").length).toBe(2);
  // The bot gets them with the task's result, and writes its reply again with the chart.
  const told = JSON.stringify(chat.requests.at(-1)?.messages.at(-2));
  expect(told).toContain('handed you, below: #1 \\"cpu.json\\", #2 \\"cpu.png\\"');
  expect(told).toContain(JSON.stringify(series).slice(1, -1));
  expect(told).toContain('"type":"image"');
  const reply = t.thread.list().find((m) => m.taskId === task?.id);
  expect(reply?.text).toContain("```chart");
  // Not yours: nothing under the reply, and no event that put them there.
  expect(reply?.attachments).toBeUndefined();
  expect(t.events.some((e) => e.type === "message.attachment")).toBe(false);
});

test("a desktop task hands the chat a download; under a background task, it goes with that one's result", async () => {
  const work = new FakeModel([
    {
      content: [
        toolUse("run_desktop_task", {
          title: "Export",
          goal: "Export the CSV",
          success_criteria: "",
        }),
      ],
    },
    { content: [toolUse("send_to_chat", { download_id: "d1", name: "usage.csv" })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Exported." })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Usage.", notify: true })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.agent.downloads.set("d1", {
    name: "export.csv",
    bytes: new TextEncoder().encode("day,gb\n1,2"),
  });
  const parent = t.tasks.createBackgroundTask({
    title: "Usage",
    goal: "Get usage",
    origin: "chat",
  });
  await t.tasks.idle();

  const child = t.tasks.list().find((x) => x.parentId === parent?.id);
  expect(child?.status).toBe("done");
  expect(t.attachments.forTask(child?.id as number)).toEqual([]);
  expect(t.attachments.forTask(parent?.id as number)).toMatchObject([
    { name: "usage.csv", mediaType: "text/csv", forChat: true },
  ]);
  expect(t.tasks.steps(child?.id as number).some((s) => s.name === "send_to_chat")).toBe(true);
  const said = JSON.stringify(work.requests[2]?.messages.at(-1));
  expect(said).toContain(`It goes with task #${parent?.id}'s result.`);
});
