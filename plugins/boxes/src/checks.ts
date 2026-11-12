import type { PluginCheck } from "@hatbot/plugin-sdk";
import { type HatboxAgent, HatboxError } from "./client";

const FEATURES = ["secrets", "notify", "check"];

type Result = Awaited<ReturnType<PluginCheck["run"]>>;
const ok = (detail: string): Result => ({ state: "ok", detail });
const warn = (detail: string): Result => ({ state: "warn", detail });
const fail = (detail: string): Result => ({ state: "fail", detail });
const skip = (detail: string): Result => ({ state: "skip", detail });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Made for each Check everything, so its lines share one health call. */
export function boxesChecks(agent: HatboxAgent, brainSha: string | null): PluginCheck[] {
  if (!agent.configured)
    return [
      {
        id: "boxes",
        name: "Boxes guest",
        run: async () => skip("HATBOX_AGENT_URL isn't set, so boxes are only pages."),
      },
    ];
  let asked: ReturnType<HatboxAgent["status"]> | undefined;
  const status = () => {
    asked ??= agent.status();
    return asked;
  };
  return [
    {
      id: "boxes",
      name: "Boxes guest",
      run: async () => {
        let s: Awaited<ReturnType<typeof status>>;
        try {
          s = await status();
        } catch (err) {
          if (err instanceof HatboxError && err.status === 401)
            return fail(
              "The boxes agent turned down the brain's token: HATBOX_AGENT_TOKEN isn't the one in the guest's /etc/hatbox/secrets.env.",
            );
          if (err instanceof HatboxError && err.status === 0)
            return fail(
              "The boxes agent isn't answering. infra/verify.sh, run on the host, says why.",
            );
          return fail(`The boxes agent answered: ${errorText(err)}`);
        }
        if (FEATURES.some((f) => !s.features?.includes(f)))
          return warn("The boxes agent is older than the brain. Run Update, or infra/deploy.sh.");
        if (brainSha && s.version && s.version !== brainSha)
          return warn(
            `The boxes agent is ${s.version.slice(0, 7)}, the brain ${brainSha.slice(0, 7)}. Run Update.`,
          );
        return ok(`The agent answers${s.version ? `, on ${s.version.slice(0, 7)}` : ""}.`);
      },
    },
    {
      id: "boxes.backends",
      name: "Box backends",
      run: async () => {
        const s = await status().catch(() => null);
        if (!s) return skip("The boxes agent isn't answering.");
        if (!s.features?.includes("check"))
          return skip("The boxes agent is too old to try one. Run Update.");
        const r = await agent.check();
        if (!r.ok) return fail(r.error);
        const shared = [!r.ownUser && "the agent's user", !r.ownNetwork && "the agent's network"]
          .filter(Boolean)
          .join(" and ");
        if (shared)
          return fail(
            `A test box's backend ran with ${shared}, so boxes aren't fenced in. Run infra/deploy.sh once, then infra/verify.sh on the host.`,
          );
        return ok("A test box built and answered, as a user of its own with no network.");
      },
    },
  ];
}
