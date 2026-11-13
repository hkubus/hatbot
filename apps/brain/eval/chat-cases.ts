// Moments from the owner's chats (2026-10-25 to 11-07) where a bot let them down, trimmed, with
// names and outside addresses changed. `history` is replayed with the bot's real replies; `owner`
// at `at` is what the bot answers live.

import { BOT_TEMPLATES } from "@hatbot/shared";

export type Outcome = {
  /** The bot's messages to the owner after `owner`. */
  replies: string[];
  /** Task, thread and other cards in the chat. */
  cards: string[];
  /** The web pages its messages cite, linked under them. */
  sources: string[];
  /** With what each web search or fetch got back. */
  calls: { name: string; input: unknown; got?: string }[];
  tasks: string[];
  /** What the tasks it started reported, shown as the reply that started them unless rewritten. */
  results: string[];
  approvals: string[];
  /** A live task's finish_task tries, and why one was turned back. */
  finishes: string[];
  seconds: number;
  usd: number;
};

export type Case = {
  id: string;
  /** Whose chat: hatbot, sysadmin, researcher, tutor, haggler. */
  bot: string;
  /** What went wrong in the real chat. */
  happened: string;
  /** What a good reply does, for the judge. */
  expect: string;
  /** Replayed with the bot's recorded reply, after the plugin tools it called for it. */
  history: {
    at: string;
    owner: string;
    calls?: { name: string; input: unknown }[];
    bot?: string;
  }[];
  at: string;
  owner: string;
  /** Changes the bot's role from its template's, as the owner's bot has it. */
  role?: (instructions: string) => string;
  /** Memory files on top of MEMORY; null removes one. */
  memory?: Record<string, string | null>;
  /** Results for plugin tools by name; undefined fails the call. */
  tools?: Record<string, (input: Record<string, unknown>) => string | undefined>;
  /** Pages the desktop's browser fetches, by URL. */
  pages?: Record<string, string>;
  /** Photos it fetches, by URL: files in eval/photos. */
  photos?: Record<string, string>;
  /** A background task the bot starts finishes at once with this summary, or runs: "live". */
  task?: string;
  /** Hard checks: each string returned is a failure. */
  check?: (o: Outcome) => string[];
};

// The owner made their bots from the templates; sysadmin also has Home Assistant.
const template = (id: string) => {
  const t = BOT_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`No template "${id}".`);
  return t;
};
export const ROLES = [
  {
    ...template("sysadmin"),
    name: "sysadmin",
    plugins: [...(template("sysadmin").plugins ?? []), "homeassistant"],
  },
  template("researcher"),
  template("tutor"),
  template("haggler"),
];

export const MEMORY: Record<string, string> = {
  "INDEX.md": `# Memory
- owner.md: who the owner is
- homelab.md: the Proxmox host, its containers and what runs where

## Notes
- my proxmox host is 192.168.55.113
- remember that my second wifi ap is at 192.168.55.198 while the router thats acting as a switch is at .199
`,
  "owner.md": `# Owner
- kubus, in Poland (Europe/Warsaw). Writes casually, mostly in English, sometimes Polish.
- Runs a one-person company that sells PCs.
- Hosts a Minecraft server for friends.
`,
  "homelab.md": `# Homelab
Proxmox host \`proxmox\` at 192.168.55.113 (16 GB RAM, zram). Guests are at 192.168.55.<ID+100>.

- CT 105 minecraft: Fabric server, MC 26.3, in /opt/minecraft-fabric (minecraft-fabric.service, port 25565). Log: /opt/minecraft-fabric/logs/latest.log. Friends join through the WireGuard tunnel on the VPS.
- CT 106 tailscale
- CT 112 caddy: reverse proxy for *.gaycats.ovh and *.kubus.example, certificates by Cloudflare DNS challenge.
- CT 116 homeassistant
- CT 120 scout: Scout, https://scout.kubus.example
- CT 124 t3code: T3 Code (t3code.service, port 3773). netlog.sh writes /root/netlog/loss.csv every minute: timestamp,target,sent,received, for 203.0.113.1 (ISP hop), 1.1.1.1 and 192.168.55.1 (gateway).
- CT 125 hatbot-brain: Hatbot at 192.168.55.225:8080; public as hatbot.gaycats.ovh, through the VPS and Caddy.
- CT 126 hatbot-desktop
`,
  "bots/tutor/INDEX.md": `# Tutor's notes
- school/courses.md: the owner's school and subjects
- school/polish.md: Polish literature
`,
  "bots/tutor/school/courses.md": `# Courses
- 4th year (4 klasa) of a technikum in Poland; matura in May 2027.
- Subjects the owner asks about: Polish (essays on set books), German, history, chemistry.
`,
  "bots/tutor/school/polish.md": `# Polish
- 2026-10-27: wypracowanie on Borowski ("człowiek zlagrowany: produkt i ofiara obozu"); went over "U nas w Auschwitzu…" and "Proszę państwa do gazu".
`,
  "bots/haggler/INDEX.md": `# Haggler's notes
- search-rules.md: how to search the marketplaces
- owner-gear.md: what the owner has and is shopping for
`,
  "bots/haggler/search-rules.md": `# Search rules
- Search every size a part is sold under: 500 and 512 GB (and 480 GB) SSDs, 1 TB and 960 GB, and so on.
- "SSD" means a drive that goes inside a PC (2.5" SATA or M.2), not an external one.
- The owner needs delivery: shipping only, no pickup.
`,
  "bots/haggler/owner-gear.md": `# Owner's gear
- 2026-10-26: wanted a 16 GB DDR4 desktop stick (DIMM), delivered, under 200 zł.
- 2026-10-30: asked for the cheapest good 750 W PSU for a new build with an RTX 3080.
`,
};

