// Skills (PLAN.md §7.2): reusable procedures in skills/<name>.md, from teach-by-showing or written after tasks.
// The files are the truth; the skills_index table and INDEX.md's Skills section follow them.
import { SKILL_NAME } from "@hatbot/shared";
import type { Db } from "../db";
import type { EventBus } from "../events";
import type { Author, MemoryStore } from "../memory/store";

export type SkillInfo = { name: string; description: string };

const SECTION = "## Skills";

export const skillPath = (name: string) => `skills/${name}.md`;

/** The front matter's description, else the first line of a "When to use" section, else the title. */
export function describeSkill(content: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  const desc = /^description:\s*(.+)$/m
    .exec(front)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (desc) return desc.slice(0, 300);
  const when = /^##+\s*When to use\s*\n+([^\n#][^\n]*)/im.exec(content)?.[1]?.trim();
  if (when) return when.replace(/^[-*]\s*/, "").slice(0, 300);
  return (/^#\s+(.+)$/m.exec(content)?.[1] ?? "").trim().slice(0, 300);
}

/** INDEX.md with its Skills section listing `skills`; the section goes away when there are none. */
export function withSkillsSection(index: string, skills: SkillInfo[]): string {
  const lines = index.replace(/\s+$/, "").split("\n");
  const start = lines.findIndex((l) => l.trim() === SECTION);
  let end = lines.length;
  if (start >= 0) {
    const next = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
    if (next >= 0) end = next;
  }
  const section = skills.length
    ? [SECTION, "", ...skills.map((s) => `- ${skillPath(s.name)}: ${s.description}`), ""]
    : [];
  const out =
    start >= 0
      ? [...lines.slice(0, start), ...section, ...lines.slice(end)]
      : [...lines, "", ...section];
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

export class Skills {
  constructor(
    private db: Db,
    readonly memory: MemoryStore,
    private clock: () => number = Date.now,
  ) {}

  /** Keeps the index current as memory changes. */
  watch(events: EventBus) {
    events.on((e) => {
      if (e.type === "memory.committed")
        void this.refresh().catch((err) => console.error("skills refresh failed", err));
    });
  }

  /** The skills index, for task prompts. */
  list(): SkillInfo[] {
    return this.db
      .query<SkillInfo, []>("SELECT name, description FROM skills_index ORDER BY name")
      .all();
  }

  /** Reads skills/ into the index. Run at start and after memory commits (Hatbot and you edit files too). */
  async refresh(): Promise<SkillInfo[]> {
    const found: SkillInfo[] = [];
    for (const f of await this.memory.tree()) {
      const name = /^skills\/([^/]+)\.md$/.exec(f.path)?.[1];
      if (!name || !SKILL_NAME.test(name)) continue;
      found.push({ name, description: describeSkill(await this.memory.read(f.path)) });
    }
    const now = new Date(this.clock()).toISOString();
    this.db.transaction(() => {
      this.db.query("DELETE FROM skills_index").run();
      const insert = this.db.query(
        "INSERT INTO skills_index (name, description, updated_at) VALUES (?, ?, ?)",
      );
      for (const s of found) insert.run(s.name, s.description, now);
    })();
    return found;
  }

  /** Writes a skill and lists it in INDEX.md, in one commit. */
  async save(name: string, content: string, author: Author): Promise<string | null> {
    const others = this.list().filter((s) => s.name !== name);
    const skills = [...others, { name, description: describeSkill(content) }].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const index = (await this.memory.exists("INDEX.md"))
      ? await this.memory.read("INDEX.md")
      : "# Memory index\n";
    const sha = await this.memory.writeAll(
      [
        { path: skillPath(name), content },
        { path: "INDEX.md", content: withSkillsSection(index, skills) },
      ],
      author,
      `Add skill ${name}`,
    );
    await this.refresh();
    return sha;
  }

  /** The skills list for a task prompt, or "" when there are none. */
  prompt(): string {
    const skills = this.list();
    if (!skills.length) return "";
    return `<skills>\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}\n</skills>`;
  }
}
