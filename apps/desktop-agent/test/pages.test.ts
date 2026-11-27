import { afterAll, beforeAll, expect, test } from "bun:test";
import { Browser } from "../src/browser";
import { type Chromium, serve, startChromium, withChromium } from "./chromium";

const live = test.skipIf(!withChromium);
let chromium: Chromium | undefined;
let browser: Browser;
const pages: Record<string, string> = {};
const server = serve(pages);
const base = `http://127.0.0.1:${server.port}`;
beforeAll(async () => {
  if (!withChromium) return;
  chromium = await startChromium();
  browser = new Browser(null, chromium.endpoint);
});
afterAll(async () => {
  server.stop(true);
  await chromium?.stop();
});

const read = async (name: string, input: Record<string, unknown>) => {
  const r = await browser.call(name, input);
  return r.kind === "text" ? r.text : "";
};

live("a long page is read 20,000 characters at a time, saying how to read the rest", async () => {
  const offers = Array.from(
    { length: 1000 },
    (_, i) => `<p>Offer ${i}: a used bike in good condition, collected in person.</p>`,
  );
  pages["/long"] = `<!doctype html><body><main>${offers.join("")}</main></body>`;
  await browser.call("navigate", { url: `${base}/long` });
  for (const text of [
    await read("get_page_text", {}),
    await read("read_page", { filter: "all" }),
  ]) {
    const [kept, cut] = text.split("\n[Cut at ");
    expect(kept?.length).toBeGreaterThan(19_000);
    expect(kept?.length).toBeLessThanOrEqual(20_000);
    expect(kept).toContain("Offer 0:");
    expect(cut).toMatch(/^20000 characters\. \S.*\]$/);
  }
});

live("wait ends once the page is quiet, and not while a request is in flight", async () => {
  let release = () => {};
  const slow = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Promise<Response>((answer) => {
        release = () => answer(new Response("ok"));
      }),
  });
  const timed = async (duration: number) => {
    const start = Date.now();
    await browser.call("wait", { duration });
    return Date.now() - start;
  };
  try {
    pages["/quiet"] = "<!doctype html><body>Nothing more to load.</body>";
    await browser.call("navigate", { url: `${base}/quiet` });
    expect(await timed(5)).toBeLessThan(2000);

    pages["/busy"] = `<!doctype html><body><script>
      fetch("http://127.0.0.1:${slow.port}/", { mode: "no-cors" });</script></body>`;
    await browser.call("navigate", { url: `${base}/busy` });
    expect(await timed(1)).toBeGreaterThanOrEqual(1000);
    release();
    expect(await timed(5)).toBeLessThan(2000);
  } finally {
    release();
    slow.stop(true);
  }
});

const refOf = (text: string, line: RegExp) =>
  text
    .split("\n")
    .find((l) => line.test(l))
    ?.match(/\[(ref_\d+)\]/)?.[1];

live(
  "boxes in a wrapper with no box of its own, or in a hidden one, are read and found",
  async () => {
    pages["/wrapped"] = `<!doctype html><body><main><h2>O przedmiocie</h2>
    <div style="display:contents"><label for="t">Tytuł</label><input id="t">
      <label for="d">Opis</label><textarea id="d"></textarea></div>
    <div style="visibility:hidden"><button style="visibility:visible">Pokaż</button><button>Ukryty</button></div>
    </main></body>`;
    await browser.call("navigate", { url: `${base}/wrapped` });
    const text = await read("read_page", { filter: "all" });
    expect(refOf(text, /textbox "Tytuł"/)).toBeDefined();
    expect(refOf(text, /textbox "Opis"/)).toBeDefined();
    expect(text).toContain('button "Pokaż"');
    expect(text).not.toContain("Ukryty");
    expect(await read("find", { query: "Opis" })).toContain('textbox "Opis"');
  },
);

live("form_input puts text with line breaks into a rich editor through the editor", async () => {
  // Like a rich editor: it renders from its own copy of the text, undoes other changes, and takes a paste.
  pages["/editor"] = `<!doctype html><body>
    <div id="rich" contenteditable="true" style="min-height:40px"></div><pre id="model"></pre>
    <div id="plain" contenteditable="true" style="min-height:40px">stary opis</div>
    <script>
      const rich = document.getElementById("rich");
      let model = [""];
      const render = () => {
        rich.innerHTML = model.map((l) => "<p>" + (l || "<br>") + "</p>").join("");
        document.getElementById("model").textContent = model.join("\\n");
      };
      rich.addEventListener("paste", (e) => {
        e.preventDefault();
        model = e.clipboardData.getData("text/plain").split("\\n");
        render();
      });
      rich.addEventListener("input", render);
    </script></body>`;
  await browser.call("navigate", { url: `${base}/editor` });
  const boxes = (await read("read_page", { filter: "interactive" }))
    .split("\n")
    .map((l) => l.match(/\[(ref_\d+)\]/)?.[1]);
  const value = "Mam na sprzedaż komputer.\n\nSpecyfikacje:\n- Procesor: Ryzen 7";
  for (const ref of boxes)
    await browser.call("form_input", { target: { type: "ref", ref }, value });
  const page = await read("get_page_text", {});
  expect(page).toContain(value);
  expect(page).not.toContain("stary opis");
  expect(page.split("Ryzen 7").length).toBe(4);
});
