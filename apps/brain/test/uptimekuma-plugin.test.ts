import { expect, test } from "bun:test";
import { runPluginTool } from "../src/plugins/registry";
import { uptimeKumaPlugin } from "../src/plugins/uptimekuma";
import { call, fakeApi, pluginApp, stopPluginsAfterEach } from "./plugin-helpers";

stopPluginsAfterEach();

const labels = (name: string, type: string, url: string, host: string, port: string) =>
  `monitor_name="${name}",monitor_type="${type}",monitor_url="${url}",monitor_hostname="${host}",monitor_port="${port}"`;
const web = labels("Jellyfin", "http", "https://jf.home", "null", "null");
const ssh = labels("NAS ssh", "port", "https://", "192.168.55.205", "22");
const quoted = labels('Say \\"hi\\" \\\\ there', "keyword", "https://hi.home/a", "null", "null");

const METRICS = `# HELP monitor_cert_days_remaining The number of days remaining until the certificate expires
# TYPE monitor_cert_days_remaining gauge
monitor_cert_days_remaining{${web}} 41
monitor_response_time{${web}} 123.4
monitor_response_time{${ssh}} -1
monitor_status{${web}} 1
monitor_status{${ssh}} 0
monitor_status{${quoted}} 2 1760000000000
process_cpu_user_seconds_total 0.5
`;

// A stand-in for Uptime Kuma's /metrics.
const api = fakeApi((req, url) => {
  if (url.pathname !== "/metrics") return new Response("not found", { status: 404 });
  if (req.headers.get("authorization") !== `Basic ${btoa(":uk_key")}`)
    return new Response("Unauthorized", { status: 401 });
  return new Response(METRICS, { headers: { "content-type": "text/plain; version=0.0.4" } });
});

test("lists the monitors down first, with the API key", async () => {
  const t = await pluginApp(uptimeKumaPlugin, {
    UPTIME_KUMA_URL: `${api.url}/`,
    UPTIME_KUMA_API_KEY: "uk_key",
  });
  expect(await t.plugins.test("uptimekuma")).toBe("Sees 3 monitors, 1 down.");
  const out = await runPluginTool(t.tool("uptimekuma_monitors"), {}, call);
  expect(out.untrusted).toBe(false);
  expect(out.content.split("\n")).toEqual([
    "NAS ssh: down, port 192.168.55.205:22",
    'Say "hi" \\ there: pending, keyword https://hi.home/a',
    "Jellyfin: up, http https://jf.home, 123 ms, cert 41 days left",
  ]);
});
