import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CallContext } from "../src/plugins/plugin";
import { runPluginTool } from "../src/plugins/registry";
import { parseMetrics, uptimeKumaPlugin } from "../src/plugins/uptimekuma";
import { FakeModel } from "./fake-model";
import { testApp } from "./helpers";

const auths: (string | null)[] = [];
let server: ReturnType<typeof Bun.serve>;

const labels = (name: string, type: string, url: string, host: string, port: string) =>
  `monitor_name="${name}",monitor_type="${type}",monitor_url="${url}",monitor_hostname="${host}",monitor_port="${port}"`;
const web = labels("Jellyfin", "http", "https://jf.home", "null", "null");
const ssh = labels("NAS ssh", "port", "https://", "192.168.55.205", "22");
const quoted = labels('Say \\"hi\\" \\\\ there', "keyword", "https://hi.home/a", "null", "null");
const dns = labels("DNS", "dns", "https://", "1.1.1.1", "53");

const METRICS = `# HELP monitor_cert_days_remaining The number of days remaining until the certificate expires
# TYPE monitor_cert_days_remaining gauge
monitor_cert_days_remaining{${web}} 41
# HELP monitor_cert_is_valid Is the certificate still valid? (1 = Yes, 0= No)
# TYPE monitor_cert_is_valid gauge
monitor_cert_is_valid{${web}} 1
# HELP monitor_response_time Monitor Response Time (ms)
# TYPE monitor_response_time gauge
monitor_response_time{${web}} 123.4
monitor_response_time{${ssh}} -1
monitor_response_time{${quoted}} 80
# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)
# TYPE monitor_status gauge
monitor_status{${web}} 1
monitor_status{${ssh}} 0
monitor_status{${quoted}} 2
monitor_status{${dns}} 3 1760000000000
# a stray comment
process_cpu_user_seconds_total 0.5
`;

// A stand-in for Uptime Kuma's /metrics.
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const auth = req.headers.get("authorization");
      auths.push(auth);
      if (new URL(req.url).pathname !== "/metrics")
        return new Response("not found", { status: 404 });
      if (auth !== `Basic ${btoa(":uk_key")}`) return new Response("Unauthorized", { status: 401 });
      return new Response(METRICS, { headers: { "content-type": "text/plain; version=0.0.4" } });
    },
  });
});
afterAll(() => server.stop(true));

const env = (key = "uk_key") => ({
  UPTIME_KUMA_URL: `http://127.0.0.1:${server.port}/`,
  UPTIME_KUMA_API_KEY: key,
});
const call: CallContext = { task: null, signal: new AbortController().signal };

async function started(key?: string) {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [uptimeKumaPlugin], env(key));
  await t.plugins.update("uptimekuma", { enabled: true });
  const uk = (name: string) => {
    const found = t.plugins.tools().find((x) => x.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { t, uk };
}

test("without a key it needs setup", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [uptimeKumaPlugin], {});
  expect((await t.plugins.update("uptimekuma", { enabled: true })).state).toBe("needs_setup");
});

test("parses escaped label values, timestamps and skips comments", () => {
  const s = parseMetrics(
    'a{x="q\\"uote",y="back\\\\slash",z="new\\nline"} 2 123\n# HELP a b\nb 3\nbad{x="open 1\n',
  );
  expect(s).toEqual([
    { name: "a", labels: { x: 'q"uote', y: "back\\slash", z: "new\nline" }, value: 2 },
    { name: "b", labels: {}, value: 3 },
  ]);
});

test("lists monitors down first, with targets, response times and certificates", async () => {
  const { t, uk } = await started();
  expect(await t.plugins.test("uptimekuma")).toBe("Sees 4 monitors, 1 down.");
  expect(auths.at(-1)).toBe(`Basic ${Buffer.from(":uk_key").toString("base64")}`);

  const out = await runPluginTool(uk("uptimekuma_monitors"), {}, call);
  expect(out.untrusted).toBe(false);
  expect(out.content.split("\n")).toEqual([
    "NAS ssh: down, port 192.168.55.205:22",
    'Say "hi" \\ there: pending, keyword https://hi.home/a, 80 ms',
    "DNS: maintenance, dns 1.1.1.1:53",
    "Jellyfin: up, http https://jf.home, 123 ms, cert 41 days left",
  ]);
  expect(await uk("uptimekuma_monitors").run({ status: "up" }, call)).toBe(
    "Jellyfin: up, http https://jf.home, 123 ms, cert 41 days left",
  );
});

test("one monitor by name, case-insensitive; unknown names suggest close ones", async () => {
  const { uk } = await started();
  expect(await uk("uptimekuma_monitor").run({ name: "jellyfin" }, call)).toBe(
    [
      "Jellyfin: up",
      "Type: http",
      "URL: https://jf.home",
      "Response time: 123 ms",
      "Certificate: 41 days left",
      "Certificate valid: yes",
    ].join("\n"),
  );
  const miss = await runPluginTool(uk("uptimekuma_monitor"), { name: "Jelyfin" }, call);
  expect(miss.isError).toBe(true);
  expect(miss.content).toBe('No monitor named "Jelyfin". Did you mean "Jellyfin"?');
});

test("a refused key is a clear error", async () => {
  const { t, uk } = await started("wrong");
  await expect(t.plugins.test("uptimekuma")).rejects.toThrow(
    "Uptime Kuma refused the API key (401)",
  );
  const out = await runPluginTool(uk("uptimekuma_monitors"), {}, call);
  expect(out.isError).toBe(true);
  expect(out.content).toContain("Check UPTIME_KUMA_API_KEY in /etc/hatbot/uptimekuma.env");
});
