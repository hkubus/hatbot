import { expect, test } from "bun:test";
import { followViewport } from "../src/viewport";

/** Each rule in the stylesheet whose selector matches, with the @media it sits in. */
async function rulesFor(match: (selector: string) => boolean) {
  const css = (await Bun.file(new URL("../src/styles.css", import.meta.url)).text()).replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const found: { selector: string; media: string[] }[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      const prelude = css.slice(start, i).trim();
      if (!prelude.startsWith("@") && match(prelude))
        found.push({ selector: prelude, media: stack.filter((p) => p.startsWith("@media")) });
      stack.push(prelude);
      start = i + 1;
    } else if (css[i] === "}") {
      stack.pop();
      start = i + 1;
    } else if (css[i] === ";") start = i + 1;
  }
  return found;
}

test("the tab bar steps aside for a field only on a touch screen, so a mouse keeps it", async () => {
  const rules = await rulesFor((s) => s.includes(":focus)") && /\.(tabbar|main)\b/.test(s));
  expect(rules.length).toBe(2);
  for (const r of rules) expect(r.media.join(" ")).toContain("(hover: none)");
});

/** A visual viewport whose size changes, like a phone's when its keyboard comes and goes. */
function phone(height: number) {
  const listeners: (() => void)[] = [];
  const vv = {
    height,
    scale: 1,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  };
  const props: Record<string, string> = {};
  const root = { style: { setProperty: (k: string, v: string) => (props[k] = v) } };
  const win = {
    scrollY: 0,
    scrollTo: (_: number, y: number) => {
      win.scrollY = y;
    },
  };
  const resize = (h: number, scale = 1) => {
    vv.height = h;
    vv.scale = scale;
    for (const fn of listeners) fn();
  };
  return { vv: vv as unknown as VisualViewport, root, win, props, resize };
}

test("the app is as tall as what the keyboard leaves visible, and grows back when it goes", () => {
  const p = phone(844);
  followViewport(p.vv, p.root, p.win);
  expect(p.props["--app-h"]).toBe("844px");

  // iOS opens the keyboard and pans the page up to the field.
  p.win.scrollY = 336;
  p.resize(508);
  expect(p.props["--app-h"]).toBe("508px");
  expect(p.win.scrollY).toBe(0);

  p.resize(844);
  expect(p.props["--app-h"]).toBe("844px");
});

test("pinch zoom isn't taken for a keyboard", () => {
  const p = phone(844);
  followViewport(p.vv, p.root, p.win);
  p.resize(422, 2);
  expect(p.props["--app-h"]).toBe("844px");
});

test("without a visual viewport nothing is set, and 100dvh stays", () => {
  const p = phone(844);
  followViewport(null, p.root, p.win);
  expect(p.props["--app-h"]).toBeUndefined();
});
