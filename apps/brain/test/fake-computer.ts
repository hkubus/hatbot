// The Linux app's agent, over a real WebSocket to the brain.
import {
  COMPUTER_PROTOCOL,
  type ComputerHello,
  type ComputerMessage,
  type ComputerRequest,
  type ComputerResult,
  type ComputerStatus,
} from "@hatbot/shared/computer";
import { websocket } from "hono/bun";
import type { TestApp } from "./helpers";
import { waitFor } from "./helpers";

/** A tiny JPEG's first bytes are enough for the brain. */
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

type Answer = ComputerResult | { error: string; code: string };

export class FakeComputer {
  ws!: WebSocket;
  requests: ComputerRequest[] = [];
  status: ComputerStatus = {
    enabled: true,
    locked: false,
    ownerActive: false,
    paused: false,
    screen: { output: "DP-1", width: 1280, height: 800, scale: 1 },
  };
  /** Answers by op, before the defaults. */
  answer: Partial<Record<ComputerRequest["op"], (r: ComputerRequest) => Answer>> = {};
  closed = false;

  constructor(
    readonly hello: Omit<ComputerHello, "t" | "protocol"> = {
      machineId: "m-laptop",
      name: "laptop",
      version: "test",
      compositor: "niri",
      enabled: true,
      features: ["screen", "input", "windows", "atspi", "files", "shell", "live"],
    },
  ) {
    this.status.enabled = hello.enabled;
  }

  async connect(url: string, token: string) {
    this.ws = new WebSocket(`${url}/api/v1/computer/connect`, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[]);
    this.ws.onmessage = (e) => this.onMessage(e.data as string);
    this.ws.onclose = () => {
      this.closed = true;
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.send({ t: "hello", protocol: COMPUTER_PROTOCOL, ...this.hello });
  }

  send(m: ComputerMessage) {
    this.ws.send(JSON.stringify(m));
  }

  setStatus(patch: Partial<ComputerStatus>) {
    this.status = { ...this.status, ...patch };
    this.send({ t: "status", status: this.status });
  }

  private onMessage(data: string) {
    const m = JSON.parse(data) as ComputerMessage;
    if (m.t !== "req") return;
    this.requests.push(m.req);
    const a = this.answer[m.req.op]?.(m.req) ?? this.byDefault(m.req);
    if ("error" in a)
      this.send({ t: "res", id: m.id, ok: false, code: a.code as "failed", error: a.error });
    else this.send({ t: "res", id: m.id, ok: true, res: a });
  }

  private byDefault(r: ComputerRequest): Answer {
    switch (r.op) {
      case "status":
        return { op: "status", status: this.status };
      case "claim":
        return {
          op: "claim",
          screen: this.status.screen ?? { output: "", width: 0, height: 0, scale: 1 },
        };
      case "screenshot":
      case "zoom":
        return { op: r.op, data: JPEG, width: 1280, height: 800 };
      case "action":
        return { op: "action", result: {} };
      case "windows":
        return {
          op: "windows",
          windows: [{ id: 1, title: "Files", appId: "nautilus", focused: true }],
        };
      case "inspect":
        return { op: "inspect", element: null };
      case "exec":
        return { op: "exec", result: { exitCode: 0, output: `ran ${r.command}`, timedOut: false } };
      case "put_file":
        return { op: "put_file", path: r.path ?? `/home/me/Downloads/Hatbot/${r.name}` };
      case "get_file":
        return {
          op: "get_file",
          name: r.path.split("/").pop() ?? "",
          data: Buffer.from("hello").toString("base64"),
        };
      case "pause":
        queueMicrotask(() => this.setStatus({ paused: r.paused }));
        return { op: "pause" };
      case "disable":
        queueMicrotask(() => this.setStatus({ enabled: false }));
        return { op: "disable" };
      default:
        return { op: r.op } as ComputerResult;
    }
  }

  close() {
    this.ws.close();
  }
}

/** The brain on a real port, and a computer connected to it with a device token. */
export async function withComputer(t: TestApp, computer = new FakeComputer()) {
  const server = Bun.serve({ port: 0, fetch: (req, srv) => t.app.fetch(req, srv), websocket });
  const { token, id } = t.auth.createToken("Linux app");
  await computer.connect(`ws://127.0.0.1:${server.port}`, token);
  await waitFor(() => t.computers.find(computer.hello.machineId)?.online);
  return {
    computer,
    server,
    tokenId: id,
    url: `ws://127.0.0.1:${server.port}`,
    stop: () => {
      computer.close();
      server.stop(true);
    },
  };
}
