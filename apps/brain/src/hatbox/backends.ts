// Server boxes' backends run on the boxes guest. The brain keeps the files and secrets, the guest only
// the running copies and the secrets in memory. What comes back has the box's secrets taken out.
import type { BoxAnswer, BoxCall } from "@hatbot/shared";
import {
  type BoxBuild,
  type BoxFile,
  type BoxResponse,
  MAX_BOX_BODY,
  passedHeaders,
} from "@hatbot/shared/hatbox";
import { Cron } from "croner";
import { BoxError, type Boxes } from "../boxes";
import type { SettingsStore } from "../settings";
import { type BoxRequest, type HatboxAgent, HatboxError } from "./client";

export const NO_GUEST = "Boxes can't have files or backends here: the boxes guest isn't set up.";
const PAUSED = "Hatbot is paused, so box backends don't run.";
export const BOX_CRON_GAP_MS = 5 * 60_000;
/** How often the guest is told which boxes are gone (deleted while it was down, say). */
const SYNC_MS = 60 * 60_000;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function cronProblem(cron: string, now: number): string | null {
  let runs: Date[];
  try {
    runs = new Cron(cron, { paused: true }).nextRuns(2, new Date(now));
  } catch (err) {
    return `box.json's cron doesn't work: ${(err as Error).message}`;
  }
  if (!runs[0]) return "box.json's cron never runs.";
  if (runs[1] && runs[1].getTime() - runs[0].getTime() < BOX_CRON_GAP_MS)
    return "A box's schedule runs at most every 5 minutes.";
  return null;
}

export class Backends {
  private running = new Set<number>();
  private synced = 0;

  constructor(
    private boxes: Boxes,
    private agent: HatboxAgent,
    private settings: SettingsStore,
    private clock: () => number,
  ) {}

  get available(): boolean {
    return this.agent.configured;
  }

  async build(id: number, version: number, files: BoxFile[]): Promise<BoxBuild> {
    if (!this.agent.configured) throw new BoxError(NO_GUEST, 503);
    const built = await this.guest(id, () => this.agent.build(id, version, files));
    return { ...built, output: this.boxes.redact(id, built.output) };
  }

