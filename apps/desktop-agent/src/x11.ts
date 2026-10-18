// The X display: input through xdotool, pixels through ffmpeg's x11grab.
import type { AgentActionResult } from "@hatbot/shared/desktop";
import { between, path } from "./human";
import { combo, modifiers } from "./keys";

export class ActionError extends Error {}

const display = process.env.DISPLAY ?? ":1";

/** Every xdotool and ffmpeg gets this long, plus what it's asked to spend, before it's killed. */
const DEADLINE_MS = 10_000;

/** Runs `cmd` and kills it at the deadline, so one hung process can't hold up the input queue. */
export async function spawn(cmd: string[], extraMs = 0, base = DEADLINE_MS) {
  const p = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DISPLAY: display },
  });
  const limit = base + extraMs;
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    p.kill("SIGKILL");
  }, limit);
  try {
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).bytes(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (killed) throw new Error(`${cmd[0]} didn't finish in ${Math.round(limit / 1000)} s`);
    return { out, err, code };
  } finally {
    clearTimeout(timer);
  }
}

async function run(cmd: string[], extraMs = 0): Promise<string> {
  const { out, err, code } = await spawn(cmd, extraMs);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim().slice(0, 300)}`);
  return new TextDecoder().decode(out);
}

/** About how long xdotool's own sleeps and delays take for these arguments, in ms. */
export function pacing(args: string[]): number {
  let ms = 0;
  args.forEach((a, i) => {
    const n = Number(args[i + 1]) || 0;
    if (a === "sleep") ms += n * 1000;
    else if (a === "--delay") {
      // Our calls put it after --repeat (key, click), or before "--" and the text (type).
      const times =
        args[i - 2] === "--repeat"
          ? Number(args[i - 1])
          : args[i + 2] === "--"
            ? (args[i + 3] ?? "").length
            : 1;
      ms += n * (times || 1);
    }
  });
  return ms;
}

// Half again on top: xdotool's delays come on top of its own round trips to the X server.
export const xdotool = (...args: string[]) => run(["xdotool", ...args], pacing(args) * 1.5);

export async function screenSize(): Promise<{ width: number; height: number }> {
  const [w, h] = (await xdotool("getdisplaygeometry")).trim().split(/\s+/).map(Number);
  if (!w || !h) throw new Error("can't read the display size");
  return { width: w, height: h };
}

/** One frame. x11grab waits a frame interval before grabbing; at its default 30 fps that's most of the time. */
async function grab(args: string[]): Promise<Uint8Array> {
  const { out, err, code } = await spawn([
    "ffmpeg",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-framerate",
    "1000",
    ...args,
  ]);
  if (code !== 0 || !out.length)
    throw new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`);
  return out;
}

/** Whether one frame can be grabbed, for GET /health?deep=1. */
export async function displayUp(): Promise<boolean> {
  try {
    const { out, code } = await spawn(
      [
        "ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-framerate",
        "1000",
        "-video_size",
        "1x1",
        "-i",
        display,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ],
      0,
      3000,
    );
    return code === 0 && out.length > 0;
  } catch {
    return false;
  }
}

// Lossless WebP: exact pixels for the model, and about a third of PNG's size in the archive.
const WEBP = [
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
  "-lossless",
  "1",
  "-compression_level",
  "1",
  "-f",
  "webp",
  "-",
];

export function screenshot(size: { width: number; height: number }) {
  return grab([
    "-draw_mouse",
    "1",
    "-video_size",
    `${size.width}x${size.height}`,
    "-i",
    display,
    ...WEBP,
  ]);
}

/** Crops [x0, y0, x1, y1] and scales it up to fit the screen size, keeping the aspect ratio. */
export function zoom(size: { width: number; height: number }, region: number[]) {
  const [x0, y0, x1, y1] = region.map(Math.round) as [number, number, number, number];
  if (region.length !== 4 || !(x1 > x0 && y1 > y0)) {
    throw new ActionError("region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0.");
  }
  checkPoint(size, [x0, y0]);
  checkPoint(size, [x1 - 1, y1 - 1]);
  const w = x1 - x0;
  const h = y1 - y0;
  const scale = Math.min(size.width / w, size.height / h);
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  return grab([
    "-draw_mouse",
    "0",
    "-video_size",
    `${w}x${h}`,
    "-i",
    `${display}+${x0},${y0}`,
    "-vf",
    `scale=${ow}:${oh}:flags=lanczos`,
    ...WEBP,
  ]);
}

