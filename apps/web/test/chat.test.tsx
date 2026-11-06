import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom, settle } from "./dom";
import { msg } from "./fixtures";

const dom = installDom();
const { Chat, Composer, fileDrops, follows, sendError, typesIntoComposer } = await import(
  "../src/pages/Chat"
);
const store = await import("../src/store");
const { ApiError } = await import("../src/api");
const drafts = await import("../src/drafts");

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

test("a file that didn't upload holds the message until it's taken off", async () => {
  const g = globalThis as Record<string, unknown>;
  const before = g.XMLHttpRequest;
  g.XMLHttpRequest = FakeXhr;
  try {
    const chat = "9";
    drafts.attachFiles(chat, [new File(["x"], "notes.txt"), new File(["y"], "clip.mov")]);
    const [notes, clip] = FakeXhr.all.slice(-2) as [FakeXhr, FakeXhr];
    const html = () => renderToStaticMarkup(<Composer chat={chat} onSend={() => {}} />);

    clip.answer(413, { error: "The file is over 25 MB." });
    notes.answer(201, { id: 3, name: "notes.txt", mediaType: "text/plain", size: 1 });
    await settle();
    const files = drafts.draftFiles(chat);
    expect(files.map((d) => [d.name, d.attachment?.id, d.error])).toEqual([
      ["notes.txt", 3, undefined],
      ["clip.mov", undefined, "The file is over 25 MB."],
    ]);
    // Sending would leave it out without a word, so the button waits until it's taken off.
    expect(html()).toMatch(/<button[^>]*title="Send"[^>]*disabled/);
    drafts.removeFile(chat, (files[1] as { key: number }).key);
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

test("a character typed with nothing to type it into goes to the composer", () => {
  const key = (key: string, mods: { ctrl?: boolean; alt?: boolean; altGraph?: boolean } = {}) => ({
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: false,
    altKey: !!mods.alt,
    isComposing: false,
    defaultPrevented: false,
    getModifierState: (m: string) => m === "AltGraph" && !!mods.altGraph,
  });
  const on = (selector: string | null) => ({
    closest: (s: string) => (selector && s.split(", ").includes(selector) ? {} : null),
  });
  const types = (e: ReturnType<typeof key>, focused = on(null), dialog = false) =>
    typesIntoComposer(e, focused as unknown as Element, dialog);

  expect(types(key("h"), null as unknown as ReturnType<typeof on>)).toBe(true);
  // Focus left on a button you clicked, or the page.
  expect(types(key("H"))).toBe(true);
  expect(types(key("ł", { ctrl: true, alt: true, altGraph: true }))).toBe(true);
  expect(types(key("😀"))).toBe(true);

  expect(types(key("h"), on("input"))).toBe(false);
  expect(types(key("h"), on("textarea"))).toBe(false);
  expect(types(key("h"), on(".live-keys"))).toBe(false);
  expect(types(key("h"), on(null), true)).toBe(false);
  expect(types(key(" "))).toBe(false);
  expect(types(key("Enter"))).toBe(false);
  expect(types(key("k", { ctrl: true }))).toBe(false);
  expect(types(key("ArrowUp", { alt: true }))).toBe(false);
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

test("a folded conversation that ran into the next day still has that day shown after it", async () => {
  const at = (d: string) => ({ createdAt: `2026-10-${d}.000Z`, seenAt: `2026-10-${d}.000Z` });
  const thread = [
    msg(1, { role: "user", episodeId: 1, ...at("15T10:00:00") }),
    msg(2, { episodeId: 1, ...at("16T09:00:00") }),
    msg(3, { role: "user", episodeId: 2, ...at("16T12:00:00") }),
    msg(4, { episodeId: 2, ...at("16T12:01:00") }),
  ];
  dom.answer((r) => (r.path.includes("/messages") ? thread : []));
  await store.openConversation(1);
  await store.loadThread();
  const html = renderToStaticMarkup(<Chat id={1} />);
  expect(html.match(/class="day"/g)?.length).toBe(2);
});