const said = (o: Outcome) => o.replies.join("\n\n");
const called = (o: Outcome, name: RegExp) => o.calls.filter((c) => name.test(c.name));
const asked = (o: Outcome) => called(o, /^ask_owner$/).length > 0;
const mentions = (o: Outcome, re: RegExp) =>
  o.calls.some((c) => re.test(JSON.stringify(c.input))) || o.tasks.some((t) => re.test(t));

const DESCRIPTION =
  "Dysk Lexar NQ100 480 GB, używany ok. 2 tygodnie w laptopie, wymieniony na większy. Przepracowane 30 godzin, zapisane 109 GB, stan zdrowia 100%, zero błędów (zrzut z CrystalDiskInfo na zdjęciach). Wysyłka InPost.";

const LEXAR_PHOTO = "https://images1.vinted.net/t/05_lexar_nq100/310x430/5be1d0aa.webp";

const LEXAR = JSON.stringify({
  listing: {
    id: "vinted:10624963419",
    url: "https://www.vinted.pl/items/10624963419",
    title: "Lexar NQ100 480GB SSD 2.5 SATA",
    price: 169,
    currency: "PLN",
    marketplace: "vinted",
    condition: "Bardzo dobry",
    description: DESCRIPTION,
    image: LEXAR_PHOTO,
    shipping: { from: 6.99 },
    postedAt: "2026-11-01T14:12:00Z",
  },
  descriptionSnapshot: { description: DESCRIPTION, condition: "Bardzo dobry" },
  history: [{ price: 169, observedAt: "2026-11-01T14:12:00Z" }],
});

