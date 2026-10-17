import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "./dom";

installDom();
const { AssistantBody, appPath, dayLabel, follows } = await import("../src/pages/Chat");

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
