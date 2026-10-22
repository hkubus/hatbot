// Starting and stopping boxes' backends and running their builds. On the guest they're
// systemd units, hatbox@<id> and hatbox-build@<id>, which a polkit rule lets the agent's user start and
// stop and nothing else. Where there's no systemd (tests, trying it on a laptop) they're plain processes,
// with none of the units' fences.
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

export interface Units {
  start(id: number): Promise<void>;
  stop(id: number): Promise<void>;
  /** Runs a build in box `id`'s build folder, its output in build.log there; true when it worked. */
  build(id: number): Promise<boolean>;
  /** Removes what box `id`'s backend kept, once it's stopped. */
  clean(id: number): Promise<void>;
}

export class SystemdUnits implements Units {
  private async systemctl(...args: string[]): Promise<{ code: number; err: string }> {
    const p = Bun.spawn(["systemctl", "--no-ask-password", ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    return { code, err: err.trim() };
  }

  async start(id: number) {
    const r = await this.systemctl("start", `hatbox@${id}.service`);
    if (r.code) throw new Error(`Couldn't start the backend: ${r.err}`);
  }
  async stop(id: number) {
    await this.systemctl("stop", `hatbox@${id}.service`);
  }
  async build(id: number) {
    // A oneshot unit: start waits for it to end, and fails when it did.
    return (await this.systemctl("start", `hatbox-build@${id}.service`)).code === 0;
  }
  async clean(id: number) {
    await this.systemctl("clean", "--what=state", `hatbox@${id}.service`);
  }
}

/** The same, as processes of the agent's own user: for tests and trying it out, never on the guest. */
export class LocalUnits implements Units {
  private procs = new Map<number, Subprocess>();

  constructor(
    private state: string,
    private run: string,
  ) {}

  async start(id: number) {
    const data = join(this.state, "data", String(id));
    mkdirSync(data, { recursive: true });
    const log = openSync(join(this.state, "logs", `${id}.log`), "a");
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "runner.ts")], {
      cwd: data,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: data,
        HATBOX_ID: String(id),
        HATBOX_APP: join(this.state, "boxes", String(id), "app", "server.js"),
        HATBOX_SOCKETS: join(this.run, String(id)),
      },
      stdin: "ignore",
      stdout: log,
      stderr: log,
    });
    closeSync(log);
    this.procs.set(id, proc);
  }

  async stop(id: number) {
    const proc = this.procs.get(id);
    this.procs.delete(id);
    proc?.kill();
    await proc?.exited;
  }

  async build(id: number) {
    const dir = join(this.state, "build", String(id));
    const log = openSync(join(dir, "build.log"), "w");
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "build.ts")], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      stdin: "ignore",
      stdout: log,
      stderr: log,
    });
    closeSync(log);
    return (await proc.exited) === 0;
  }

  async clean(id: number) {
    rmSync(join(this.state, "data", String(id)), { recursive: true, force: true });
  }
}