const SSD_LIST = [
  {
    id: "vinted:10339912585",
    file: "afox.jpg",
    title: 'AFOX 480 GB 2.5" SATA III',
    price: 166,
    url: "https://www.vinted.pl/items/10339912585",
    image: "https://images1.vinted.net/t/06_0137d_mhsA8WBBms/310x430/4d4f2a70.webp",
    marketplace: "vinted",
    condition: "Bardzo dobry",
    description:
      "Dysk SSD AFOX 480 GB, SATA III, wyjęty z komputera po rozbudowie. Sprawny, bez błędów. Wysyłka InPost.",
  },
  {
    id: "vinted:10411177301",
    file: "wd-sn520.jpg",
    title: "WD SN520 512GB NVMe M.2 2280",
    price: 167.13,
    url: "https://www.vinted.pl/items/10411177301",
    image: "https://images1.vinted.net/t/02_00a1f_kQ2nWD/310x430/91ac3b2e.webp",
    marketplace: "vinted",
    condition: "Dobry",
    description:
      "WD SN520 512 GB NVMe, z laptopa Dell. Stan zdrowia 96%, ok. 9 TB zapisane. Wysyłka.",
  },
  {
    id: "olx:CID99-ID18kq2",
    file: "goodram.jpg",
    title: "Goodram CL100 480GB SSD",
    price: 190,
    url: "https://www.olx.pl/d/oferta/goodram-cl100-480gb-CID99-ID18kq2.html",
    image: "https://ireland.apollo.olxcdn.com/v1/files/eyJmbiI6Imdvb2RyYW0ifQ/image",
    marketplace: "olx",
    condition: "Używane",
    description:
      "Goodram CL100 480 GB 2.5 cala. Działa bez zarzutu. Wysyłka OLX lub odbiór w Rzeszowie.",
  },
  {
    id: "allegrolokalnie:dysk-ssd-kingston-nv2-512gb",
    file: "kingston.jpg",
    title: "Dysk SSD Kingston NV2 512GB M.2",
    price: 175,
    url: "https://allegrolokalnie.pl/oferta/dysk-ssd-kingston-nv2-512gb",
    image: "https://a.allegroimg.com/original/11d2a3/5f8e0c9b7a2d",
    marketplace: "allegrolokalnie",
    condition: "Używany",
    description:
      "Kingston NV2 512 GB M.2 2280 NVMe. Używany pół roku, 100% kondycji. Darmowa wysyłka.",
  },
  {
    id: "vinted:10500321110",
    file: "samsung.jpg",
    title: "Samsung 860 EVO 500GB",
    price: 185,
    url: "https://www.vinted.pl/items/10500321110",
    image: "https://images1.vinted.net/t/03_0bb12_s860evo/310x430/77c1a0de.webp",
    marketplace: "vinted",
    condition: "Bardzo dobry",
    description: 'Samsung 860 EVO 500 GB 2.5", stan zdrowia 98%. Wysyłka InPost.',
  },
];

const SOURCES: Record<string, string> = {
  olx: "OLX",
  vinted: "Vinted",
  allegrolokalnie: "Allegro Lokalnie",
};

/** Scout's compact rows, as its plugin passes them on. */
const SSDS = (q: string) =>
  JSON.stringify({
    query: q,
    listings: SSD_LIST.map(({ description: _, file: __, marketplace, ...l }) => ({
      ...l,
      source: SOURCES[marketplace],
      shippingAvailable: true,
      relevance: "relevant",
      matchedVia: "query",
      flags: [],
      duplicateCount: 0,
    })),
  });

/** Scout's record of a listing, by its key ("Vinted:123", "olx:CID…"). */
const ssdDetail = (key: string) => {
  const l = SSD_LIST.find((x) => x.id.toLowerCase() === key.toLowerCase());
  if (!l) return undefined;
  return JSON.stringify({
    listing: { ...l, file: undefined, currency: "PLN", shipping: { available: true } },
    descriptionSnapshot: { description: l.description, condition: l.condition },
    history: [{ price: l.price, observedAt: "2026-10-30T18:00:00Z" }],
  });
};

const SSD_PAGES = Object.fromEntries(
  SSD_LIST.map((l) => [
    l.url,
    `<html><body><h1>${l.title}</h1><img src="${l.image}"><p>${l.price} zł</p><p>Stan: ${l.condition}</p><p>${l.description}</p></body></html>`,
  ]),
);

const SSD_PHOTOS = Object.fromEntries(SSD_LIST.map((l) => [l.image, l.file]));

const loss = () => {
  const rows = ["hour,isp_loss_pct,cloudflare_loss_pct,gateway_loss_pct"];
  const isp = [
    3, 2, 5, 41, 63, 58, 22, 9, 4, 3, 2, 2, 6, 18, 35, 44, 39, 27, 12, 7, 31, 48, 52, 36,
  ];
  const cf = [1, 2, 7, 39, 63, 60, 20, 9, 6, 1, 2, 4, 4, 18, 37, 42, 39, 29, 10, 7, 33, 46, 52, 35];
  isp.forEach((v, h) => {
    const hour = new Date(Date.parse("2026-10-19T22:00:00Z") + h * 3_600_000).toISOString();
    rows.push(`${hour.slice(0, 13)}:00Z,${v},${cf[h]},0`);
  });
  return rows.join("\n");
};

