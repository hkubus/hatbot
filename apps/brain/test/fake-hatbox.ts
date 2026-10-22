import type {
  BoxBuild,
  BoxFile,
  BoxRun,
  BoxSecrets,
  GuestBox,
  HatboxStatus,
} from "@hatbot/shared/hatbox";
import { type BoxRequest, type HatboxAgent, HatboxError } from "../src/hatbox/client";

/** The boxes guest, in memory: a build's page is index.html as it is, and a backend answers as the test says. */
export class FakeHatbox implements HatboxAgent {
  configured = true;
  /** The version of each box's backend the guest has built. */
  built = new Map<number, number>();
  builds: { id: number; version: number; files: BoxFile[] }[] = [];
  /** The next build fails, printing this. */
  failBuild: string | null = null;
  backend: (req: BoxRequest) => Response | Promise<Response> = () => new Response("ok");
  runs: number[] = [];
  /** What the next scheduled() run gives back. */
  run: BoxRun = { ok: true };
  secretsOf = new Map<number, BoxSecrets>();
  /** The lines the brain wrote in the boxes' logs. */
  notes: string[] = [];
  stopped: number[] = [];
  log = "";

  async status(): Promise<HatboxStatus> {
    return { ok: true };
  }
  async boxes(): Promise<GuestBox[]> {
    return [...this.built].map(([id, version]) => ({ id, version }));
  }
  async build(id: number, version: number, files: BoxFile[]): Promise<BoxBuild> {
    this.builds.push({ id, version, files });
    const output = this.failBuild;
    this.failBuild = null;
    if (output !== null) return { ok: false, output };
    if (files.some((f) => f.path === "server.ts")) this.built.set(id, version);
    else this.built.delete(id);
    return {
      ok: true,
      page: files.find((f) => f.path === "index.html")?.content,
      output: "Built.",
    };
  }
  private has(id: number, version: number, secrets: string) {
    if (this.built.get(id) !== version) throw new HatboxError("Not here.", 409, true);
    if ((this.secretsOf.get(id)?.digest ?? "") !== secrets)
      throw new HatboxError("Other secrets.", 409, false, true);
  }
  async http(id: number, version: number, secrets: string, req: BoxRequest) {
    this.has(id, version, secrets);
    return this.backend(req);
  }
  async scheduled(id: number, version: number, secrets: string) {
    this.has(id, version, secrets);
    this.runs.push(id);
    return this.run;
  }
  async secrets(id: number, s: BoxSecrets) {
    if (s.digest) this.secretsOf.set(id, s);
    else this.secretsOf.delete(id);
  }
  async note(id: number, line: string) {
    this.notes.push(`${id}: ${line}`);
  }
  async logs() {
    return this.log;
  }
  async stop(id: number) {
    this.stopped.push(id);
  }
  async remove(id: number) {
    this.built.delete(id);
    this.secretsOf.delete(id);
  }
}
