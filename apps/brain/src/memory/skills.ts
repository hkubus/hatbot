// The skill files are the truth; the skills_index table and INDEX.md's Skills section follow them.
import { SKILL_NAME } from "@hatbot/shared";
import type { Db } from "../db";
import type { EventBus } from "../events";
import { type Author, blobSha, HATBOT, MemoryConflict, type MemoryStore } from "./store";

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

/** Where the Skills section is among INDEX.md's lines, up to the next heading; start -1: nowhere. */
function sectionAt(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => l.trim() === SECTION);
  const next = start < 0 ? -1 : lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  return { start, end: next < 0 ? lines.length : next };
}

/** INDEX.md with its Skills section listing `skills`; the section goes away when there are none. */
export function withSkillsSection(index: string, skills: SkillInfo[]): string {
  const lines = index.replace(/\s+$/, "").split("\n");
  const { start, end } = sectionAt(lines);
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

function sectionOf(index: string): string {
  const lines = index.split("\n");
  const { start, end } = sectionAt(lines);
  if (start < 0) return "";
  return lines
    .slice(start, end)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

const byName = (a: SkillInfo, b: SkillInfo) => a.name.localeCompare(b.name);

export class Skills {
  constructor(
    private db: Db,
    readonly memory: MemoryStore,
    private clock: () => number = Date.now,
  ) {}

  watch(events: EventBus) {
    events.on((e) => {
      if (e.type === "memory.committed")
        void this.refresh().catch((err) => console.error("skills refresh failed", err));
    });
  }

  private async scan(read: (path: string) => Promise<string | null>): Promise<SkillInfo[]> {
    const found: SkillInfo[] = [];
    for (const f of await this.memory.tree()) {
      const name = /^skills\/([^/]+)\.md$/.exec(f.path)?.[1];
      if (!name || !SKILL_NAME.test(name)) continue;
      const content = await read(f.path);
      if (content !== null) found.push({ name, description: describeSkill(content) });
    }
    return found.sort(byName);
  }

  list(): SkillInfo[] {
    return this.db
      .query<SkillInfo, []>("SELECT name, description FROM skills_index ORDER BY name")
      .all();
  }

  /**
   * Also rewrites INDEX.md's Skills section when that lists something else (a skill written or deleted
   * as a plain file, a tidy-up).
   */
  async refresh(): Promise<SkillInfo[]> {
    let found: SkillInfo[] = [];
    await this.memory.edit(
      async (read) => {
        found = await this.scan(read);
        const index = await read("INDEX.md");
        if (index === null && !found.length) return null;
        const current = index ?? "# Memory index\n";
        const next = withSkillsSection(current, found);
        if (index !== null && sectionOf(current) === sectionOf(next)) return null;
        return [{ path: "INDEX.md", content: next }];
      },
      HATBOT,
      "List the skills in INDEX.md",
    );
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

  /** With `before`, only if the skill is still that (null: it doesn't exist); otherwise MemoryConflict. */
  async save(
    name: string,
    content: string,
    author: Author,
    message = `Add skill ${name}`,
    before?: string | null,
  ): Promise<string | null> {
    // INDEX.md is read and written with no other write in between, so nothing in it is lost, and its
    // list is made from the skill files as they are then.
    const sha = await this.memory.edit(
      async (read) => {
        if (before !== undefined) {
          const now = await read(skillPath(name));
          if (now !== before) throw new MemoryConflict(blobSha(now), now ?? "");
        }
        const others = (await this.scan(read)).filter((s) => s.name !== name);
        const skills = [...others, { name, description: describeSkill(content) }].sort(byName);
        const index = (await read("INDEX.md")) ?? "# Memory index\n";
        return [
          { path: skillPath(name), content },
          { path: "INDEX.md", content: withSkillsSection(index, skills) },
        ];
      },
      author,
      message,
    );
    await this.refresh();
    return sha;
  }

  prompt(): string {
    const skills = this.list();
    if (!skills.length) return "";
    return `<skills>\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}\n</skills>`;
  }
}
