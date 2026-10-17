type Viewport = Pick<VisualViewport, "height" | "scale" | "addEventListener">;
type Win = { scrollY: number; scrollTo: (x: number, y: number) => void };

/**
 * Phones: the on-screen keyboard covers the bottom of the screen. Android shrinks the page for it
 * (index.html's interactive-widget); iOS doesn't, and pans the whole app up instead, taking the
 * header off the top. So the app is as tall as what's visible (--app-h), and the composer sits on
 * the keyboard.
 */
export function followViewport(
  vv: Viewport | null | undefined = window.visualViewport,
  root: { style: Pick<CSSStyleDeclaration, "setProperty"> } = document.documentElement,
  win: Win = window,
) {
  if (!vv) return;
  const fit = () => {
    // Pinch zoom shrinks the visual viewport too, but that isn't less room.
    root.style.setProperty("--app-h", `${Math.round(vv.height * vv.scale)}px`);
    if (win.scrollY) win.scrollTo(0, 0);
  };
  fit();
  vv.addEventListener("resize", fit);
}
