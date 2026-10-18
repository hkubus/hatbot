import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom, settle } from "./dom";
import { msg } from "./fixtures";

installDom();
const {
  AssistantBody,
  appPath,
  Composer,
  dayLabel,
  fileDrops,
  follows,
  Message,
  sendError,
  spoken,
  wheelStops,
} = await import("../src/pages/Chat");
const { ApiError } = await import("../src/api");
const drafts = await import("../src/drafts");

test("the composer says it has a menu, and which line in it is picked", () => {
  const html = (draft: string) => {
    drafts.saveDraftText("7", draft);
    return renderToStaticMarkup(<Composer chat="7" onSend={() => {}} />);
  };
  const open = html("/");
  const box = /<textarea[^>]*>/.exec(open)?.[0] ?? "";
  // A textarea keeps its own role, a multi-line text box; a combobox role isn't allowed on one.
  expect(box).not.toContain("role=");
  expect(box).not.toContain("aria-expanded");
  expect(box).toContain('aria-autocomplete="list"');
  const menu = /aria-controls="([^"]+)"/.exec(box)?.[1];
  const picked = /aria-activedescendant="([^"]+)"/.exec(box)?.[1];
  expect(open).toContain(`role="listbox" id="${menu}"`);
  expect(open).toMatch(
    new RegExp(`id="${picked}"[^>]*role="option"[^>]*tabindex="-1"[^>]*aria-selected="true"`),
  );
  const closed = /<textarea[^>]*>/.exec(html("hello"))?.[0] ?? "";
  expect(closed).not.toContain("aria-controls");
  expect(closed).not.toContain("aria-activedescendant");
  drafts.saveDraftText("7", "");
});

test("until its task or schedule loads, a card's line shows without Markdown's marks", () => {
  const card = (patch: object) =>
    renderToStaticMarkup(
      <Message
        m={msg(40, {
          kind: "task",
          text: "Task #12: Check the NAS. Done: **All good.** The `tank` pool is fine.",
          taskId: 12,
          seenAt: null,
          ...patch,
        })}
        animate={false}
        unread={false}
      />,
    );
  expect(card({})).toContain(
    '<div class="muted card-pending">Task #12: Check the NAS. Done: All good. The tank pool is fine.</div>',
  );
  expect(card({ text: "" })).toContain('<div class="muted card-pending">Task #12</div>');
  expect(
    card({ kind: "schedule", taskId: null, scheduleId: 3, text: "Scheduled **Backups**: daily." }),
  ).toContain('<div class="muted card-pending">Scheduled Backups: daily.</div>');
});

test("a finished reply is said without Markdown's marks", () => {
  const reply = { text: "**Done.** The `backup` ran:\n\n# Result\n\n- ok" } as Parameters<
    typeof spoken
  >[0];
  expect(spoken(reply, "Sysadmin")).toBe("Sysadmin: Done. The backup ran: Result ok");
  expect(spoken({ ...reply, text: "x".repeat(500) }, "Hatbot")).toHaveLength(
    "Hatbot: ".length + 400,
  );
  expect(spoken({ ...reply, text: "" }, "Hatbot")).toBe("");
});

