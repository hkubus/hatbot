/** A line that opens or closes a fenced code block. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A streaming reply cut into the blocks it has finished and the one still growing: at blank lines
 * outside code fences, where the next line starts at the margin. Each finished block is parsed once,
 * and only the last again as text streams in; once the reply is done it's parsed whole, so anything
 * the cuts split (a loose list, a footnote) comes right.
 */
export function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      // Closed by the same character, at least as many, and nothing after.
      if (f && f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length).trim())
        fence = "";
      continue;
    }
    if (f) {
      fence = f;
      continue;
    }
    if (line.trim() === "" && /^\S/.test(lines[i + 1] ?? "")) {
      const block = lines.slice(start, i).join("\n");
      if (block.trim()) blocks.push(block);
      start = i + 1;
    }
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}
