import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeSocket, installDom, settle } from "./dom";

installDom();
const { connect, disconnect } = await import("../src/store");
const { PausedBanner } = await import("../src/App");

test("Pause all shows on every page, however it was set, with Resume", async () => {
  connect();
  FakeSocket.last.open();
  expect(renderToStaticMarkup(<PausedBanner />)).toBe("");
  // Paused from ntfy or another device: the stream says so.
  FakeSocket.last.emit({ type: "paused", paused: true });
  const html = renderToStaticMarkup(<PausedBanner />);
  expect(html).toContain("All activity is paused.");
  expect(html).toContain(">Resume</button>");
  FakeSocket.last.emit({ type: "paused", paused: false });
  expect(renderToStaticMarkup(<PausedBanner />)).toBe("");
  disconnect();
  await settle();
});
