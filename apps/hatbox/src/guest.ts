// What the agent does with boxes (PLAN.md §21.6): keeps the files the brain sends until they're built,
// builds them, runs each backend as its own unit on its first request and stops it after 15 idle
// minutes, relays requests to it, sends its fetches on (egress.ts), and keeps its log.
//   <state>/build/<id>/src     the files, until they're built; the build writes page.html and server.js
//   <state>/boxes/<id>/app     the backend that runs (server.js, box.json); <id>/version says which
//   <state>/logs/<id>.log      what the backend printed, and the agent's notes on it
//   <run>/<id>/box.sock        where the backend listens; egress.sock is where its fetches come

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  BOX_CONFIG,
  BOX_SERVER,
  type BoxBuild,
  type BoxConfig,
  type BoxFile,
  badFiles,
  boxConfig,
  type GuestBox,
  MAX_BOX_BODY,
  MAX_BOX_BUILT,
  passedHeaders,
} from "@hatbot/shared/hatbox";
import type { Server } from "bun";
import { EgressError, nullBody, sendOn } from "./egress";
import { clip, readStream, readWritten } from "./files";
import type { Units } from "./units";

/** A backend nobody has asked anything for this long is stopped. */
export const IDLE_MS = 15 * 60_000;
const START_MS = 15_000;
const ANSWER_MS = 60_000;
const INSTALL_MS = 120_000;
/** A log is cut back to its last part past this. */
const MAX_LOG = 1024 * 1024;

/** A refusal, with the status to answer it with. `missing`: the brain should send the box again. */
export class GuestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly missing = false,
  ) {
    super(message);
  }
}

export type GuestOptions = {
  state: string;
  run: string;
  units: Units;
  clock?: () => number;
  /** Egress's address check; tests stand in for DNS. */
  resolve?: (host: string) => Promise<string>;
};

export class Guest {
  private running = new Map<number, { egress: Server<undefined>; used: number }>();
  private starting = new Map<number, Promise<void>>();
  private builds: Promise<unknown> = Promise.resolve();
  private clock: () => number;

  constructor(private o: GuestOptions) {
    this.clock = o.clock ?? Date.now;
    for (const dir of ["boxes", "build", "logs"])
      mkdirSync(join(o.state, dir), { recursive: true });
  }

  private dir = (...parts: (string | number)[]) => join(this.o.state, ...parts.map(String));

  /** The version of box `id`'s backend that's built, or null. */
  version(id: number): number | null {
    try {
      return Number(readFileSync(this.dir("boxes", id, "version"), "utf8")) || null;
    } catch {
      return null;
    }
  }

  list(): GuestBox[] {
    return readdirSync(this.dir("boxes")).flatMap((name) => {
      const id = Number(name);
      const version = this.version(id);
      return version ? [{ id, version }] : [];
    });
  }

  /** The box.json the running backend was built with. */
  config(id: number): BoxConfig {
    try {
      return boxConfig(readFileSync(this.dir("boxes", id, "app", BOX_CONFIG), "utf8"));
    } catch {
      return { hosts: [], packages: {} };
    }
  }

