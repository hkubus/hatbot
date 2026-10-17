import { expect, test } from "bun:test";
import { followViewport } from "../src/viewport";

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
