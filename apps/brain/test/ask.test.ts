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
        toolUse("ask_owner", { questions: [{ question: "Which one?", choices: ["Mine"] }] }),
      ],
    },
    {
      content: [
        text("Two left."),
        toolUse("ask_owner", {
          questions: [
            { question: "Which day suits you?", choices: ["Friday", "Saturday"] },
            { question: "Anything the engineer should know?" },
          ],
        }),
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
    text: "Two left.\n\n---\n\n1. Which day suits you?\n2. Anything the engineer should know?",
    choices: [["Friday", "Saturday"], []],
  });

  // The answers are the owner's message; the call's result goes with it.
  await t.thread.post("1. Saturday\n2. The dog's friendly").done;
  const last = model.requests[2]?.messages.at(-1);
  expect(JSON.stringify(last?.content)).toMatch(/Asked\..*Saturday/);
});

test("a task waits for every answer, from the app or the notification, carries on without them when time runs out, and asks at most 3 times", async () => {
  const ask = (...questions: string[]) => ({
    content: [
      toolUse("ask_owner", {
        questions: questions.map((question) => ({ question, choices: ["Yes", "No"] })),
        wait_hours: 1,
      }),
    ],
  });
  const work = new FakeModel([
    ask("Renew for 3 years?", "Turn on auto-renew?"),
    ask("Use the saved card?"),
    ask("Anything else?"),
    ask("One more?"),
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = signIn(t);
  const pending = (n = 1) =>
    waitFor(() => (t.questions.pending().length === n ? t.questions.pending() : null));
  const answer = (q: Question, answer: string) =>
    t.call("POST", `/questions/${q.id}`, { answer }, { cookie });
  const task = scheduled(t, "Renew the domain");

  const [renew, auto] = (await pending(2)) as Question[];
  expect(t.tasks.get(task.id)?.status).toBe("waiting_answer");
  // The notification's buttons answer with their own choice, and only for their own question.
  const [yes, no] = (t.notifier.sent.at(-2)?.actions ?? []) as { url: string; body: string }[];
  expect(yes?.url).toBe(`https://hatbot.test/api/v1/questions/${renew?.id}/token-answer`);
  const token = (b?: { body: string }) => JSON.parse(b?.body ?? "") as { choice: number };
  const tap = (q: Question | undefined, body: unknown) =>
    t.call("POST", `/questions/${q?.id}/token-answer`, body, { origin: "" });
  expect((await tap(renew, { ...token(yes), choice: 1 })).status).toBe(403);
  expect((await tap(auto, token(yes))).status).toBe(403);
  expect((await tap(renew, token(no))).status).toBe(200);
  expect((await tap(renew, token(yes))).status).toBe(409);
  // It waits for every answer.
  expect(t.tasks.get(task.id)?.status).toBe("waiting_answer");
  expect((await answer(auto as Question, "Yes")).status).toBe(200);

  await pending();
  t.advance(3600_000);
  t.questions.expireDue();
  await answer((await pending())[0] as Question, "No");

  const done = await ended(t, task.id);
  expect(done.status).toBe("done");
  const results = work.requests.map((r) => JSON.stringify(r.messages.at(-1)?.content));
  expect(results[1]).toMatch(/Renew for 3 years.*No.*auto-renew.*Yes/);
  expect(results[2]).toContain("No answer within an hour");
  expect(results[4]).toContain("at most 3 times");
});
