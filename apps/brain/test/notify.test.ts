import { expect, test } from "bun:test";
import { ORIGIN, setUpOwner, testApp, waitFor } from "./helpers";

test("an approval's notification keeps its whole summary, opens the iOS app when Settings say so, and its buttons still call the brain", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const res = await t.call("PUT", "/settings", { notificationsOpen: "app" }, { cookie });
  expect(res.status).toBe(200);
  // Every client hears of the change.
  expect(t.events.at(-1)).toMatchObject({
    type: "settings.updated",
    settings: { notificationsOpen: "app" },
  });
  const command = `On pve: ${"journalctl -u ntfy -n 50; ".repeat(10)}systemctl restart ntfy`;
  const a = t.approvals.create({ taskId: null, kind: "other", summary: command });
  const n = await waitFor(() => t.notifier.sent.find((x) => x.title.startsWith("Approve")));
  expect(n.title.length).toBeLessThanOrEqual(120);
  expect(n.message).toContain(command);
  expect(n.click).toBe(`hatbot://approvals/${a.id}`);
  expect(n.actions?.[0]?.url).toBe(`${ORIGIN}/api/v1/approvals/${a.id}/token-decision`);
});
