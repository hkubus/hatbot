import { expect, test } from "bun:test";
import type { Attachment, ThreadMessage } from "@hatbot/shared";
import type { CallContext } from "../src/plugins/plugin";
import { FakeModel, text, toolUse } from "./fake-model";
import { ORIGIN, setUpOwner, type TestApp, testApp } from "./helpers";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

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

test("code_run copies files into the sandbox and runs; fetching makes it untrusted", async () => {
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
  const untrusted = run.untrusted as (i: { command: string }) => boolean;
  expect(untrusted({ command: "curl -s https://example.com" })).toBe(true);
  expect(untrusted({ command: "python3 -c 'print(1+1)'" })).toBe(false);
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
    { content: [text('```chart\n{"type": "line"}\n```')] },
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
  const told = JSON.stringify(chat.requests.at(-1)?.messages.at(-1));
  expect(told).toContain('handed you, below: #1 \\"cpu.json\\", #2 \\"cpu.png\\"');
  expect(told).toContain(JSON.stringify(series).slice(1, -1));
  expect(told).toContain('"type":"image"');
  const reply = t.thread.list().find((m) => m.taskId === task?.id);
  expect(reply?.text).toContain("```chart");
  // Not yours: nothing under the reply, and no event that put them there.
  expect(reply?.attachments).toBeUndefined();
  expect(t.events.some((e) => e.type === "message.attachment")).toBe(false);
});
