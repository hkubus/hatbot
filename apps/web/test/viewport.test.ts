import { expect, test } from "bun:test";
import { followViewport } from "../src/viewport";

test("the app is as tall as what the keyboard leaves visible, and pinch zoom isn't a keyboard", () => {
  // A phone's visual viewport, whose size changes as its keyboard comes and goes.
  const listeners: (() => void)[] = [];
  const vv = {
    height: 844,
    scale: 1,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  };
  const resize = (h: number, scale = 1) => {
    vv.height = h;
    vv.scale = scale;
    for (const fn of listeners) fn();
  };
  const props: Record<string, string> = {};
  const root = { style: { setProperty: (k: string, v: string) => (props[k] = v) } };
  const win = {
    scrollY: 0,
    scrollTo: (_: number, y: number) => {
      win.scrollY = y;
    },
  };
  followViewport(vv as unknown as VisualViewport, root, win);
  expect(props["--app-h"]).toBe("844px");

  // iOS opens the keyboard and pans the page up to the field.
  win.scrollY = 336;
  resize(508);
  expect(props["--app-h"]).toBe("508px");
  expect(win.scrollY).toBe(0);
  resize(844);
  expect(props["--app-h"]).toBe("844px");

  resize(422, 2);
  expect(props["--app-h"]).toBe("844px");
});
