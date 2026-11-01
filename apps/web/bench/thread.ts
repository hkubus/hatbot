import { msg } from "../test/fixtures";

/** `n` messages of a chat with Hatbot: questions and markdown replies. */
export const thread = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? msg(i + 1, { role: "user", text: `Question ${i} **bold**`, botId: null })
      : msg(i + 1, {
          text: `## Answer ${i}\n\n**bold** text and a [link](https://example.com) and \`code\`.\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |`,
        }),
  );
