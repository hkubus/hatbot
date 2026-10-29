// Connect buttons: MCP's sign-in (OAuth 2.1, PKCE, a public client registered on the fly). The
// browser goes to the server's page to let Hatbot in, and comes back to the plugin's settings.
import { createHash, randomBytes } from "node:crypto";
import { PluginError } from "@hatbot/plugin-sdk";
import { z } from "zod";

export type OAuthEndpoints = { register: string; authorize: string; token: string };
export type OAuthToken = { token: string; expiresIn: number | null };
type Http = (url: string, init?: RequestInit) => Promise<Response>;

const SIGN_IN_MS = 10 * 60_000;
const Finish = z.object({ code: z.string().min(1).max(1000), state: z.string().min(1).max(200) });
const Metadata = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
});

type Pending = { ends: OAuthEndpoints; clientId: string; verifier: string; at: number };

async function why(res: Response) {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const said = body.error_description ?? body.error;
  return typeof said === "string" ? said : `it answered ${res.status}`;
}

/** The server's endpoints, from its metadata (RFC 8414). */
export async function discover(name: string, url: string, http: Http): Promise<OAuthEndpoints> {
  const res = await http(`${url}/.well-known/oauth-authorization-server`, {
    headers: { accept: "application/json" },
  }).catch(() => {
    throw new PluginError(`${name} at ${url} didn't answer.`);
  });
  const m = res.ok ? Metadata.safeParse(await res.json().catch(() => null)) : null;
  if (!m?.success)
    throw new PluginError(`${name} at ${url} can't connect apps yet: update ${name}.`);
  // Its pages must be where it is: a server that names another sends the owner's browser there.
  const ends = {
    register: m.data.registration_endpoint,
    authorize: m.data.authorization_endpoint,
    token: m.data.token_endpoint,
  };
  if (Object.values(ends).some((e) => new URL(e).origin !== new URL(url).origin))
    throw new PluginError(`${name} at ${url} sent its sign-in somewhere else, so it wasn't used.`);
  return ends;
}

/** Kept outside the plugin: saving its address restarts it between Connect and the way back. */
export function oauthClient(name: string, redirect: string) {
  const pending = new Map<string, Pending>();
  return {
    async connect(ends: OAuthEndpoints, http: Http): Promise<{ url: string }> {
      const reg = await http(ends.register, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Hatbot",
          redirect_uris: [redirect],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }).catch(() => {
        throw new PluginError(`${name} didn't answer.`);
      });
      if (!reg.ok) throw new PluginError(`${name} wouldn't register Hatbot: ${await why(reg)}`);
      const { client_id: clientId } = (await reg.json()) as { client_id?: string };
      if (typeof clientId !== "string") throw new PluginError(`${name} didn't register Hatbot.`);
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      const now = Date.now();
      for (const [k, p] of pending) if (now - p.at > SIGN_IN_MS) pending.delete(k);
      pending.set(state, { ends, clientId, verifier, at: now });
      const go = new URL(ends.authorize);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirect,
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }))
        go.searchParams.set(k, v);
      return { url: go.href };
    },

    async finish(args: unknown, http: Http): Promise<OAuthToken> {
      const a = Finish.safeParse(args);
      const p = a.success && pending.get(a.data.state);
      if (!a.success || !p || Date.now() - p.at > SIGN_IN_MS)
        throw new PluginError("That sign-in is out of date: connect again.");
      pending.delete(a.data.state);
      const res = await http(p.ends.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: a.data.code,
          redirect_uri: redirect,
          client_id: p.clientId,
          code_verifier: p.verifier,
        }),
      });
      if (!res.ok) throw new PluginError(`${name} didn't let Hatbot in: ${await why(res)}`);
      const t = (await res.json()) as { access_token?: string; expires_in?: number };
      if (typeof t.access_token !== "string")
        throw new PluginError(`${name} didn't let Hatbot in.`);
      return { token: t.access_token, expiresIn: t.expires_in ?? null };
    },
  };
}
