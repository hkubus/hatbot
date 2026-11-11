import { expect, test } from "bun:test";
import type { PluginField, PluginInfo } from "@hatbot/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "./dom";

const dom = installDom();
const { configFrom, draftOf, keyOf } = await import("../src/plugin-form");
const { PluginPage } = await import("../src/pages/Plugins");
const store = await import("../src/store");

// As the brain describes an installed plugin's settings (installer.test.ts's Dialer).
const FORM: PluginField[] = [
  { path: ["greeting"], label: "What it says first", kind: "text", max: 40, nullable: false },
  {
    path: ["tone"],
    label: "Tone",
    kind: "choice",
    choices: [
      { value: "warm", label: "Warm" },
      { value: "dry", label: "Dry" },
    ],
  },
  {
    path: ["rings"],
    label: "Rings",
    kind: "number",
    integer: true,
    min: 1,
    max: 9,
    nullable: false,
  },
  {
    path: ["quiet"],
    label: "Quiet",
    kind: "group",
    fields: [{ path: ["quiet", "night"], label: "Night", kind: "switch" }],
  },
  { path: ["numbers"], label: "Numbers", kind: "list", numbers: false },
];
const CONFIG = {
  greeting: "hi",
  tone: "warm",
  rings: 3,
  quiet: { night: false },
  numbers: ["555"],
  routes: [{ to: "desk" }],
};

test("what the form doesn't show stays, and an emptied number goes back to its default", () => {
  const draft = {
    ...draftOf(FORM, CONFIG),
    [keyOf(["rings"])]: "",
    [keyOf(["quiet", "night"])]: true,
    [keyOf(["numbers"])]: " 555\n\n556 ",
  };
  expect(configFrom(FORM, CONFIG, draft)).toEqual({
    config: {
      greeting: "hi",
      tone: "warm",
      quiet: { night: true },
      numbers: ["555", "556"],
      routes: [{ to: "desk" }],
    },
  });
  expect(CONFIG.quiet.night).toBe(false);
});

test("text you didn't change stays as it was; what you typed is trimmed", () => {
  const text = (name: string): PluginField => ({
    path: [name],
    label: name,
    kind: "text",
    max: null,
    nullable: false,
  });
  const fields = [text("prefix"), text("webhook"), text("name")];
  const config = { prefix: "> ", name: "desk" };
  expect(configFrom(fields, config, draftOf(fields, config))).toEqual({ config });
  const draft = { ...draftOf(fields, config), [keyOf(["name"])]: " front desk " };
  expect(configFrom(fields, config, draft)).toEqual({
    config: { prefix: "> ", name: "front desk" },
  });
});

test("a list of numbers refuses a line that isn't one, at its field", () => {
  const ids: PluginField = { path: ["ids"], label: "Ids", kind: "list", numbers: true };
  const draft = { [keyOf(["ids"])]: "105\nnas" };
  expect(configFrom([ids], { ids: [] }, draft)).toEqual({
    at: ["ids"],
    error: "One number a line.",
  });
});

test("an installed plugin's page has its settings as a form; a built-in one keeps its own", async () => {
  const plugin = (patch: Partial<PluginInfo>): PluginInfo => ({
    id: "dialer",
    name: "Dialer",
    description: "Rings",
    enabled: true,
    state: "ready",
    message: null,
    env: [],
    named: null,
    config: CONFIG,
    form: FORM,
    tools: [],
    testable: false,
    source: { url: "https://example.com/dialer.git", commit: "a".repeat(40) },
    ...patch,
  });
  dom.answer((r) =>
    r.path === "/plugins"
      ? [
          plugin({}),
          plugin({
            id: "proxmox",
            config: { careful: [105] },
            form: [{ path: ["careful"], label: "Careful", kind: "list", numbers: true }],
            source: null,
          }),
        ]
      : {},
  );
  await store.loadPlugins();

  const page = renderToStaticMarkup(<PluginPage id="dialer" toast={() => {}} />);
  for (const label of ["Settings", "What it says first", "Tone", "Rings", "Quiet", "Night"])
    expect(page).toContain(label);
  expect(page).toContain('value="hi"');
  expect(page).toContain('type="number" min="1" max="9" step="1"');
  expect(page).toContain(">555</textarea>");
  expect(page).not.toContain("desk");

  const builtIn = renderToStaticMarkup(<PluginPage id="proxmox" toast={() => {}} />);
  expect(builtIn).toContain("Always ask before powering or changing these guests");
  expect(builtIn).not.toContain(">Careful<");
});
