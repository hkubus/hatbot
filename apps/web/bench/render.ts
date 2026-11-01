// How long the chat page takes for one streamed delta, over a thread of N messages.
//   N=400 FRAMES=20 bun --preload ./bench/preload.ts bench/render.ts
import type { FakeSocket } from "../test/dom";
import { settle } from "../test/dom";
import { chatCase } from "./case";

const dom = chatCase(Number(process.env.N ?? 120));
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const Chat = await import("../src/pages/Chat");
const store = await import("../src/store");

const g = globalThis as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
const N = dom.thread.length;
const frames = Number(process.env.FRAMES ?? 30);
// The app's own stream: a fake socket it can hear events on.
store.connect();
const events = (globalThis as unknown as { WebSocket: { all: FakeSocket[] } }).WebSocket.all.at(
  -1,
) as FakeSocket;
(dom.thread.at(-1) as { status: string }).status = "streaming";
const target = dom.thread.at(-1) as { id: number; text: string };

const root = createRoot(dom.container);
await act(async () => {
  root.render(createElement(Chat.Chat, { id: 1 }));
});
await settle();
while (store.getState().messages.length < N) await act(async () => settle());

const t0 = performance.now();
for (let f = 0; f < frames; f++) {
  const piece = `\n\nmore **text ${f}**`;
  target.text += piece;
  await act(async () => {
    events.emit({ type: "message.delta", id: target.id, text: piece, at: undefined });
    dom.flushFrames();
  });
}
const ms = performance.now() - t0;
console.log(
  `${N} messages, ${frames} deltas: ${Math.round(ms)} ms, ${(ms / frames).toFixed(2)} ms each`,
);
await act(async () => {
  root.unmount();
});