function checkPoint(size: { width: number; height: number }, p: unknown): [number, number] {
  if (
    !Array.isArray(p) ||
    p.length !== 2 ||
    !p.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new ActionError("coordinate must be [x, y].");
  }
  const [x, y] = p.map(Math.round) as [number, number];
  if (x < 0 || y < 0 || x >= size.width || y >= size.height) {
    throw new ActionError(`(${x}, ${y}) is outside the ${size.width}x${size.height} screen.`);
  }
  return [x, y];
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new ActionError(`${name} must be a string.`);
  return v;
};
const num = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new ActionError(`${name} must be a number.`);
  return Math.min(max, Math.max(min, v));
};

const BUTTONS = {
  left_click: 1,
  right_click: 3,
  middle_click: 2,
  double_click: 1,
  triple_click: 1,
} as const;
const REPEATS = {
  left_click: 1,
  right_click: 1,
  middle_click: 1,
  double_click: 2,
  triple_click: 3,
} as const;
const WHEEL = { up: "4", down: "5", left: "6", right: "7" } as const;
/** Live view frame rates: while the owner has control, and while they (or nobody) only watch. */
export const LIVE_FPS_CONTROL = 15;
export const LIVE_FPS_WATCHING = 5;
/** Longer text than this is typed fast, in chunks this long; the brain's timeout for `type` assumes it. */
const HUMAN_TYPING_CHARS = 200;

/** xdotool steps that move the pointer to `to` along a person-like path from where it is. */
async function glide([x, y]: [number, number]): Promise<string[]> {
  const out = await xdotool("getmouselocation", "--shell");
  const from = {
    x: Number(/X=(\d+)/.exec(out)?.[1] ?? x),
    y: Number(/Y=(\d+)/.exec(out)?.[1] ?? y),
  };
  const steps = path(from, { x, y });
  return [
    ...steps
      .slice(0, -1)
      .flatMap((p) => [
        "mousemove",
        String(p.x),
        String(p.y),
        "sleep",
        (between(6, 16) / 1000).toFixed(3),
      ]),
    "mousemove",
    "--sync",
    String(x),
    String(y),
    "sleep",
    (between(40, 120) / 1000).toFixed(3),
  ];
}

/** Runs one computer toolset member (not screenshot or zoom). A name off the key lists throws KeyError. */
export async function act(
  size: { width: number; height: number },
  name: string,
  input: Record<string, unknown>,
): Promise<AgentActionResult> {
  const move = input.coordinate == null ? [] : await glide(checkPoint(size, input.coordinate));
  const at = () => move;
  const held = (cmd: string[]) => {
    const mods = modifiers(input.text as string | undefined);
    return [...mods.flatMap((m) => ["keydown", m]), ...cmd, ...mods.flatMap((m) => ["keyup", m])];
  };

  switch (name) {
    case "key": {
      const repeat = Math.round(num(input.repeat ?? 1, "repeat", 1, 50));
      await xdotool(
        "key",
        "--repeat",
        String(repeat),
        "--delay",
        "40",
        combo(str(input.text, "text")),
      );
      return {};
    }
    case "hold_key": {
      const k = combo(str(input.text, "text"));
      const secs = num(input.duration, "duration", 0, 10);
      await xdotool("keydown", k, "sleep", String(secs), "keyup", k);
      return {};
    }
    case "type": {
      const text = str(input.text, "text");
      const chars = Array.from(text);
      if (chars.length <= HUMAN_TYPING_CHARS) {
        // A person's pace, roughly; xdotool keeps one delay for the whole string.
        await xdotool("type", "--delay", String(between(45, 75)), "--", text);
        return {};
      }
      // Pasting a long text in, more or less: at a person's pace 5000 characters would take minutes.
      for (let i = 0; i < chars.length; i += HUMAN_TYPING_CHARS) {
        if (i) await Bun.sleep(between(80, 200));
        const chunk = chars.slice(i, i + HUMAN_TYPING_CHARS).join("");
        await xdotool("type", "--delay", "8", "--", chunk);
      }
      return {};
    }
    case "cursor_position": {
      const out = await xdotool("getmouselocation", "--shell");
      const x = Number(/X=(\d+)/.exec(out)?.[1]);
      const y = Number(/Y=(\d+)/.exec(out)?.[1]);
      return { x, y };
    }
    case "mouse_move":
      await xdotool(...at());
      return {};
    case "left_mouse_down":
      await xdotool("mousedown", "1");
      return {};
    case "left_mouse_up":
      await xdotool("mouseup", "1");
      return {};
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const click = [
        "click",
        "--repeat",
        String(REPEATS[name]),
        "--delay",
        "80",
        String(BUTTONS[name]),
      ];
      await xdotool(...at(), ...held(click));
      return {};
    }
    case "left_click_drag": {
      const [sx, sy] = checkPoint(size, input.start_coordinate);
      const [ex, ey] = checkPoint(size, input.coordinate);
      const mid = [String(Math.round((sx + ex) / 2)), String(Math.round((sy + ey) / 2))];
      await xdotool(
        "mousemove",
        "--sync",
        String(sx),
        String(sy),
        ...held([
          "mousedown",
          "1",
          "sleep",
          "0.1",
          "mousemove",
          "--sync",
          ...mid,
          "sleep",
          "0.05",
          "mousemove",
          "--sync",
          String(ex),
          String(ey),
          "sleep",
          "0.1",
          "mouseup",
          "1",
        ]),
      );
      return {};
    }
    case "scroll": {
      const dir = str(input.scroll_direction, "scroll_direction") as keyof typeof WHEEL;
      if (!WHEEL[dir]) throw new ActionError("scroll_direction must be up, down, left or right.");
      const amount = Math.round(num(input.scroll_amount, "scroll_amount", 1, 30));
      await xdotool(
        ...at(),
        ...held(["click", "--repeat", String(amount), "--delay", "30", WHEEL[dir]]),
      );
      return {};
    }
    case "wait":
      await Bun.sleep(num(input.duration, "duration", 0, 30) * 1000);
      return {};
    default:
      throw new ActionError(`Unknown action "${name}".`);
  }
}

