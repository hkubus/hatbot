// ask_owner (PLAN.md §20): a question for the owner, with answers to tap. In the chat it ends the reply
// and the owner's next message answers it; a background task waits for the answer.
import { MAX_CHOICE_CHARS, MAX_CHOICES } from "@hatbot/shared";
import { z } from "zod";

export const AskOwner = z.object({
  question: z.string().trim().min(1).max(1000).describe("One question, as you'd write it to them"),
  choices: z
    .array(z.string().trim().min(1).max(MAX_CHOICE_CHARS))
    .max(MAX_CHOICES)
    .default([])
    .describe(
      "The likely answers, each a few words, as the owner would say them; they tap one or write their own. Leave out for an open question",
    ),
});

export const TaskAskOwner = AskOwner.extend({
  wait_hours: z
    .number()
    .min(0.25)
    .max(24)
    .default(4)
    .describe("How long the answer is worth waiting for; then you carry on without it"),
});

const NOT_FOR =
  "Never ask for passwords, codes or card numbers: logins and payments go through the desktop, where the owner takes over.";

export const CHAT_ASK_DESCRIPTION = `Ask the owner a question they need to decide or fill in before you can go on, with the likely answers as buttons. Your reply ends with it, and their next message is the answer. One question at a time, and only when the answer changes what you do; otherwise go ahead and say what you assumed. Call it on its own, after any other tools. ${NOT_FOR}`;

export const TASK_ASK_DESCRIPTION = `Ask the owner something only they can decide, and wait for the answer: which of two accounts, whether to spend more, what they meant. The task pauses without using the model until they answer in the app or the time runs out. At most 3 per task; when you can decide sensibly yourself, do, and say what you assumed in finish_task. ${NOT_FOR}`;

/** How the owner's answer reaches the model: it's theirs, so it's followed. */
export const ownerAnswer = (answer: string) =>
  `The owner answered:\n<owner_answer>\n${answer}\n</owner_answer>`;