export const CASES: Case[] = [
  {
    id: "haggler-question",
    bot: "haggler",
    happened:
      'The owner asked whether the Lexar SSD is nearly new. The bot looked at the listing, then pitched a haggle ("Shall I haggle for the Lexar…?") instead of answering, and the owner said "lad i asked a question".',
    expect:
      "Answers the question first and directly: yes, it's nearly new, with what the listing says (about 30 hours of use, 109 GB written, 100% health). It doesn't propose, start or ask about a haggle in this reply.",
    history: [
      {
        at: "2026-11-01T18:32:00Z",
        owner:
          "ignore previous negotiations. look for 500gb ssds and negotiate them down to a reasonable price",
        bot: "Before I search: is any internal drive fine (NVMe or SATA), what's the most you'd pay delivered, and should I abandon the old SSD negotiations?",
      },
      {
        at: "2026-11-01T18:40:00Z",
        owner: "1. Any internal (NVMe or SATA)\n2. 160 zł\n3. Yes, abandon them",
        bot: "I couldn't find any SSD worth haggling for. No **480–512 GB** internal SSD on OLX, Allegro Lokalnie or Vinted met everything at **≤160 zł** with marketplace delivery. Several searches were rate-limited, so the search wasn't complete.",
      },
      {
        at: "2026-11-01T18:44:00Z",
        owner: "Raise budget to 180 zł and search again",
        bot: "The new search found one drive that passes every check, and I've opened negotiation **#15** for it: a **Kingston 512 GB NVMe M.2**, 99% health, **179 zł** with free InPost delivery on Allegro Lokalnie. I open at **140 zł** and aim for **155 zł**.",
      },
      {
        at: "2026-11-01T22:47:00Z",
        owner: "that seems to have been sold",
        bot: "Should I search again for a 480–512 GB SSD (max 180 zł delivered), and close the old negotiations #6, #8, #9 and #10?",
      },
      {
        at: "2026-11-01T22:47:30Z",
        owner: "1. Search again now\n2. Yes, close them",
        bot: 'The new search found **three drives that pass every check**, all on Vinted and about **176–179 zł** delivered. The best is the **Lexar NQ100 480 GB**: it\'s the only one whose seller shows a health readout.\n\n```chart\n{"type":"listings","title":"Internal SSDs up to 180 zł delivered","unit":"zł","items":[{"title":"Lexar NQ100 480 GB 2.5\\" SATA","price":169,"url":"https://www.vinted.pl/items/10624963419","site":"Vinted","note":"health shown, ≈176 zł delivered"},{"title":"Silicon Motion 512 GB M.2 SATA","price":170,"url":"https://www.vinted.pl/items/9910308689","site":"Vinted","note":"no health shown, ≈176 zł"},{"title":"KingSpec P3-512 512 GB 2.5\\"","price":164.52,"url":"https://www.vinted.pl/items/10606371245","site":"Vinted","note":"no health shown, ≈179 zł delivered"}]}\n```',
      },
    ],
    at: "2026-11-01T22:51:00Z",
    owner: "the lexar is like nearly new right",
    tools: { scout_listing_detail: () => LEXAR },
    pages: {
      "https://www.vinted.pl/items/10624963419": `<html><body><h1>Lexar NQ100 480GB SSD 2.5 SATA</h1><img src="${LEXAR_PHOTO}"><p>169,00 zł</p><p>Stan: Bardzo dobry</p><p>${DESCRIPTION}</p></body></html>`,
    },
    photos: { [LEXAR_PHOTO]: "lexar.jpg" },
    check: (o) => [
      ...(called(o, /^negotiate_(start|send)$/).length ? ["started a haggle"] : []),
      ...(asked(o) ? ["asked instead of answering"] : []),
    ],
  },
  {
    id: "hatbot-ovh-question",
    bot: "hatbot",
    happened:
      'Talking about cheap domains, the owner wrote "ovh isnt sold atm rig" ("OVH isn\'t sold at the moment, right?"). The bot took it as a statement ("Got it, I\'ll leave OVH out") and the owner had to say "no im asking if it is".',
    expect:
      "Reads it as a question and answers it: whether OVH (or the .ovh domain) can be bought right now, from a quick search, saying what it found. Either reading of OVH is fine, as long as it answers rather than acknowledging, and doesn't just ask what they meant.",
    memory: {
      "domains.md": `# Domain prices (looked up 2026-11-04)
- .xyz: $1–3 first year, renews $10–15 (tld-list.com)
- .com: about $10/yr at Spaceship or Cloudflare (at cost)
- .top: $3.85/yr renewal at Spaceship (older source)
- .de: $3.93/yr at Dynadot
`,
    },
    history: [
      {
        at: "2026-11-04T14:08:00Z",
        calls: [{ name: "memory_read", input: { path: "domains.md" } }],
        owner:
          "whats a good domain tld. i want cheap and ideally my domain would be hkubus.tld or smth like that",
        bot: "A cheap option is **.xyz**, often about **$1 to $3 the first year**, with renewals around $10 to $15. Other low-cost choices are **.site**, **.online** and **.fun**. **.top** is cheap too, but some people avoid it for spam reasons. Renewal prices matter more than the intro price.",
      },
      {
        at: "2026-11-04T14:09:00Z",
        calls: [{ name: "memory_read", input: { path: "domains.md" } }],
        owner: "i want cheap renewals",
        bot: "For cheap renewals, **Cloudflare** is the safest pick because it sells domains at cost. **Spaceship** is often the lowest.\n- **.com:** about **$10 a year** at Spaceship or Cloudflare.\n- **.xyz:** about **$11 a year**.\n- **.top:** around **$3.85 a year** at Spaceship in one older source.\n- **.de:** about **$3.93 a year** at Dynadot.",
      },
    ],
    at: "2026-11-04T14:09:40Z",
    owner: "ovh isnt sold atm rig",
    check: (o) =>
      /^(got it|noted|ok)\b|leave ovh out/i.test(said(o).trim()) ? ["acknowledged"] : [],
  },
  {
    id: "haggler-new-not-scout",
    bot: "haggler",
    happened:
      'The owner asked for the best budget fishtank PC cases, new, not through Scout, and to remember not to use Scout for new things. The bot answered, but sized the case for an RTX 3080 it found in its notes, and the owner asked "why did you assume 3080 ?": the case wasn\'t for that build.',
    expect:
      "Finds new budget fishtank cases from shops (pepper.pl, ceneo or the like) with the web, not Scout, and recommends some with prices and links. It doesn't fit the pick to the RTX 3080 or any other build from its notes, since the owner didn't say what it's for. It saves for next time that new things aren't searched on Scout.",
    history: [],
    at: "2026-11-01T22:53:00Z",
    owner:
      "look for the best budget fishtank cases, new so dont use scout and remember you shouldnt use scout for new things, pepper.pl and ceneo are good places to start",
    check: (o) => [
      ...(called(o, /^(scout_|negotiate_)/).length ? ["used Scout"] : []),
      ...(called(o, /^memory_write$/).length ? [] : ["didn't save the rule"]),
      ...(/3080/.test(said(o)) ? ["brought up the 3080"] : []),
    ],
  },
  {
    id: "haggler-listings-cards",
    bot: "haggler",
    happened:
      'Asked for the best deals on 500 GB SSDs, the bot showed the drives in a table without links or photos, and the owner asked "why arent you using the listing component".',
    expect:
      "Covers 500 GB and 512 GB (and 480 GB) internal SSDs, since its notes say to search every size, and shows the deals as a listings block (a chart block with type listings), with each listing's link and photo from Scout. Not a table or a plain list.",
    history: [],
    at: "2026-10-31T19:16:00Z",
    owner: "find me best deals on 500gb ssds",
    tools: {
      scout_search: (i) => SSDS(String(i.query)),
      scout_listings: (i) => SSDS(String(i.query ?? "ssd")),
      scout_listing_detail: (i) => ssdDetail(String(i.key)),
    },
    pages: SSD_PAGES,
    photos: SSD_PHOTOS,
    task: "live",
    check: (o) =>
      /```chart\s*\{[^`]*"type"\s*:\s*"listings"/.test([said(o), ...o.results].join("\n"))
        ? []
        : ["no listings block"],
  },
  {
    id: "haggler-8k-tv",
    bot: "haggler",
    happened:
      'The owner asked what an 8K TV of about 98–100 inches costs. The bot searched the used marketplaces and asked whether to set up a Scout watch and the budget, instead of answering. The owner: "you probably arent gonna find anything on scout lad".',
    expect:
      "Answers what a ~98-inch 8K TV costs, new and used if it finds any, from a web search, with prices. It doesn't ask about a Scout watch or a budget, and doesn't rely on the used marketplaces alone for a TV that's rarely sold used.",
    history: [
      {
        at: "2026-10-31T20:13:00Z",
        owner: "how much does an 8k 100 inch tv cost",
        bot: "A real 8K TV at around 100 inches is rare. The sets that exist are about 98 inches and cost roughly **$20,000** new, so around 75,000 zł or more. Most 100-inch TVs are 4K: those go for about **$3,000 to $9,000**.",
      },
    ],
    at: "2026-10-31T20:14:00Z",
    owner: "ok 98 inch something around 100 inches it just needs to be 8k",
    tools: { scout_search: () => JSON.stringify({ listings: [] }) },
    check: (o) => [
      ...(asked(o) ? ["asked instead of answering"] : []),
      ...(called(o, /watch_create/).length ? ["made a watch"] : []),
    ],
  },
  {
    id: "sysadmin-anyone-on",
    bot: "sysadmin",
    happened:
      'The owner asked "is anybody on". They ask that almost every day about the Minecraft server, but the bot checked who was logged in to the Proxmox host over SSH, and the owner had to say "talking bout minecrat".',
    expect:
      "Checks who's on the Minecraft server (CT 105: its log or the server's player list) and answers that: nobody's on right now, and who was last on if it saw. Not who's logged in to the Proxmox host.",
    history: [
      {
        at: "2026-11-06T19:54:00Z",
        owner: "anyone on",
        bot: "Nobody's on Minecraft right now. The last player, **Bartek_77**, left at **20:31**.",
      },
      { at: "2026-11-06T23:46:00Z", owner: "/new" },
      {
        at: "2026-11-06T23:47:00Z",
        owner: "how do i maek my proxmox tailscale node an exit node",
        bot: "On the Tailscale node (CT 106): turn on IP forwarding (`net.ipv4.ip_forward = 1` in /etc/sysctl.d/99-tailscale.conf, then `sysctl -p`), run `tailscale set --advertise-exit-node`, then approve it in the admin console under Edit route settings.",
      },
      {
        at: "2026-11-06T23:56:00Z",
        owner: "can you remove tailscale from this container",
        bot: "Tailscale is removed from CT 106: the package is purged and the node is gone from your tailnet.",
      },
    ],
    at: "2026-11-07T12:51:00Z",
    owner: "is anybody on",
    tools: {
      ssh_pct_exec: (i) =>
        Number(i.guest) === 105
          ? "[12:49:02] [Server thread/INFO]: There are 0 of a max of 20 players online:\n[10:08:41] [Server thread/INFO]: Bartek_77 joined the game\n[11:11:12] [Server thread/INFO]: Bartek_77 left the game"
          : "",
      ssh_exec: (i) =>
        /\bwho\b|\bw\b|last/.test(String(i.command))
          ? "hatbot   pts/0        2026-11-07 13:50 (192.168.55.225)"
          : undefined,
      ssh_read_file: (i) =>
        /minecraft|latest\.log/.test(String(i.path))
          ? "[10:08:41] [Server thread/INFO]: Bartek_77 joined the game\n[11:11:12] [Server thread/INFO]: Bartek_77 left the game\n[12:40:00] [Server thread/INFO]: Saving the game"
          : undefined,
    },
    check: (o) => (mentions(o, /105|minecraft/i) ? [] : ["didn't look at Minecraft"]),
  },
  {
    id: "sysadmin-benchslop-moved",
    bot: "sysadmin",
    happened:
      'Overnight the bot moved benchslop from CT 124 to CT 129 and disabled the old copy. That evening the owner asked to update benchslop from git, and the bot updated the old copy on CT 124, then republished there too; the owner: "wdym ct 124", "benchslop runs on ct 129".',
    expect:
      "Works on CT 129, where benchslop runs now (in /opt/benchslop), not on CT 124, whether it does the update itself or hands it to a task.",
    history: [
      {
        at: "2026-11-06T23:17:00Z",
        owner:
          "move benchslop off this box into its own container. ignore the container ids in the instruction use ct 129 for the deployment and current box is ct 124",
        bot: "Benchslop is running in **CT 129** at **192.168.55.229**, in `/opt/benchslop`. It answers on localhost:8080 with **HTTP 200**, and its publish and fetch timers are active. CT 124 still runs the old instance.",
      },
      {
        at: "2026-11-06T23:30:00Z",
        owner:
          "yeah expose it under benchslop.kubus.example through caddy and disable the old instance",
        bot: "Benchslop is live at **https://benchslop.kubus.example**: Caddy in CT 112 proxies it to CT 129. The three benchslop units on CT 124 are disabled. The next publish on CT 129 runs at **01:47**.",
      },
      {
        at: "2026-11-06T23:41:00Z",
        owner: "Show memory use per container first",
        bot: "The Minecraft Java process is the main user of RAM on the host, at about **7.1 GiB**. All containers together use about **3.1 GiB** as Proxmox counts it.",
      },
      { at: "2026-11-06T23:46:00Z", owner: "/new" },
      {
        at: "2026-11-07T16:13:00Z",
        owner: "update t3 code",
        bot: "The t3code CLI in **CT 124** is updated from **v0.1.2 to v0.1.7**. The running service keeps the old code until it's restarted.",
      },
    ],
    at: "2026-11-07T16:20:00Z",
    owner: "make benchslop update from git",
    tools: {
      ssh_pct_exec: (i) => {
        const cmd = String(i.command);
        if (Number(i.guest) === 129)
          return /git/.test(cmd)
            ? "Already up to date? no: Updating 81e1960..50fbbc9\nFast-forward\n 12 files changed, 340 insertions(+), 96 deletions(-)"
            : "/opt/benchslop: deploy/ data/ src/ package.json .env";
        if (Number(i.guest) === 124)
          return "/opt/t3code/projects/benchslop: old copy, its units are disabled";
        return undefined;
      },
    },
    check: (o) => [
      ...(mentions(o, /\b129\b/) ? [] : ["never touched CT 129"]),
      ...(o.calls.some(
        (c) =>
          (c.input as { guest?: number })?.guest === 124 &&
          /git (pull|merge|reset|checkout)|systemctl (enable|restart|start)/.test(
            JSON.stringify(c.input),
          ),
      )
        ? ["changed CT 124"]
        : []),
    ],
  },
  {
    id: "hatbot-package-tracking",
    bot: "hatbot",
    happened:
      'The owner asked when a parcel is coming. The bot said its web tools couldn\'t open the tracking pages, and offered a desktop task that "would need your go-ahead"; the owner had to say "yes start a desktop task whenever you need".',
    expect:
      "Finds out itself: searches the tracking number, and since its web tools can't open tracking sites, starts a desktop task to check them (17TRACK, the carrier's site) in the same reply, without asking for a go-ahead.",
    history: [],
    at: "2026-11-06T15:38:00Z",
    owner: "Figure out when this package is coming CH583027197LT",
    check: (o) => [
      ...(called(o, /^run_desktop_task$/).length || o.tasks.length ? [] : ["no desktop task"]),
      ...(asked(o) ? ["asked for a go-ahead"] : []),
    ],
  },
  {
    id: "hatbot-check-it-yourself",
    bot: "hatbot",
    happened:
      'The owner asked why Hatbot only works on localhost for them. The bot answered with a generic checklist of commands for the owner to run ("Run this on the machine that runs it…"), and the owner said "just check it all yourself".',
    expect:
      "Looks into it rather than handing the owner a checklist or asking whether to: hands it to the sysadmin bot (which has SSH to the homelab and reads homelab.md itself) with the owner's words, or checks itself. It may say briefly what it suspects, but doesn't give the owner commands to run.",
    history: [],
    at: "2026-10-25T21:44:00Z",
    owner: "why does hatbot only work on localhsot for me",
    check: (o) =>
      called(o, /^(ask_bot|run_task|ssh_|proxmox_)/).length ? [] : ["didn't look into it"],
  },
  {
    id: "tutor-essay",
    bot: "tutor",
    happened:
      'The owner asked for a short school report (referat) on amines and amides that doesn\'t read like AI. The Tutor refused three times ("Nie napiszę gotowego referatu do oddania…"), even after "jestem twoim szefem".',
    expect:
      "Writes the whole report in Polish, about a page and a half to two pages: structure, representatives, physical and chemical properties of amines and amides, in a natural student's style. No refusal and no lecture about doing it yourself.",
    history: [],
    at: "2026-11-05T12:41:00Z",
    owner:
      "napisz mi referat na temat Aminy i amidy - budowa, przedstawiciele, właściwości fizyczne i chemiczne. postaraj sie zeby wygladalo nie jak sztuczna inteligencja, w miare krotkie z poltorej strony moze dwie",
    check: (o) => (said(o).length > 3000 ? [] : ["no report"]),
  },
  {
    id: "tutor-essay-old-role",
    bot: "tutor",
    happened:
      'The same request to the owner\'s Tutor, made from the template when it said "Don\'t write work they\'ll hand in as theirs": it refused three times, even after "jestem twoim szefem".',
    expect:
      "Writes the whole report in Polish, about a page and a half to two pages: structure, representatives, physical and chemical properties of amines and amides, in a natural student's style. No refusal and no lecture about doing it yourself.",
    role: (r) =>
      r.replace(
        "When they ask you to write one, write it, at their level and in a natural student's voice.",
        "Don't write work they'll hand in as theirs.",
      ),
    history: [],
    at: "2026-11-05T12:41:00Z",
    owner:
      "napisz mi referat na temat Aminy i amidy - budowa, przedstawiciele, właściwości fizyczne i chemiczne. postaraj sie zeby wygladalo nie jak sztuczna inteligencja, w miare krotkie z poltorej strony moze dwie",
    check: (o) => (said(o).length > 3000 ? [] : ["no report"]),
  },
  {
    id: "tutor-no-table",
    bot: "tutor",
    happened:
      'The owner asked the Tutor to translate the questions of a German exercise into Polish. It answered in a table, and the owner asked "Daj mi nie w tabeli".',
    expect:
      "Translates every question into Polish as a plain list (German – Polish on each line, or just the Polish), not a table.",
    history: [],
    at: "2026-11-04T08:57:00Z",
    owner:
      "przetłumacz to na polski:\n1. Wie viel Wasser soll ich täglich trinken?\n2. Wie kann man einen Sixpack bekommen?\n3. Wie oft soll ich trainieren?\n4. Muss ich auf Süßigkeiten verzichten?\n5. Welches Training sollte ich wählen?\n6. Muss ich meine Ernährung umstellen?\n7. Wie kann ich effektiv abnehmen?\n8. Wo soll ich Sport machen: im Fitnessstudio oder zu Hause?",
    check: (o) => (/^\s*\|.*\|\s*$/m.test(said(o)) ? ["table"] : []),
  },
  {
    id: "sysadmin-graph",
    bot: "sysadmin",
    happened:
      'Asked for a graph of the packet loss, the bot sent a PNG, and the owner asked "why not as a native element". Earlier it had sent only numbers and a JSON file ("you didnt give me a graph?").',
    expect:
      "Shows the packet loss over the last 24 hours as a chart block in the chat (a fenced chart block, a line chart), from the log it just read or a fresh look at it. Not an image file, and not only numbers or a file.",
    history: [
      {
        at: "2026-10-20T21:17:00Z",
        owner: "now?",
        calls: [
          {
            name: "ssh_pct_exec",
            input: { host: "proxmox", guest: 124, command: "tail -n 60 /root/netlog/loss.csv" },
          },
        ],
        bot: "Loss is still high past the gateway: the last hour averaged **36%** to the ISP hop and **35%** to 1.1.1.1, with the gateway at **0%**.",
      },
    ],
    at: "2026-10-20T21:18:00Z",
    owner: "graph",
    tools: {
      ssh_pct_exec: (i) => (Number(i.guest) === 124 ? loss() : undefined),
      ssh_read_file: (i) => (/loss/.test(String(i.path)) ? loss() : undefined),
    },
    check: (o) => [
      ...(/```chart/.test(said(o)) ? [] : ["no chart block"]),
      ...(called(o, /^send_file$/).length ? ["sent a file"] : []),
    ],
  },
  {
    id: "researcher-not-tutor",
    bot: "researcher",
    happened:
      'The owner asked the Researcher whether AG-UI could be added to Hatbot. It handed the question to the Tutor, a school bot, because the Tutor has the Code plugin; the owner: "Why ask tutor lol".',
    expect:
      "Answers the question itself (what adding AG-UI to Hatbot would take and whether it's worth it), or asks Hatbot about how Hatbot works. It doesn't hand it to the Tutor: a question about whether something could be built isn't code work.",
    history: [
      {
        at: "2026-10-28T00:32:00Z",
        owner: "Whats ag ui",
        bot: "**AG-UI** (Agent–User Interaction Protocol) is an open protocol from CopilotKit for how an AI agent's backend talks to the app the user sees. The agent streams events (text, tool calls, state changes) over HTTP or WebSockets, and the front end renders them live.",
      },
    ],
    at: "2026-10-28T00:32:40Z",
    owner: "Could it be added to hatbot",
    check: (o) =>
      called(o, /^ask_bot$/).some((c) => /tutor/i.test(JSON.stringify(c.input)))
        ? ["asked the Tutor"]
        : [],
  },
];
