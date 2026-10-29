import { type PluginCheck, SandboxError } from "@hatbot/plugin-sdk";
import type { DesktopAgent } from "./client";

const FEATURES = ["profiles", "exec", "files", "fields", "gates"];

type Result = Awaited<ReturnType<PluginCheck["run"]>>;
const ok = (detail: string): Result => ({ state: "ok", detail });
const warn = (detail: string): Result => ({ state: "warn", detail });
const fail = (detail: string): Result => ({ state: "fail", detail });
const skip = (detail: string): Result => ({ state: "skip", detail });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Made for each Check everything, so its lines share one health call. */
export function desktopChecks(agent: DesktopAgent, brainSha: string | null): PluginCheck[] {
  if (!agent.configured)
    return [
      { id: "desktop", name: "Desktop", run: async () => skip("DESKTOP_AGENT_URL isn't set.") },
    ];
  let asked: ReturnType<DesktopAgent["status"]> | undefined;
  const status = () => {
    asked ??= agent.status(true);
    return asked;
  };
  const ifUp = (f: () => Promise<Result>) => async (): Promise<Result> => {
    const up = await status().then(
      () => true,
      () => false,
    );
    return up ? f() : skip("The desktop isn't answering.");
  };
  return [
    {
      id: "desktop",
      name: "Desktop",
      run: async () => {
        let s: Awaited<ReturnType<typeof status>>;
        try {
          s = await status();
        } catch (err) {
          return fail(`desktop-agent isn't answering: ${errorText(err)}`);
        }
        if (s.x === false)
          return fail(
            "desktop-agent answers, but no frame came from the screen. Restart the desktop.",
          );
        if (s.cdp === false)
          return fail(
            "Chromium's DevTools isn't answering. Restart hatbot-chromium on the desktop.",
          );
        const missing = FEATURES.filter((f) => !s.features?.includes(f));
        if (missing.length)
          return warn("desktop-agent is older than the brain. Run Update, or infra/deploy.sh.");
        if (brainSha && s.version && s.version !== brainSha)
          return warn(
            `desktop-agent is ${s.version.slice(0, 7)}, the brain ${brainSha.slice(0, 7)}. Run Update.`,
          );
        if (s.locked) return warn("You have control of it. Hand it back when you're done.");
        return ok(`${s.width}×${s.height}${s.version ? `, ${s.version.slice(0, 7)}` : ""}.`);
      },
    },
    {
      id: "desktop.profiles",
      name: "Browser profiles",
      run: ifUp(async () => {
        const s = await status();
        if (s.profile === undefined) return skip("desktop-agent is too old to say.");
        if (s.profile === null)
          return warn(
            "Every bot shares one browser profile. Run infra/deploy.sh once on the host to install hatbot-chromium.service.",
          );
        return ok(`Chromium runs per bot; now on ${s.profile}'s profile.`);
      }),
    },
    {
      id: "desktop.timezone",
      name: "Desktop time zone",
      run: ifUp(async () => {
        const s = await status();
        const brain = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!s.timeZone) return skip("desktop-agent is too old to say.");
        if (s.timeZone !== brain)
          return warn(
            `The desktop is on ${s.timeZone} and the brain on ${brain}. Pages see the desktop's, so set it to yours.`,
          );
        return ok(s.timeZone);
      }),
    },
    {
      id: "desktop.shell",
      name: "Desktop shell",
      run: ifUp(async () => {
        try {
          const r = await agent.exec("echo ok", 10);
          if (r.exitCode !== 0 || !r.output.includes("ok"))
            return fail(`A test command exited with ${r.exitCode}.`);
          return ok("Runs commands.");
        } catch (err) {
          if (err instanceof SandboxError && err.status === 423)
            return skip("You have control of the desktop.");
          if (err instanceof SandboxError && err.status === 503)
            return fail("The shell isn't running. Run infra/deploy.sh once.");
          throw err;
        }
      }),
    },
    {
      id: "desktop.render",
      name: "Page scripts",
      run: ifUp(async () => {
        if (!(await status()).features?.includes("render"))
          return warn("desktop-agent is too old to run a page's scripts. Run Update.");
        try {
          await agent.renderCheck();
          return ok("Watchers can run a page's scripts.");
        } catch (err) {
          if (err instanceof SandboxError && err.status === 503)
            return fail("The renderer isn't running. Run infra/deploy.sh once.");
          if (err instanceof SandboxError) return fail(err.message);
          throw err;
        }
      }),
    },
    {
      id: "desktop.browser",
      name: "Desktop browser",
      run: ifUp(async () => {
        const s = await agent.browserState();
        const tab = s.tabs.find((t) => t.active) ?? s.tabs[0];
        // Only the site: the report is kept, and a page's address can carry what you typed or a token.
        let site = "";
        try {
          site = tab?.url ? new URL(tab.url).host : "";
        } catch {
          // Not an address with a host, like about:blank.
        }
        return ok(
          `${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"} open${site ? `, on ${site}` : ""}.`,
        );
      }),
    },
  ];
}