/** The upload's other end, driven by the test. */
class FakeXhr {
  static all: FakeXhr[] = [];
  upload: { onprogress: ((e: object) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  open() {}
  send() {
    FakeXhr.all.push(this);
  }
  abort() {
    this.onabort?.();
  }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

test("a file that didn't upload holds the message and says why; uploads show how far they've got", async () => {
  const g = globalThis as Record<string, unknown>;
  const before = g.XMLHttpRequest;
  g.XMLHttpRequest = FakeXhr;
  try {
    const chat = "9";
    drafts.attachFiles(chat, [new File(["x"], "notes.txt"), new File(["y"], "clip.mov")]);
    const [notes, clip] = FakeXhr.all.slice(-2) as [FakeXhr, FakeXhr];
    notes.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    const html = () => renderToStaticMarkup(<Composer chat={chat} onSend={() => {}} />);
    expect(html()).toContain('class="upload-bar" style="width:50%"');

    clip.answer(413, { error: "The file is over 25 MB." });
    notes.answer(201, { id: 3, name: "notes.txt", mediaType: "text/plain", size: 1 });
    await settle();
    const files = drafts.draftFiles(chat);
    expect(files.map((d) => [d.name, d.attachment?.id, d.error])).toEqual([
      ["notes.txt", 3, undefined],
      ["clip.mov", undefined, "The file is over 25 MB."],
    ]);
    // Sending would leave it out without a word: the button waits, and the line says why.
    expect(html()).toContain("clip.mov: The file is over 25 MB. Take it off to send.");
    expect(html()).toMatch(/<button[^>]*title="Send"[^>]*disabled/);
    expect(html()).not.toContain("upload-bar");

    drafts.removeFile(chat, (files[1] as { key: number }).key);
    expect(html()).not.toContain("Take it off");
    expect(html()).not.toMatch(/<button[^>]*title="Send"[^>]*disabled/);
  } finally {
    g.XMLHttpRequest = before;
  }
});

test("files dropped anywhere in the window go into the composer, not over the app", () => {
  const attached: unknown[] = [];
  let dropping = false;
  const on = new Map(
    fileDrops(
      (list) => attached.push(list),
      (v) => {
        dropping = v;
      },
    ),
  );
  const event = (types: string[], files: unknown[] = [], relatedTarget: unknown = null) => ({
    dataTransfer: { types, files },
    relatedTarget,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  });
  const fire = (type: string, e: ReturnType<typeof event>) => on.get(type)?.(e as unknown as Event);

  // Over the sidebar or the toolbar: the browser is told the drop is taken.
  fire("dragenter", event(["Files"]));
  const over = event(["Files"]);
  fire("dragover", over);
  expect(over.defaultPrevented).toBe(true);
  expect(dropping).toBe(true);
  // Leaving one element for another inside the window keeps it showing, though Safari doesn't say
  // where it went.
  fire("dragenter", event(["Files"]));
  fire("dragleave", event(["Files"]));
  expect(dropping).toBe(true);
  const files = [new File(["x"], "a.txt")];
  const drop = event(["Files"], files);
  fire("drop", drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(attached).toEqual([files]);
  expect(dropping).toBe(false);
  // Dragged text is the page's own business.
  const text = event(["text/plain"]);
  fire("dragover", text);
  fire("drop", text);
  expect(text.defaultPrevented).toBe(false);
  expect(attached).toHaveLength(1);
  // Out of the window: no longer showing.
  fire("dragenter", event(["Files"]));
  fire("dragover", event(["Files"]));
  fire("dragleave", event(["Files"]));
  expect(dropping).toBe(false);
});

test("day labels: today, yesterday, then the date, with the year only when it isn't this one", () => {
  const now = new Date(2026, 9, 17, 9, 0);
  expect(dayLabel(new Date(2026, 9, 17, 1, 0).toISOString(), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 9, 16, 23, 0).toISOString(), now)).toBe("Yesterday");
  const long = { weekday: "long", day: "numeric", month: "long" } as const;
  const earlier = new Date(2026, 9, 3, 12, 0);
  expect(dayLabel(earlier.toISOString(), now)).toBe(earlier.toLocaleDateString("en-GB", long));
  expect(dayLabel(earlier.toISOString(), now)).toContain("3 October");
  const lastYear = new Date(2025, 11, 31, 12, 0);
  expect(dayLabel(lastYear.toISOString(), now)).toBe(
    lastYear.toLocaleDateString("en-GB", { ...long, year: "numeric" }),
  );
  expect(dayLabel(lastYear.toISOString(), now)).toContain("31 December 2025");
  // The next day, what was today is yesterday.
  const tomorrow = new Date(2026, 9, 18, 9, 0);
  expect(dayLabel(new Date(2026, 9, 17, 1, 0).toISOString(), tomorrow)).toBe("Yesterday");
});

test("a streaming reply renders as it will once it's done", () => {
  const text = "# Plan\n\nFirst **this**.\n\n```sh\necho a\n\necho b\n```\n\n- one\n- two\n\nLast.";
  // Only the line breaks between blocks differ, which a grid doesn't show.
  const html = (streaming: boolean) =>
    renderToStaticMarkup(<AssistantBody text={text} streaming={streaming} />).replace(
      />\n+</g,
      "><",
    );
  expect(html(true)).toBe(html(false));
  expect(html(true)).toContain('<code class="language-sh">echo a\n\necho b\n</code>');
});

test("the thread stops following on any scroll up, and starts again only at the bottom", () => {
  // Following, and a reply streams: a few pixels up to read stops it.
  expect(follows(true, 1000, 997, 40)).toBe(false);
  // Down again, but not all the way: still not following.
  expect(follows(false, 997, 1020, 17)).toBe(false);
  // At the bottom: following again.
  expect(follows(false, 1020, 1037, 0)).toBe(true);
  // Pinned down as the reply grows: still following.
  expect(follows(true, 1037, 1300, 0)).toBe(true);
  // A smooth scroll to the bottom on its way there keeps following.
  expect(follows(true, 200, 600, 700)).toBe(true);
  // The view grew and the browser moved it up to the new bottom: still following.
  expect(follows(true, 1300, 1200, 0)).toBe(true);
});

test("a send that failed on the way says it may have gone; only the brain's no says it didn't", () => {
  expect(sendError(new ApiError(413, "The message is too long."), true)).toBe(
    "The message is too long.",
  );
  // The brain may have posted it before the answer was lost, even with the socket down.
  for (const err of [new ApiError(502, "Bad gateway"), new TypeError("Failed to fetch")]) {
    expect(sendError(err, true)).toBe("It may not have been sent.");
    expect(sendError(err, false)).toBe("Can't reach Hatbot. It may not have been sent.");
  }
});

test("a wheel turned up stops following only when the thread can move up", () => {
  expect(wheelStops(-40, 500)).toBe(true);
  expect(wheelStops(40, 500)).toBe(false);
  // A short thread that fits the view: no scroll follows to start it again, so keep following.
  expect(wheelStops(-40, 0)).toBe(false);
});

test("a reply's links to the app stay in this tab; other sites open in a new one", () => {
  const origin = "http://hatbot.test";
  expect(appPath("/tasks/5", origin)).toBe("/tasks/5");
  expect(appPath("http://hatbot.test/chat/3?message=9#x", origin)).toBe("/chat/3?message=9#x");
  expect(appPath("https://example.com/tasks/5", origin)).toBeNull();
  expect(appPath("https://hatbot.test/tasks/5", origin)).toBeNull();
  // Files are the API's: they open in a new tab.
  expect(appPath("/api/v1/attachments/3", origin)).toBeNull();

  const html = renderToStaticMarkup(
    <AssistantBody text="See [the task](/tasks/5), [the docs](https://example.com/docs) and [the file](/api/v1/attachments/3)." />,
  );
  expect(html).toContain('<a href="/tasks/5">the task</a>');
  expect(html).toContain(
    '<a href="https://example.com/docs" target="_blank" rel="noreferrer noopener">the docs</a>',
  );
  expect(html).toContain(
    '<a href="/api/v1/attachments/3" target="_blank" rel="noreferrer noopener">the file</a>',
  );
});

test("a picture from another site is a link to it; Hatbot's own show", () => {
  const html = renderToStaticMarkup(
    <AssistantBody
      text={"![The diagram](https://example.com/x.png)\n\n![Shot](/api/v1/attachments/3)"}
    />,
  );
  // The page may only load its own pictures, so another site's would show broken.
  expect(html).not.toContain('<img src="https://example.com/x.png"');
  expect(html).toContain(
    '<a href="https://example.com/x.png" target="_blank" rel="noreferrer noopener">The diagram</a>',
  );
  expect(html).toContain('<img src="/api/v1/attachments/3" alt="Shot" loading="lazy"/>');
});