/**
 * The live view: one ffmpeg reading the display as MJPEG while anyone watches. Frames go to every subscriber,
 * except one that's the same as the last (an idle screen sends nothing). ffmpeg's mpjpeg output frames
 * each JPEG with a Content-length header.
 */
export class LiveCapture {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private subscribers = new Set<(frame: Uint8Array) => void>();
  private last: Uint8Array | null = null;

  constructor(
    private size: { width: number; height: number },
    private fps = LIVE_FPS_WATCHING,
  ) {}

  subscribe(fn: (frame: Uint8Array) => void): () => void {
    this.subscribers.add(fn);
    if (!this.proc) this.start();
    // A new watcher of a screen that isn't changing would otherwise wait for the next change.
    else if (this.last) fn(this.last);
    return () => {
      this.subscribers.delete(fn);
      if (!this.subscribers.size) this.stop();
    };
  }

  /** Smoother while the owner has control, lighter while they only watch. */
  setFps(fps: number) {
    if (fps === this.fps) return;
    this.fps = fps;
    if (this.proc) {
      this.stop();
      this.start();
    }
  }

  private start() {
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-draw_mouse",
        "1",
        "-framerate",
        String(this.fps),
        "-video_size",
        `${this.size.width}x${this.size.height}`,
        "-i",
        display,
        "-q:v",
        "7",
        "-f",
        "mpjpeg",
        "-",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    this.proc = proc;
    void this.read(proc);
  }

  private stop() {
    this.proc?.kill();
    this.proc = null;
    if (!this.subscribers.size) this.last = null;
  }

  private async read(proc: ReturnType<typeof Bun.spawn>) {
    let buf = new Uint8Array(0);
    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    for await (const chunk of stdout) {
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf);
      next.set(chunk, buf.length);
      buf = next;
      for (;;) {
        const frame = takeFrame(buf);
        if (!frame) break;
        buf = buf.slice(frame.end);
        if (this.last && Buffer.from(frame.jpeg).equals(this.last)) continue;
        this.last = frame.jpeg;
        for (const fn of this.subscribers) fn(frame.jpeg);
      }
    }
    // ffmpeg died while someone was watching (the display restarted, say): start again.
    if (this.proc === proc && this.subscribers.size)
      setTimeout(() => this.proc === proc && this.start(), 1000);
  }
}

const HEADER_END = new TextEncoder().encode("\r\n\r\n");

/** One part of a multipart MJPEG stream: headers, then Content-length bytes. */
export function takeFrame(buf: Uint8Array): { jpeg: Uint8Array; end: number } | null {
  const headerEnd = indexOf(buf, HEADER_END);
  if (headerEnd < 0) return null;
  const headers = new TextDecoder().decode(buf.subarray(0, headerEnd));
  const length = Number(/content-length:\s*(\d+)/i.exec(headers)?.[1]);
  if (!length) throw new Error("mpjpeg part without a Content-length");
  const start = headerEnd + HEADER_END.length;
  if (buf.length < start + length) return null;
  return { jpeg: buf.slice(start, start + length), end: start + length };
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
