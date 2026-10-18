import { expect, test } from "bun:test";
import type { Question } from "@hatbot/shared";
import { FakeModel, text, toolUse } from "./fake-model";
import { signIn, testApp, waitFor } from "./helpers";
import { ended, finish, scheduled } from "./plugin-helpers";

test("the chat asks with answers to tap: the reply ends there, and the next message answers it", async () => {
  const model = new FakeModel([
    {
      content: [
        toolUse("memory_read", { path: "INDEX.md" }),
        toolUse("ask_owner", { question: "Which one?", choices: ["Mine"] }),
      ],
    },
    {
      content: [
        text("Two left."),
        toolUse("ask_owner", { question: "Which day suits you?", choices: ["Friday", "Saturday"] }),
      ],
    },
    { content: [text("Saturday it is.")] },
  ]);
  const t = await testApp(model);
  await t.thread.post("book the boiler service").done;
  // Asked alongside another tool, it's sent back; on its own, the reply ends with it.
  expect(JSON.stringify(model.requests[1]?.messages)).toContain("call ask_owner on its own");
  expect(model.requests).toHaveLength(2);
  const done = t.events.findLast((e) => e.type === "message.done");
  expect(done).toMatchObject({
    text: "Two left.\n\n---\n\nWhich day suits you?",
    choices: ["Friday", "Saturday"],
  });

  // A tapped choice is the owner's message; the call's result goes with it.
  await t.thread.post("Saturday").done;
  const last = model.requests[2]?.messages.at(-1);
  expect(JSON.stringify(last?.content)).toMatch(/Asked\..*Saturday/);
});

test("a task waits for the owner's answer, carries on without one when time runs out, and asks at most 3", async () => {
  const ask = (question: string) => ({
    content: [toolUse("ask_owner", { question, choices: ["Yes", "No"], wait_hours: 1 })],
  });
  const work = new FakeModel([
    ask("Renew for 1 year or 3?"),
    ask("Use the saved card?"),
    ask("Turn on auto-renew?"),
    ask("Anything else?"),
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = signIn(t);
  const pending = () => waitFor(() => t.questions.pending()[0]);
  const answer = (q: Question, answer: string) =>
    t.call("POST", `/questions/${q.id}`, { answer }, { cookie });
  const task = scheduled(t, "Renew the domain");

  const first = await pending();
  expect(t.tasks.get(task.id)?.status).toBe("waiting_answer");
  expect(t.notifier.sent.at(-1)?.message).toBe("Renew for 1 year or 3?\n- Yes\n- No");
  expect((await answer(first, "3 years")).status).toBe(200);
  expect((await answer(first, "1 year")).status).toBe(409);

  await pending();
  t.advance(3600_000);
  t.questions.expireDue();
  await answer(await pending(), "No");

  const done = await ended(t, task.id);
  expect(done.status).toBe("done");
  const results = work.requests.map((r) => JSON.stringify(r.messages.at(-1)?.content));
  expect(results[1]).toContain("3 years");
  expect(results[2]).toContain("No answer within an hour");
  expect(results[4]).toContain("a task asks at most 3");
});
