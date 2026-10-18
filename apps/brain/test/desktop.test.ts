import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { Desktop } from "../src/desktop/service";
import { EventBus } from "../src/events";
import { FakeDesktop } from "./fake-desktop";

test("you keep control of the desktop across a brain restart", async () => {
  const db = openDb(":memory:");
  const agent = new FakeDesktop();
  const first = new Desktop(agent, new EventBus(), db);
  await first.takeover();
  expect(agent.locked).toBe(true);

  // desktop-agent restarted too and came back unlocked.
  agent.locked = false;
  const again = new Desktop(agent, new EventBus(), db);
  expect(again.get().control).toBe("owner");
  await again.setPaused(false);
  await again.refresh();
  expect(agent.locked).toBe(true);

  await again.handback();
  expect(new Desktop(agent, new EventBus(), db).get().control).toBe("hatbot");
  expect(agent.locked).toBe(false);
});
