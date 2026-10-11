import { expect, test } from "bun:test";
import { appLink } from "../src/notify";
import { FakeModel, toolUse } from "./fake-model";
import { ORIGIN, setUpOwner, testApp, waitFor } from "./helpers";

test("web pages map to the iOS app's links", () => {
  expect(appLink(`${ORIGIN}/tasks/12?live=1`, ORIGIN)).toBe("hatbot://tasks/12");
  expect(appLink(`${ORIGIN}/?approval=5`, ORIGIN)).toBe("hatbot://approvals/5");
  expect(appLink(`${ORIGIN}/triggers/3`, ORIGIN)).toBe("hatbot://triggers/3");
  expect(appLink(`${ORIGIN}/memory`, ORIGIN)).toBeNull();
  expect(appLink("https://elsewhere.test/tasks/1", ORIGIN)).toBeNull();
});

test("notifications open the web app, or the iOS app when Settings say so", async () => {
  const work = new FakeModel([
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Send the email" })] },
    { content: [toolUse("finish_task", { outcome: "blocked", summary: "Not sent." })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = await setUpOwner(t);
  expect(t.settings.get().notificationsOpen).toBe("web");
  const res = await t.call("PUT", "/settings", { notificationsOpen: "app" }, { cookie });
  expect(res.status).toBe(200);
  t.tasks.createDesktopTask({ title: "Email", goal: "Email", successCriteria: "", origin: "chat" });
  const n = await waitFor(() => t.notifier.sent.find((x) => x.title.startsWith("Approve")));
  const id = t.approvals.list(true)[0]?.id;
  expect(n.click).toBe(`hatbot://approvals/${id}`);
  // The signed Approve and Deny buttons still call the brain.
  expect(n.actions?.[0]?.url).toBe(`${ORIGIN}/api/v1/approvals/${id}/token-decision`);
  await t.call("PUT", "/settings", { notificationsOpen: "web" }, { cookie });
  t.approvals.decide(id as number, "deny", "web");
  await t.tasks.idle();
  const ended = t.notifier.sent.at(-1);
  expect(ended?.click).toStartWith(`${ORIGIN}/tasks/`);
});

test("a long approval keeps its whole summary in the notification", async () => {
  const t = await testApp(new FakeModel(), new FakeModel());
  const command = `On pve: ${"journalctl -u ntfy -n 50; ".repeat(10)}systemctl restart ntfy`;
  t.approvals.create({ taskId: null, kind: "other", summary: command });
  const n = await waitFor(() => t.notifier.sent.find((x) => x.title.startsWith("Approve")));
  expect(n.title).toHaveLength(120);
  expect(n.title).toEndWith("…");
  expect(n.message).toContain(command);
});
