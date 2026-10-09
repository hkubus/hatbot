// The X display: input through xdotool, pixels through ffmpeg's x11grab.
import type { AgentActionResult } from "@hatbot/shared/desktop";
import { combo, KeyError, modifiers } from "./keys";

export class ActionError extends Error {}

const display = process.env.DISPLAY ?? ":1";

async function run(cmd: string[], stdin?: string): Promise<string> {
  const p = Bun.spawn(cmd, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DISPLAY: display },
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim().slice(0, 300)}`);
  return out;
}

export const xdotool = (...args: string[]) => run(["xdotool", ...args]);

export async function screenSize(): Promise<{ width: number; height: number }> {
  const [w, h] = (await xdotool("getdisplaygeometry")).trim().split(/\s+/).map(Number);
  if (!w || !h) throw new Error("can't read the display size");
  return { width: w, height: h };
}

async function grab(args: string[]): Promise<Uint8Array> {
  const p = Bun.spawn(["ffmpeg", "-loglevel", "error", "-f", "x11grab", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).bytes(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0 || !out.length)
    throw new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`);
  return out;
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

/** Runs one computer toolset member (not screenshot or zoom). */
export async function act(
  size: { width: number; height: number },
  name: string,
  input: Record<string, unknown>,
): Promise<AgentActionResult> {
  try {
    return await actInner(size, name, input);
  } catch (err) {
    if (err instanceof KeyError) throw new ActionError(err.message);
    throw err;
  }
}

async function actInner(
  size: { width: number; height: number },
  name: string,
  input: Record<string, unknown>,
): Promise<AgentActionResult> {
  const at = (key = "coordinate") =>
    input[key] == null ? [] : ["mousemove", "--sync", ...checkPoint(size, input[key]).map(String)];
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
    case "type":
      await xdotool("type", "--delay", "8", "--", str(input.text, "text"));
      return {};
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
 * The live view: one ffmpeg reading the display as MJPEG while anyone watches. Frames go to every subscriber.
 * ffmpeg's mpjpeg output frames each JPEG with a Content-length header.
 */
export class LiveCapture {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private subscribers = new Set<(frame: Uint8Array) => void>();

  constructor(
    private size: { width: number; height: number },
    private fps = 15,
  ) {}

  subscribe(fn: (frame: Uint8Array) => void): () => void {
    this.subscribers.add(fn);
    if (!this.proc) this.start();
    return () => {
      this.subscribers.delete(fn);
      if (!this.subscribers.size) this.stop();
    };
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
