import type {
  BoxBuild,
  BoxFile,
  BoxRun,
  BoxSecrets,
  GuestBox,
  HatboxStatus,
} from "@hatbot/shared/hatbox";

export class HatboxError extends Error {
  constructor(
    message: string,
    /** The agent's answer; 0: unreachable. */
    readonly status: number,
    /** The guest doesn't have the version asked for: the brain sends it again. */
    readonly missing = false,
    /** The guest doesn't have the box's secrets as they are: the brain sends them. */
    readonly secrets = false,
  ) {
    super(message);
  }
}

/** A request for a box's backend: `path` with its query, inside the box. */
export type BoxRequest = {
  method: string;
  path: string;
  headers: [string, string][];
  body?: Uint8Array;
};

export interface HatboxAgent {
  readonly configured: boolean;
  status(): Promise<HatboxStatus>;
  boxes(): Promise<GuestBox[]>;
  /** The page inlined into one file, and the backend. */
  build(id: number, version: number, files: BoxFile[]): Promise<BoxBuild>;
  /** `secrets` is BoxSecrets' digest, "" for none. */
  http(id: number, version: number, secrets: string, req: BoxRequest): Promise<Response>;
  scheduled(id: number, version: number, secrets: string): Promise<BoxRun>;
  secrets(id: number, s: BoxSecrets): Promise<void>;
  note(id: number, line: string): Promise<void>;
  logs(id: number): Promise<string>;
  stop(id: number): Promise<void>;
  remove(id: number): Promise<void>;
}

export class HttpHatboxAgent implements HatboxAgent {
  readonly configured: boolean;

  constructor(
    private baseUrl = process.env.HATBOX_AGENT_URL ?? "",
    private token = process.env.HATBOX_AGENT_TOKEN ?? "",
  ) {
    this.configured = Boolean(baseUrl && token);
  }

  private async req(
    method: string,
    path: string,
    o: {
      version?: number;
      secrets?: string;
      body?: string | Uint8Array;
      headers?: [string, string][];
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    if (!this.configured) throw new HatboxError("The boxes guest isn't set up.", 0);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: [
          ...(o.headers ?? []),
          ["authorization", `Bearer ${this.token}`],
          ...(o.version ? [["x-hatbox-version", String(o.version)] as [string, string]] : []),
          ...(o.secrets ? [["x-hatbox-secrets", o.secrets] as [string, string]] : []),
        ],
        body: o.body,
        redirect: "manual",
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      });
    } catch {
      throw new HatboxError("The boxes guest isn't answering.", 0);
    }
    // The agent's own refusals say so; a backend's answer, whatever its status, is passed on.
    if (res.headers.has("x-hatbox-error")) {
      const e = (await res.json().catch(() => ({}))) as {
        error?: string;
        missing?: boolean;
        secrets?: boolean;
      };
      throw new HatboxError(
        e.error ?? `The boxes guest answered ${res.status}.`,
        res.status,
        e.missing,
        e.secrets,
      );
    }
    return res;
  }

  async status() {
    return (await (await this.req("GET", "/health")).json()) as HatboxStatus;
  }
  async boxes() {
    return (await (await this.req("GET", "/boxes")).json()) as GuestBox[];
  }
  async build(id: number, version: number, files: BoxFile[]) {
    await this.req("PUT", `/boxes/${id}`, {
      version,
      body: JSON.stringify({ files }),
      headers: [["content-type", "application/json"]],
    });
    // npm packages are installed first, and the build gets most of the guest's memory.
    const res = await this.req("POST", `/boxes/${id}/build`, { version, timeoutMs: 5 * 60_000 });
    return (await res.json()) as BoxBuild;
  }
  async http(id: number, version: number, secrets: string, r: BoxRequest) {
    // Resolved on its own first, so no "..", in any spelling, leads out of the box's own paths.
    const inBox = new URL(r.path, "http://box");
    return this.req(r.method, `/boxes/${id}/http${inBox.pathname}${inBox.search}`, {
      version,
      secrets,
      headers: r.headers,
      body: r.body,
      // The backend may have to start, and then has a minute to answer.
      timeoutMs: 80_000,
    });
  }
  async scheduled(id: number, version: number, secrets: string) {
    const res = await this.req("POST", `/boxes/${id}/scheduled`, {
      version,
      secrets,
      timeoutMs: 80_000,
    });
    return (await res.json()) as BoxRun;
  }
  async secrets(id: number, s: BoxSecrets) {
    await this.req("PUT", `/boxes/${id}/secrets`, {
      body: JSON.stringify(s),
      headers: [["content-type", "application/json"]],
    });
  }
  async note(id: number, line: string) {
    await this.req("POST", `/boxes/${id}/log`, {
      body: JSON.stringify({ line }),
      headers: [["content-type", "application/json"]],
    });
  }
  async logs(id: number) {
    return (await this.req("GET", `/boxes/${id}/logs`)).text();
  }
  async stop(id: number) {
    await this.req("POST", `/boxes/${id}/stop`);
  }
  async remove(id: number) {
    await this.req("DELETE", `/boxes/${id}`);
  }
}