  private async guest<T>(id: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HatboxError && !err.missing && !err.secrets)
        throw new BoxError(this.boxes.redact(id, err.message), 502);
      throw err;
    }
  }

  private async current<T>(
    id: number,
    fn: (version: number, secrets: string) => Promise<T>,
  ): Promise<T> {
    if (!this.agent.configured) throw new BoxError(NO_GUEST, 503);
    if (this.settings.get().paused) throw new BoxError(PAUSED, 503);
    const box = this.boxes.get(id);
    if (!box) throw new BoxError(`There's no box #${id}.`, 404);
    if (!this.boxes.server(id)) throw new BoxError(`Box #${id} has no backend.`);
    const secrets = this.boxes.secretValues(id);
    let built = false;
    let sent = false;
    for (;;) {
      try {
        return await this.guest(id, () => fn(box.version, secrets.digest));
      } catch (err) {
        if (!(err instanceof HatboxError)) throw err;
        if (err.secrets && !sent) {
          sent = true;
          await this.guest(id, () => this.agent.secrets(id, secrets));
        } else if (err.missing && !built) {
          built = true;
          if (!(await this.build(id, box.version, this.boxes.files(id))).ok)
            throw new BoxError(
              `Box #${id} doesn't build on the boxes guest now; box_logs may say why.`,
              502,
            );
        } else throw new BoxError(this.boxes.redact(id, err.message), 502);
      }
    }
  }

  async request(id: number, r: BoxRequest): Promise<Response> {
    const method = r.method.toUpperCase();
    if (!METHODS.has(method)) throw new BoxError(`A box's backend doesn't take ${r.method}.`);
    if (r.body && r.body.byteLength > MAX_BOX_BODY)
      throw new BoxError("A request to a box carries at most 5 MB.", 413);
    const body = method === "GET" || method === "HEAD" ? undefined : r.body;
    const res = await this.current(id, (version, secrets) =>
      this.agent.http(id, version, secrets, { ...r, method, body }),
    );
    return this.redacted(id, res);
  }

  /**
   * Its code could still hide a secret (in base64, say); this keeps one it prints by mistake from
   * reaching the page or the model.
   */
  private async redacted(id: number, res: Response): Promise<Response> {
    if (!this.boxes.hasSecrets(id)) return res;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let body: Uint8Array | string = bytes;
    try {
      body = this.boxes.redact(id, utf8.decode(bytes));
    } catch {}
    const headers = passedHeaders(res.headers).map(
      ([k, v]) => [k, this.boxes.redact(id, v)] as [string, string],
    );
    return new Response([101, 204, 205, 304].includes(res.status) ? null : body, {
      status: res.status,
      headers,
    });
  }

  /** The guest restarts a running backend with them. */
  async sendSecrets(id: number): Promise<void> {
    if (!this.agent.configured || !this.boxes.server(id)) return;
    // One the guest misses now, it gets with the backend's next request.
    await this.agent
      .secrets(id, this.boxes.secretValues(id))
      .catch((err) => console.error(`couldn't send box #${id}'s secrets to the guest`, err));
  }

  async fetch(id: number, c: Extract<BoxCall, { op: "fetch" }>): Promise<BoxAnswer> {
    const res = await this.request(id, {
      method: c.method ?? "GET",
      path: c.path,
      // The brain's own token goes in authorization on the way to the guest.
      headers: passedHeaders(c.headers ?? {}, ["authorization"]),
      body: c.body === undefined ? undefined : Buffer.from(c.body, c.base64 ? "base64" : "utf8"),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const headers = Object.fromEntries(res.headers);
    let value: BoxResponse;
    try {
      value = { status: res.status, headers, body: utf8.decode(bytes) };
    } catch {
      value = {
        status: res.status,
        headers,
        body: Buffer.from(bytes).toString("base64"),
        base64: true,
      };
    }
    return { value };
  }

  async logs(id: number): Promise<string> {
    if (!this.agent.configured) throw new BoxError(NO_GUEST, 503);
    if (!this.boxes.get(id)) throw new BoxError(`There's no box #${id}.`, 404);
    return this.boxes.redact(id, await this.guest(id, () => this.agent.logs(id)));
  }

  async tick(): Promise<void> {
    if (!this.agent.configured || this.settings.get().paused) return;
    const now = this.clock();
    const runs: Promise<unknown>[] = [];
    for (const b of this.boxes.scheduled()) {
      if (this.running.has(b.id)) continue;
      if (b.ranAt && now - Date.parse(b.ranAt) < BOX_CRON_GAP_MS) continue;
      let next: Date | null = null;
      try {
        next = new Cron(b.cron, { paused: true }).nextRun(new Date(b.since));
      } catch {}
      if (!next || next.getTime() > now) continue;
      this.boxes.ran(b.id, new Date(now).toISOString());
      this.running.add(b.id);
      runs.push(
        this.current(b.id, (version, secrets) => this.agent.scheduled(b.id, version, secrets))
          .then((r) =>
            r.ok
              ? r.notify && this.notify(b.id, r.notify)
              : console.error(
                  `box #${b.id}'s scheduled() failed: ${this.boxes.redact(b.id, r.error ?? "")}`,
                ),
          )
          .catch((err) => console.error(`box #${b.id}'s schedule didn't run`, err))
          .finally(() => this.running.delete(b.id)),
      );
    }
    if (now - this.synced >= SYNC_MS) {
      this.synced = now;
      runs.push(this.sync().catch((err) => console.error("boxes guest sync failed", err)));
    }
    await Promise.all(runs);
  }

  private async notify(id: number, text: string) {
    const said = this.boxes.redact(id, text).trim();
    if (!said) return;
    // A run that started before Pause all ends after it.
    const refused = this.settings.get().paused ? "Hatbot is paused." : this.boxes.notify(id, said);
    if (refused)
      await this.agent
        .note(id, `Not notified: ${refused} It said: ${said.slice(0, 200)}`)
        .catch(() => {});
  }

  private async sync() {
    const have = new Set(this.boxes.list().map((b) => b.id));
    for (const g of await this.agent.boxes()) if (!have.has(g.id)) await this.agent.remove(g.id);
  }

  /** They start again on a request once Hatbot is resumed. */
  async stopAll(): Promise<void> {
    if (!this.agent.configured) return;
    try {
      for (const g of await this.agent.boxes()) await this.agent.stop(g.id);
    } catch (err) {
      console.error("couldn't stop the boxes' backends", err);
    }
  }

  /** One the guest misses now goes at the next sync. */
  async remove(id: number): Promise<void> {
    if (!this.agent.configured) return;
    await this.agent.remove(id).catch(() => {});
  }
}
