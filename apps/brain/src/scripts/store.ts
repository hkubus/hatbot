import { PluginError } from "@hatbot/plugin-sdk";
import { HATBOT_ID, type Script, type ScriptInput, type ScriptStep } from "@hatbot/shared";
import type { Db } from "../db";
import type { EventBus } from "../events";

type Row = {
  id: number;
  bot_id: string;
  name: string;
  description: string;
  inputs: string;
  steps: string;
  writes: string;
  approved: number;
  enabled: number;
  created_via: Script["createdVia"];
  tainted: number;
  tainted_by: string | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_task_id: number | null;
};

const SELECT = `SELECT s.*, (SELECT max(id) FROM tasks t WHERE t.runner = 'script'
  AND json_extract(t.job, '$.script') = s.id AND t.parent_id IS NULL) AS last_task_id FROM scripts s`;

const toScript = (r: Row): Script => ({
  id: r.id,
  botId: r.bot_id,
  name: r.name,
  description: r.description,
  inputs: JSON.parse(r.inputs),
  steps: JSON.parse(r.steps),
  writes: JSON.parse(r.writes),
  approved: Boolean(r.approved),
  enabled: Boolean(r.enabled),
  createdVia: r.created_via,
  tainted: Boolean(r.tainted),
  taintedBy: r.tainted_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastRunAt: r.last_run_at,
  lastTaskId: r.last_task_id,
});

export type ScriptFields = {
  botId: string;
  name: string;
  description: string;
  inputs: ScriptInput[];
  steps: ScriptStep[];
  writes: string[];
  enabled: boolean;
};

/** The same steps and inputs: what an approval was given for. */
export const sameSteps = (
  a: Pick<Script, "steps" | "inputs">,
  b: Pick<Script, "steps" | "inputs">,
) => JSON.stringify([a.steps, a.inputs]) === JSON.stringify([b.steps, b.inputs]);

export class ScriptStore {
  constructor(
    private db: Db,
    private events: EventBus,
    private clock: () => number,
  ) {}

  private now() {
    return new Date(this.clock()).toISOString();
  }

  list(botId?: string): Script[] {
    const rows =
      botId === undefined
        ? this.db.query<Row, []>(`${SELECT} ORDER BY s.name, s.id`).all()
        : this.db.query<Row, [string]>(`${SELECT} WHERE s.bot_id = ? ORDER BY s.name`).all(botId);
    return rows.map(toScript);
  }

  get(id: number): Script | null {
    const r = this.db.query<Row, [number]>(`${SELECT} WHERE s.id = ?`).get(id);
    return r ? toScript(r) : null;
  }

  byName(botId: string, name: string): Script | null {
    const r = this.db
      .query<Row, [string, string]>(`${SELECT} WHERE s.bot_id = ? AND s.name = ?`)
      .get(botId, name);
    return r ? toScript(r) : null;
  }

  private changed(id: number) {
    const script = this.get(id);
    if (script) this.events.emit({ type: "script.updated", script });
    return script;
  }

  /**
   * A new one, or `id` changed. `approved`: you saw these steps, through the chat's approval or by
   * saving them yourself; without it, steps that change things need approving again.
   */
  save(
    fields: ScriptFields,
    o: { id?: number; via: Script["createdVia"]; approved: boolean; taintedBy: string | null },
  ): Script {
    const clash = this.byName(fields.botId, fields.name);
    if (clash && clash.id !== o.id)
      throw new PluginError(`There's already a script called ${fields.name}.`);
    const now = this.now();
    const row = {
      bot_id: fields.botId,
      name: fields.name,
      description: fields.description,
      inputs: JSON.stringify(fields.inputs),
      steps: JSON.stringify(fields.steps),
      writes: JSON.stringify(fields.writes),
      enabled: fields.enabled ? 1 : 0,
    };
    const old = o.id === undefined ? null : this.get(o.id);
    const approved = o.approved || (old?.approved === true && sameSteps(old, fields));
    // Saving it yourself makes it yours; the chat's change after untrusted content taints it.
    const tainted =
      o.via === "owner" ? null : (o.taintedBy ?? (old?.tainted ? old.taintedBy : null));
    if (!old) {
      const id = this.db
        .query<{ id: number }, (string | number | null)[]>(
          `INSERT INTO scripts (bot_id, name, description, inputs, steps, writes, enabled, approved,
            created_via, tainted, tainted_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(...Object.values(row), approved ? 1 : 0, o.via, tainted ? 1 : 0, tainted, now, now)
        ?.id as number;
      return this.changed(id) as Script;
    }
    this.db
      .query(
        `UPDATE scripts SET bot_id = ?, name = ?, description = ?, inputs = ?, steps = ?, writes = ?,
          enabled = ?, approved = ?, tainted = ?, tainted_by = ?, updated_at = ? WHERE id = ?`,
      )
      .run(...Object.values(row), approved ? 1 : 0, tainted ? 1 : 0, tainted, now, old.id);
    return this.changed(old.id) as Script;
  }

  setEnabled(id: number, enabled: boolean): Script | null {
    this.db.query("UPDATE scripts SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return this.changed(id);
  }

  ran(id: number) {
    this.db.query("UPDATE scripts SET last_run_at = ? WHERE id = ?").run(this.now(), id);
    this.changed(id);
  }

  /** The schedules and watchers that run it, by name. */
  usedBy(id: number): string[] {
    return this.db
      .query<{ what: string }, [number, number]>(
        `SELECT 'the schedule "' || name || '"' AS what FROM schedules WHERE script_id = ?
         UNION ALL SELECT 'the watcher "' || name || '"' FROM watchers WHERE script_id = ?`,
      )
      .all(id, id)
      .map((r) => r.what);
  }

  delete(id: number): boolean {
    const users = this.usedBy(id);
    if (users.length)
      throw new PluginError(`Not deleted: ${users.join(" and ")} runs it. Change that first.`);
    const gone = this.db.query("DELETE FROM scripts WHERE id = ?").run(id).changes > 0;
    if (gone) this.events.emit({ type: "script.deleted", id });
    return gone;
  }

  /** A deleted bot's scripts go to Hatbot switched off, renamed where Hatbot has one by that name. */
  moveFrom(botId: string) {
    for (const s of this.list(botId)) {
      const name = this.byName(HATBOT_ID, s.name) ? `${s.name}-${botId}`.slice(0, 48) : s.name;
      this.db
        .query("UPDATE scripts SET bot_id = ?, name = ?, enabled = 0 WHERE id = ?")
        .run(HATBOT_ID, name, s.id);
      this.changed(s.id);
    }
  }
}