  /** Keeps a version's files to build: plain files the agent writes itself, only inside the box. */
  put(id: number, version: number, files: BoxFile[]) {
    const bad = badFiles(files);
    if (bad) throw new GuestError(bad, 400);
    const dir = this.dir("build", id);
    this.clear(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    // The build runs as a user of its own, which writes its results here. Sticky, so it can't move or
    // replace what the agent put here.
    chmodSync(dir, 0o1777);
    for (const f of files) {
      const path = join(dir, "src", f.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.content, { mode: 0o644 });
    }
    writeFileSync(join(dir, "version"), String(version));
  }

  /**
   * Builds the version put last and, when it has a backend, makes it the one that runs. One build at a
   * time: each may take most of the boxes' memory.
   */
  build(id: number, version: number): Promise<BoxBuild> {
    const next = this.builds.then(() => this.buildNow(id, version));
    this.builds = next.catch(() => {});
    return next;
  }

  private async buildNow(id: number, version: number): Promise<BoxBuild> {
    const dir = this.dir("build", id);
    const src = join(dir, "src");
    if (
      !existsSync(join(dir, "version")) ||
      readFileSync(join(dir, "version"), "utf8") !== String(version)
    )
      throw new GuestError("Send this version's files first.", 409, true);
    try {
      const config = boxConfig(this.read(join(src, BOX_CONFIG)) ?? undefined);
      if (Object.keys(config.packages).length) {
        writeFileSync(
          join(src, "package.json"),
          JSON.stringify({ private: true, dependencies: config.packages }),
        );
        const installed = await this.install(src);
        if (!installed.ok) return { ok: false, output: installed.output };
      }
      const built = await this.o.units.build(id);
      const output = clip(readWritten(join(dir, "build.log"), MAX_LOG) ?? "");
      const page = readWritten(join(dir, "page.html"), MAX_BOX_BUILT);
      const backend = existsSync(join(src, BOX_SERVER));
      const server = backend ? readWritten(join(dir, "server.js"), MAX_BOX_BUILT) : null;
      if (!built || page === null || (backend && server === null))
        return {
          ok: false,
          output: built
            ? `${output}\nThe page or backend it built is missing or over 5 MB.`
            : output,
        };
      await this.stop(id);
      const box = this.dir("boxes", id);
      if (server === null) {
        // Only a page: nothing of it runs here.
        this.clear(box);
      } else {
        const app = join(box, "app");
        this.clear(`${app}.new`);
        mkdirSync(`${app}.new`, { recursive: true });
        writeFileSync(join(`${app}.new`, "server.js"), server, { mode: 0o644 });
        writeFileSync(join(`${app}.new`, BOX_CONFIG), JSON.stringify(config), { mode: 0o644 });
        this.clear(app);
        renameSync(`${app}.new`, app);
        writeFileSync(join(box, "version"), String(version));
      }
      return { ok: true, page, output };
    } finally {
      this.clear(dir);
    }
  }

  /** npm packages, installed by the agent: the build that could run their code has no network. */
  private async install(dir: string): Promise<{ ok: boolean; output: string }> {
    const proc = Bun.spawn(
      [process.execPath, "install", "--ignore-scripts", "--no-progress", "--no-save"],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: this.dir("cache"),
          // Kept between builds, in the agent's own state.
          BUN_INSTALL_CACHE_DIR: this.dir("cache"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => proc.kill(), INSTALL_MS);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { ok: code === 0, output: clip(`${out}\n${err}`.trim()) };
  }

  /** A request from the box's page or the model, relayed to its backend, started if it isn't. */
  async http(id: number, version: number, req: Request, path: string): Promise<Response> {
    this.current(id, version);
    const body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await readStream(req.body, MAX_BOX_BODY);
    if (body?.over) throw new GuestError("A request to a box carries at most 5 MB.", 413);
    // The brain's token isn't the box's business.
    const headers = passedHeaders(req.headers, ["authorization"]);
    return this.relay(id, path, { method: req.method, headers, body: body?.bytes });
  }

  /** Runs the backend's scheduled(); why it failed, if it did. */
  async scheduled(id: number, version: number): Promise<string | null> {
    this.current(id, version);
    const res = await this.relay(id, "/", {
      method: "POST",
      headers: [["x-hatbox-op", "scheduled"]],
    });
    return res.ok ? null : (await res.text()) || `It answered ${res.status}.`;
  }

  private current(id: number, version: number) {
    if (this.version(id) !== version)
      throw new GuestError(`The guest doesn't have version ${version} of box #${id}.`, 409, true);
  }

  private async relay(
    id: number,
    path: string,
    init: { method: string; headers: [string, string][]; body?: Uint8Array },
  ): Promise<Response> {
    const socket = join(this.o.run, String(id), "box.sock");
    const send = () =>
      fetch(`http://box${path}`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(ANSWER_MS),
        unix: socket,
      } as RequestInit);
    await this.up(id);
    let res: Response;
    try {
      res = await send();
    } catch (err) {
      if ((err as Error).name === "TimeoutError")
        throw new GuestError("The backend didn't answer in 60 seconds.", 504);
      // It stopped since (it crashed, say): once more, from the start.
      await this.stop(id);
      await this.up(id);
      res = await send();
    }
    const { bytes, over } = await readStream(res.body, MAX_BOX_BODY);
    this.touch(id);
    if (over) throw new GuestError("The backend's answer is over 5 MB.", 502);
    return new Response(nullBody(res.status) ? null : bytes, {
      status: res.status,
      headers: passedHeaders(res.headers),
    });
  }

  private touch(id: number) {
    const r = this.running.get(id);
    if (r) r.used = this.clock();
  }

  /** Starts the backend, once, however many requests come for it meanwhile. */
  private async up(id: number) {
    if (this.running.has(id)) return this.touch(id);
    let starting = this.starting.get(id);
    if (!starting) {
      starting = this.launch(id).finally(() => this.starting.delete(id));
      this.starting.set(id, starting);
    }
    await starting;
  }

  private async launch(id: number) {
    const dir = join(this.o.run, String(id));
    // Made afresh, without what the backend left in it last time.
    this.clear(dir);
    mkdirSync(dir, { recursive: true });
    // The backend's own user makes its socket here. Sticky, so it can't replace the agent's, and a link
    // it makes isn't followed by the agent (fs.protected_symlinks) to another box's socket.
    chmodSync(dir, 0o1777);
    const egressSocket = join(dir, "egress.sock");
    const egress = Bun.serve({
      unix: egressSocket,
      maxRequestBodySize: MAX_BOX_BODY + 64 * 1024,
      fetch: (req) => this.egress(id, req),
    });
    chmodSync(egressSocket, 0o666);
    this.trimLog(id);
    try {
      await this.o.units.start(id);
      await this.listening(join(dir, "box.sock"));
    } catch (err) {
      egress.stop(true);
      await this.o.units.stop(id).catch(() => {});
      const log = this.logs(id, 2000);
      throw new GuestError(
        `The backend didn't start${err instanceof GuestError ? "" : `: ${(err as Error).message}`}.${log ? `\n${log}` : ""}`,
        502,
      );
    }
    this.running.set(id, { egress, used: this.clock() });
  }

  /** Resolves once something accepts connections on `socket`. */
  private async listening(socket: string) {
    const end = Date.now() + START_MS;
    for (;;) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = new Socket();
        s.once("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.once("error", () => resolve(false));
        s.connect(socket);
      });
      if (ok) return;
      if (Date.now() > end) throw new GuestError("timed out", 502);
      await Bun.sleep(50);
    }
  }

  private async egress(id: number, req: Request): Promise<Response> {
    this.touch(id);
    try {
      return await sendOn(req, { hosts: this.config(id).hosts, resolve: this.o.resolve });
    } catch (err) {
      const why = err instanceof EgressError ? err.message : `Couldn't fetch it: ${err}`;
      this.note(id, `Not fetched: ${why}`);
      return new Response(null, {
        status: 502,
        headers: { "x-hatbox-error": encodeURIComponent(why) },
      });
    }
  }

  /** A line from the agent in the box's log. */
  private note(id: number, line: string) {
    appendFileSync(
      this.dir("logs", `${id}.log`),
      `${new Date(this.clock()).toISOString().slice(0, 19)} [hatbox] ${line}\n`,
    );
  }

  /** Made by the agent before the unit appends to it, and cut back to its end when it's grown. */
  private trimLog(id: number) {
    const path = this.dir("logs", `${id}.log`);
    if (!existsSync(path)) writeFileSync(path, "");
    else if (statSync(path).size > MAX_LOG)
      writeFileSync(path, readFileSync(path).subarray(-MAX_LOG / 4));
    // The backend's own user appends to it (hatbox@), and no other box's unit sees it.
    chmodSync(path, 0o666);
  }

  /** The end of what the backend printed. */
  logs(id: number, max = 30_000): string {
    try {
      const text = readFileSync(this.dir("logs", `${id}.log`), "utf8");
      return text.length > max ? `…${text.slice(-max)}` : text;
    } catch {
      return "";
    }
  }

  async stop(id: number) {
    const r = this.running.get(id);
    this.running.delete(id);
    r?.egress.stop(true);
    await this.o.units.stop(id);
  }

  /** Stops every backend nobody has used for 15 minutes. */
  async sweep() {
    const now = this.clock();
    for (const [id, r] of this.running) if (now - r.used >= IDLE_MS) await this.stop(id);
  }

  /** Every backend the agent knows of, stopped: when it starts, none of their sockets is its own. */
  async stopAll() {
    for (const { id } of this.list()) await this.stop(id).catch(() => {});
  }

  /** The box and everything of it here: its backend's data, its code and its log. */
  async remove(id: number) {
    await this.stop(id);
    await this.o.units.clean(id);
    for (const path of [this.dir("boxes", id), this.dir("build", id), join(this.o.run, String(id))])
      this.clear(path);
    rmSync(this.dir("logs", `${id}.log`), { force: true });
  }

  private read(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Gone, or moved aside: a build's or a backend's own user may leave a folder the agent can't empty,
   * which then mustn't stand in the way of the next one. Moved within its parent, so on the same
   * filesystem (the run folders are in /run), where no unit sees it.
   */
  private clear(path: string) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      const trash = join(dirname(path), "trash");
      mkdirSync(trash, { recursive: true });
      renameSync(path, join(trash, `${Date.now()}-${Math.random().toString(36).slice(2)}`));
    }
  }
}
