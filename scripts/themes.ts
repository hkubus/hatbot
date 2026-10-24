// Writes apps/web/src/themes.css: Material's 2025 Tonal spot scheme for each bot colour, as the web
// app's colour variables. The app wears the scheme of the bot you're with. `bun run themes`.
import {
  argbFromHex,
  Hct,
  hexFromArgb,
  MaterialDynamicColors,
  SchemeNeutral,
  SchemeTonalSpot,
  TonalPalette,
} from "@material/material-color-utilities";
import { BOT_COLORS, type BotColor } from "../packages/shared/src/index.ts";

const SEEDS: Record<BotColor, string> = {
  amber: "#ff9f2e",
  red: "#dd3730",
  pink: "#d81b60",
  purple: "#8e44ad",
  indigo: "#4c55c4",
  blue: "#1a73e8",
  teal: "#00838f",
  green: "#2e8540",
  gray: "#7d7168",
};

function roles(color: BotColor, dark: boolean) {
  const Scheme = color === "gray" ? SchemeNeutral : SchemeTonalSpot;
  const s = new Scheme(Hct.fromInt(argbFromHex(SEEDS[color])), dark, 0, "2025", "phone");
  const out: Record<string, string> = {};
  for (const c of new MaterialDynamicColors().allColors) out[c.name] = hexFromArgb(c.getArgb(s));
  for (const t of [10, 30, 90]) out[`p${t}`] = hexFromArgb(s.primaryPalette.tone(t));
  return out;
}

// What needs you and what's done keep their own hues whatever the bot's.
const tone = (hex: string, chroma: number, light: number, dark: number) => {
  const p = TonalPalette.fromHueAndChroma(Hct.fromInt(argbFromHex(hex)).hue, chroma);
  return `light-dark(${hexFromArgb(p.tone(light))}, ${hexFromArgb(p.tone(dark))})`;
};
const BLUE = "#1a73e8";
const GREEN = "#1e8e3e";

// A data URL can't take a variable, so the to-do tick is drawn in each theme's --on-primary.
const tick = (hex: string) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23${hex.slice(1)}' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E")`;

function tokens(color: BotColor): [string, string][] {
  const L = roles(color, false);
  const D = roles(color, true);
  const ld = (light: string, dark = light) => `light-dark(${L[light]}, ${D[dark]})`;
  return [
    ["--bg-light", L.surface],
    ["--bg-dark", D.surface],
    ["--surface", ld("surface")],
    ["--surface-1", ld("surface_container")],
    ["--surface-2", ld("surface_container_high")],
    ["--surface-3", ld("surface_container_highest")],
    ["--text", ld("on_surface")],
    ["--text-2", ld("on_surface_variant")],
    ["--muted", ld("on_surface_variant")],
    ["--soft", ld("outline")],
    ["--line", ld("outline_variant")],
    ["--outline", ld("outline")],
    ["--inverse", ld("inverse_surface")],
    ["--on-inverse", ld("inverse_on_surface")],
    ["--primary", ld("primary")],
    ["--on-primary", ld("on_primary")],
    ["--accent", ld("primary_container")],
    ["--on-accent", ld("on_primary_container")],
    ["--accent-text", ld("primary")],
    ["--accent-soft", ld("secondary_container")],
    ["--on-accent-soft", ld("on_secondary_container")],
    ["--selected", ld("secondary_container")],
    ["--on-selected", ld("on_secondary_container")],
    ["--secondary", ld("secondary")],
    ["--user-bubble", ld("p90", "p30")],
    ["--on-user-bubble", ld("p10", "p90")],
    ["--attention", tone(BLUE, 48, 40, 80)],
    ["--on-attention", tone(BLUE, 48, 100, 20)],
    ["--attention-soft", tone(BLUE, 36, 90, 30)],
    ["--on-attention-soft", tone(BLUE, 36, 10, 90)],
    ["--danger", ld("error")],
    ["--danger-text", ld("error")],
    ["--on-danger", ld("on_error")],
    ["--danger-soft", ld("error_container")],
    ["--on-danger-soft", ld("on_error_container")],
    ["--success", tone(GREEN, 40, 40, 80)],
    ["--success-text", tone(GREEN, 40, 40, 80)],
    ["--success-soft", tone(GREEN, 30, 90, 30)],
    ["--tick-light", tick(L.on_primary)],
    ["--tick-dark", tick(D.on_primary)],
  ];
}

const base = tokens("amber");
const block = (selector: string, vars: [string, string][]) =>
  `${selector} {\n${vars.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}\n`;
let css = `/* Made by scripts/themes.ts; run \`bun run themes\` rather than editing. Amber is Hatbot's own and the
   default. --bg-light and --bg-dark of amber are copied into index.html, offline.html, theme.js and the
   manifest, which run before this loads. */\n${block(":root", base)}`;
for (const color of BOT_COLORS.slice(1)) {
  const vars = tokens(color).filter(([k, v]) => base.find(([bk]) => bk === k)?.[1] !== v);
  css += block(`:root[data-hue="${color}"]`, vars);
}
await Bun.write(new URL("../apps/web/src/themes.css", import.meta.url), css);
