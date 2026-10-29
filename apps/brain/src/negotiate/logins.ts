// The marketplace logins the owner shared in Scout go in the browser of each bot that has Scout
// (Haggler), as its task gets the screen, so it needn't ask the owner to log in. Called without the
// model: the cookies go from Scout to desktop-agent and nowhere else.

import type { DesktopAgent } from "@hatbot/plugin-desktop";
import type { SessionState } from "@hatbot/shared/desktop";
import type { Bots } from "../bots";
import type { Db } from "../db";
import type { Plugins } from "../plugins/registry";
import { readScout } from "./appraise";

/** How often a bot's tasks ask Scout whether a login changed. */
const CHECK_EVERY_MS = 5 * 60_000;
/** The task holds the screen meanwhile. */
const SCOUT_TIMEOUT_MS = 15_000;

export type LoginsDeps = { db: Db; bots: Bots; plugins: Plugins; clock?: () => number };

export class Logins {
  private checked = new Map<string, number>();
  constructor(private d: LoginsDeps) {}

  private now() {
    return (this.d.clock ?? Date.now)();
  }

  /** Puts the logins that changed in Scout in the browser, on `botId`'s profile. Never throws. */
  async signIn(botId: string, agent: DesktopAgent, signal: AbortSignal): Promise<void> {
    if (!this.d.bots.get(botId)?.plugins?.includes("scout")) return;
    const last = this.checked.get(botId);
    if (last !== undefined && this.now() - last < CHECK_EVERY_MS) return;
    this.checked.set(botId, this.now());
    const tools = this.d.plugins.brainTools(["scout"]);
    const list = tools.find((t) => t.name === "scout_shared_sessions");
    const one = tools.find((t) => t.name === "scout_shared_session");
    if (!list || !one) return;
    const within = AbortSignal.any([signal, AbortSignal.timeout(SCOUT_TIMEOUT_MS)]);
    try {
      const { sessions } = await readScout(list, {}, within);
      for (const s of Array.isArray(sessions) ? sessions : []) {
        const { marketplace, revision } = s as { marketplace?: unknown; revision?: unknown };
        if (typeof marketplace !== "string" || typeof revision !== "string") continue;
        if (this.revision(botId, marketplace) === revision) continue;
        // Its error could quote the answer, which signs a browser in.
        const got = await readScout(one, { marketplace }, within).catch(() => {
          throw new Error(`Scout's ${marketplace} login couldn't be read.`);
        });
        if (got.revision !== revision) continue;
        if (!(await agent.signIn({ profile: botId, state: got.storageState as SessionState })))
          return;
        this.d.db
          .query(
            `INSERT INTO marketplace_logins (bot_id, marketplace, revision, signed_in_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (bot_id, marketplace) DO UPDATE SET revision = excluded.revision, signed_in_at = excluded.signed_in_at`,
          )
          .run(botId, marketplace, revision, this.now());
      }
    } catch (err) {
      // The task goes on without it, and asks the owner to log in if it has to; tried again in 5 minutes.
      if (!signal.aborted)
        console.warn(`marketplace logins for ${botId}: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  private revision(botId: string, marketplace: string): string | null {
    return (
      this.d.db
        .query<{ revision: string }, [string, string]>(
          "SELECT revision FROM marketplace_logins WHERE bot_id = ? AND marketplace = ?",
        )
        .get(botId, marketplace)?.revision ?? null
    );
  }
}
