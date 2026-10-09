/* Hatbot UI prototype — static, no build step. All data is fake.
   It demonstrates the layout, the components and the key flows: approval, takeover, teach mode,
   theme switching and the phone layout. Only the look and the flows are meant to carry over to apps/web. */

// ---------- Icons (Lucide-style paths) ----------
const ICONS = {
  hat: '<path d="M7 15.5V7c0-1.7 2.2-3 5-3s5 1.3 5 3v8.5"/><path d="M7 12.5c1.4.6 3.1 1 5 1s3.6-.4 5-1"/><path d="M2.5 16c1.4 2.1 5.2 3.5 9.5 3.5s8.1-1.4 9.5-3.5"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  tasks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  pointer: '<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  commit: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M7 16h10"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  record: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
};
const ic = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (sel) => document.querySelector(sel);

// ---------- State ----------
const state = {
  view: 'chat',
  inspTab: 'live',
  inspOpen: true,
  sheetOpen: false,
  selectedTask: 't1',
  approval: 'pending', // pending | approved | denied
  task: { stage: 'waiting', step: 14, cost: 0.31 }, // running | waiting | done | cancelled
  screen: 'form', // form | confirm
  takeover: false,
  teach: false,
  paused: false,
  theme: localStorage.getItem('hatbot-theme') || 'system',
  taskFilter: 'all',
  memFile: 'preferences.md',
  memDiff: null,
  spendMode: 'chart',
  extra: [], // messages appended during the session
  typing: false,
  draft: '',
};

// ---------- Fake data ----------
const TASKS = [
  { id: 't1', title: 'Book Bistro Lumen: Sat 19:30, 2 people', origin: 'Chat', lane: 'Screen', model: 'Opus 5.5', started: '10:31' },
  { id: 't2', title: 'Download October invoice from OVH', origin: 'Chat', lane: 'Screen', model: 'Opus 5.5', steps: 3, cost: 0.06, status: 'takeover', when: '10:12', started: '10:09', tainted: ['ovh.com (web page)'] },
  { id: 't3', title: 'Framework 16 stock check', origin: 'Schedule', lane: 'Screen', model: 'Opus 5.5', steps: 9, cost: 0.22, status: 'done', when: '08:01', started: '08:00', tainted: ['frame.work (web page)'] },
  { id: 't4', title: 'forgejo is down: investigate', origin: 'Alert · Uptime Kuma', lane: 'Background', model: 'Sonnet 5.5', steps: 7, cost: 0.04, status: 'resolved', when: '03:14', started: '03:12', tainted: [] },
  { id: 't5', title: 'Weekly homelab report', origin: 'Schedule', lane: 'Background', model: 'Sonnet 5.5', steps: null, cost: null, status: 'scheduled', when: 'Sun 18:00' },
  { id: 't6', title: 'Summarize review comments on scout PR #42', origin: 'Webhook · Forgejo', lane: 'Background', model: 'Sonnet 5.5', steps: 5, cost: 0.03, status: 'done', when: 'Yesterday', started: 'Yesterday 16:40', tainted: ['PR #42 comments (Forgejo)'] },
  { id: 't7', title: 'Post release notes to Mastodon', origin: 'Chat', lane: 'Screen', model: 'Opus 5.5', steps: 11, cost: 0.27, status: 'expired', when: 'Wed', started: 'Wed 14:02', tainted: ['mastodon.social (web page)'] },
];

function taskT1() {
  const s = state.task.stage;
  const status = s === 'waiting' ? 'approval' : s === 'running' ? 'running' : s === 'done' ? 'done' : 'cancelled';
  return { ...TASKS[0], steps: state.task.step, cost: state.task.cost, status, when: s === 'done' ? '10:44' : s === 'cancelled' ? '10:43' : 'now', tainted: ['bistrolumen.example (web page)'] };
}
const allTasks = () => [taskT1(), ...TASKS.slice(1)];
const needsYou = () => allTasks().filter((t) => t.status === 'approval' || t.status === 'takeover').length;

const STATUS = {
  running: ['brand', 'Running'],
  approval: ['attn', 'Needs approval'],
  takeover: ['attn', 'Needs you: login'],
  done: ['ok', 'Done'],
  resolved: ['ok', 'Resolved'],
  scheduled: ['', 'Scheduled'],
  cancelled: ['bad', 'Cancelled'],
  expired: ['bad', 'Approval expired'],
};
const statusChip = (s) => `<span class="chip ${STATUS[s][0]}">${STATUS[s][1]}</span>`;

const MEMORY = {
  'INDEX.md': `# Index
Always loaded. Keep it short.

- about-you.md: who you are, accounts, how to reach you
- preferences.md: how you like things done
- homelab.md: hosts, services, what "healthy" means, runbooks
- projects/: one note per project (scout, kurwov)
- skills/: reusable procedures (check-stock, book-restaurant)
- journal/2026-10.md: what happened this month`,
  'about-you.md': `# About you

- Forgejo: kubus on git.gaycats.ovh · GitHub: hkubus
- Mail is Proton (not connected in v1). No calendar.
- Reach you via ntfy; urgent = priority 4+.`,
  'preferences.md': `# Preferences

## Reports
- Morning reports: one line unless something changed.
- Bullet points, no greetings, no sign-offs.

## Bookings
- Default party size: 2. Prefer tables around 19:30.
- Ask before sharing a phone number with a new site.

## Homelab
- Safe restarts at night are fine; tell me in the morning.
- Never touch the PBS host without asking.`,
  'homelab.md': `# Homelab

## Hosts
- proxmox: 192.168.55.113 (i3-12100F, 16 GiB)
- t3code: CT 124, dev box
- forgejo: git.gaycats.ovh

## Monitors (Uptime Kuma)
- forgejo, scout, ntfy

## Runbooks
- forgejo OOM → restart forgejo.service, check memory limit.`,
  'projects/scout.md': `# scout

- Repo: git.gaycats.ovh/kubus/scout
- Reviews arrive via Forgejo webhook → summarize, don't comment.`,
  'skills/check-stock.md': `# Skill: check stock on a product page

Inputs: {url}, {variant}
1. Open {url} in Chromium.
2. Select {variant} if there's a picker.
3. Read the button: "Add to cart" = in stock, "Notify me" = out.
4. Report one line; screenshot only if in stock.`,
  'skills/book-restaurant.md': `# Skill: book a restaurant table (draft, from teach session)

Inputs: {site}, {date}, {time}, {party}
1. Open {site}/reserve.
2. Fill Date, Time, Guests; Name and Phone from about-you.md.
3. Ask for approval before "Confirm reservation".
4. Save the confirmation code to the journal.`,
  'journal/2026-10.md': `# October 2026

- 09 03:12 forgejo OOM → restarted, up 03:14.
- 09 08:01 Framework 16 still out of stock.`,
};
const COMMITS = [
  { sha: 'a41c9e2', who: 'Hatbot', msg: 'Shorten morning reports (from chat)', when: '09:12', file: 'preferences.md',
    diff: [['ctx', '## Reports'], ['del', '- Morning reports: full detail, every product.'], ['add', '- Morning reports: one line unless something changed.'], ['ctx', '- Bullet points, no greetings, no sign-offs.']] },
  { sha: '3b0f7d1', who: 'Hatbot', msg: 'Log forgejo OOM restart (alert task)', when: '03:15', file: 'journal/2026-10.md',
    diff: [['ctx', '# October 2026'], ['add', '- 09 03:12 forgejo OOM → restarted, up 03:14.']] },
  { sha: '77d0b13', who: 'You', msg: 'Add homelab hosts', when: 'Yesterday', file: 'homelab.md',
    diff: [['ctx', '## Hosts'], ['add', '- proxmox: 192.168.55.113 (i3-12100F, 16 GiB)'], ['add', '- t3code: CT 124, dev box']] },
  { sha: 'c90e4aa', who: 'Hatbot', msg: 'Create skill check-stock (teach session)', when: 'Tue', file: 'skills/check-stock.md',
    diff: [['add', '# Skill: check stock on a product page'], ['add', 'Inputs: {url}, {variant}']] },
];

// Daily spend: last 30 days (Sep 10 – Oct 9). Values are fake but internally consistent.
const DAILY = [0.42, 0.38, 1.10, 0.95, 0.20, 0.61, 1.45, 2.02, 0.88, 0.74, 1.31, 2.66, 1.05, 0.93, 7.86, 1.20, 0.97, 1.64, 2.10, 1.38, 1.02,
  1.84, 2.31, 0.96, 1.12, 3.40, 2.05, 1.77, 4.83, 3.12].map((v, i) => {
  const d = new Date(Date.UTC(2026, 8, 10 + i));
  return { date: d, v, tasks: Math.max(1, Math.round(v / 0.33)) };
});
const fmtDay = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtShort = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const money = (v) => `$${v.toFixed(2)}`;
const TODAY = 3.12, MONTH = 21.4;

// ---------- Fake desktop screen ----------
function screenHTML() {
  const confirm = state.screen === 'confirm';
  const cursorCls = state.takeover ? '' : state.task.stage === 'running' && !confirm ? 'run' : 'rest';
  const cursor = state.takeover || confirm ? '' :
    `<svg class="sx-cursor ${cursorCls}" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1 3.8 7-2.6 1.3-3.7-7.1L4 20z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  const form = `
    <h2>Reserve a table</h2>
    <div class="sx-fields">
      <div class="sx-f">Date<div>Sat, 10 October</div></div>
      <div class="sx-f">Time<div>19:30</div></div>
      <div class="sx-f">Guests<div>2</div></div>
      <div class="sx-f">Name<div>Kubus</div></div>
      <div class="sx-f full">Phone<div>+•• ••• ••• 214</div></div>
    </div>
    <div class="sx-btn ${state.task.stage === 'waiting' ? 'hover' : ''}">Confirm reservation</div>
    ${cursor}`;
  const ok = `
    <div class="sx-ok">
      <div class="tick">✓</div>
      <div class="big">You're booked.</div>
      <div class="det">Saturday 10 October · 19:30<br>Table for 2 · Bistro Lumen, Old Town</div>
      <div class="code">LM-4821</div>
      <div class="det" style="font-size:14px;color:#6b665d">A confirmation was sent by SMS.</div>
    </div>`;
  return `<div class="sx">
    <div class="sx-panel"><span>Applications</span><span>Places</span><span class="r">Fri 9 Oct&nbsp;&nbsp;10:4${confirm ? '4' : '2'}</span></div>
    <div class="sx-win">
      <div class="sx-tabs"><div class="sx-tab"><span class="sx-fav"></span>Bistro Lumen | ${confirm ? 'Booked' : 'Reserve'}</div></div>
      <div class="sx-bar"><span>←</span><span>→</span><span>↻</span><div class="sx-omni"><i></i>bistrolumen.example/${confirm ? 'reserve/done' : 'reserve'}</div></div>
      <div class="sx-page">
        <div class="sx-head"><span class="sx-logo">BISTRO LUMEN</span><span>Menu</span><span>Wine</span><span>Private dining</span><span>Reserve</span></div>
        <div class="sx-body">
          <div class="sx-card">${confirm ? ok : form}</div>
          <div class="sx-art"><div class="sx-menu"><b>Tonight</b>Roasted squash risotto · Hake, beurre blanc · Pear tarte fine</div></div>
        </div>
      </div>
    </div>
  </div>`;
}
const screenEl = (extraCls = '', overlay = '') =>
  `<div class="screen ${extraCls}"><div class="canvas">${screenHTML()}</div>${overlay}</div>`;

function fitScreens() {
  document.querySelectorAll('.screen').forEach((el) => {
    el.style.setProperty('--s', el.clientWidth / 1280);
  });
}
new ResizeObserver(fitScreens).observe(document.body);

// ---------- Sidebar ----------
const NAV = [
  ['chat', 'Chat', 'chat'],
  ['tasks', 'Tasks', 'tasks'],
  ['schedules', 'Schedules & Triggers', 'clock'],
  ['memory', 'Memory', 'book'],
  ['spend', 'Spend', 'gauge'],
  ['settings', 'Settings', 'sliders'],
];
function renderSidebar() {
  const n = needsYou();
  $('#sidebar').innerHTML = `
    <div class="brand">
      <div class="brand-mark">${ic('hat')}</div>
      <div class="brand-name">Hatbot</div>
    </div>
    <nav class="nav">
      ${NAV.map(([id, label, icon]) => `
        <button class="nav-item ${state.view === id ? 'active' : ''}" data-nav="${id}">${ic(icon)}<span>${label}</span>
          ${id === 'tasks' && n ? `<span class="count attn">${n}</span>` : ''}
        </button>`).join('')}
    </nav>`;
}

// ---------- Toolbar ----------
const TITLES = { chat: 'Chat', tasks: 'Tasks', schedules: 'Schedules & Triggers', memory: 'Memory', spend: 'Spend', settings: 'Settings', more: 'More' };
function renderToolbar() {
  const themeIcon = state.theme === 'light' ? 'sun' : state.theme === 'dark' ? 'moon' : 'auto';
  $('#toolbar').innerHTML = `
    <h1>${TITLES[state.view]}</h1>
    <span class="spacer"></span>
    <button class="tb-btn" data-action="cycle-theme" title="Theme: ${state.theme}">${ic(themeIcon)}</button>
    <button class="tb-btn ${state.paused ? 'on' : ''}" data-action="toggle-pause" title="${state.paused ? 'Resume' : 'Pause all'}">${ic(state.paused ? 'play' : 'pause')}<span class="hide-phone">${state.paused ? 'Resume' : 'Pause all'}</span></button>
    <button class="tb-btn hide-phone ${state.inspOpen ? 'on' : ''}" data-action="toggle-insp" title="Toggle inspector">${ic('panelRight')}</button>`;
}

// ---------- Chat ----------
function hatbotMsg(time, inner) {
  return `<div class="msg"><div class="body">${inner}</div>${time ? `<span class="time">${time}</span>` : ''}</div>`;
}
const userMsg = (time, text) => `<div class="msg user"><div class="bubble">${esc(text)}</div><span class="time">${time}</span></div>`;

function scheduleCard() {
  return `<div class="card"><div class="card-head"><div class="ico brand">${ic('clock')}</div>
    <div class="title">Framework 16 stock check</div>
    <div class="right"><button class="switch on" data-action="toggle-switch" aria-label="Enabled"></button></div></div>
    <div class="card-body"><dl class="kv"><dt>When</dt><dd>Every day at 08:00</dd><dt>Does</dt><dd>Checks the Framework 16 in the EU store</dd></dl></div></div>`;
}
function alertCard() {
  return `<div class="card"><div class="card-head"><div class="ico bad">${ic('alert')}</div>
    <div class="title">Forgejo was down</div>
    <div class="right">${statusChip('resolved')}</div></div>
    <div class="card-body"><ul class="steps">
      <li>${ic('check')}<span>Out of memory at 03:11</span></li>
      <li>${ic('check')}<span>Restarted <span class="mono">forgejo.service</span></span></li>
      <li>${ic('check')}<span>Back up at 03:14</span></li>
    </ul><p style="margin:0">It might need more than 1 GiB of memory.</p></div>
    <div class="card-foot"><span class="spacer"></span><button class="btn sm ghost" data-task="t4">Details ${ic('chevron')}</button></div></div>`;
}
function memoryCard() {
  const c = COMMITS[0];
  return `<div class="card"><div class="card-head"><div class="ico brand">${ic('commit')}</div>
    <div class="title">preferences.md</div>
    <div class="right"><button class="btn sm" data-action="revert" data-sha="${c.sha}">${ic('undo')}Revert</button></div></div>
    <div class="card-body"><div class="diff">${c.diff.map(([k, l]) => `<div class="${k}">${k === 'add' ? '+ ' : k === 'del' ? '- ' : '  '}${esc(l)}</div>`).join('')}</div></div></div>`;
}
function taskCard() {
  const t = taskT1();
  const s = state.task.stage;
  const prog = s === 'done' ? 'done' : s === 'waiting' ? 'wait' : s === 'cancelled' ? 'done' : '';
  const label = s === 'waiting' ? 'Waiting for your approval.'
    : s === 'running' ? (state.takeover ? 'Paused while you have control.' : 'Finishing the booking…')
    : s === 'done' ? 'Booked. Confirmation LM-4821.' : 'Cancelled. Nothing was submitted.';
  return `<div class="card task-card"><div class="card-head"><div class="ico brand">${ic('monitor')}</div>
    <div class="title" style="min-width:0">${t.title}</div>
    <div class="right">${statusChip(t.status)}</div></div>
    <div class="card-body"><div class="thumb-wrap">
      <div style="display:grid;gap:8px;align-content:start"><div style="font-size:12.5px">${label}</div>
      ${s === 'cancelled' ? '' : `<div class="progress ${prog}"></div>`}</div>
      <button data-action="open-live" style="border:0;padding:0;background:none" aria-label="Open live view">${screenEl()}</button>
    </div></div></div>`;
}
function approvalCard() {
  if (state.approval === 'approved') {
    return `<div class="resolved-line"><span class="chip ok">${ic('check')}Approved</span><span class="muted">Submit reservation</span></div>`;
  }
  if (state.approval === 'denied') {
    return `<div class="resolved-line"><span class="chip bad">${ic('x')}Denied</span><span class="muted">Submit reservation</span></div>`;
  }
  return `<div class="card attn"><div class="card-head"><div class="ico attn">${ic('shield')}</div>
    <div class="title" style="min-width:0">Submit reservation?</div></div>
    <div class="card-body"><p style="margin:0">Sends your name and phone number to bistrolumen.example.</p></div>
    <div class="card-foot"><button class="btn sm ghost" data-action="open-live">See screen</button><span class="spacer"></span>
      <button class="btn tint-danger" data-action="deny">Deny</button><button class="btn primary" data-action="approve">${ic('check')}Approve</button></div></div>`;
}

function chatItems() {
  return [
    '<div class="day">Yesterday</div>',
    userMsg('21:04', 'every morning at 8 check if the framework 16 is back in stock in the EU store and tell me'),
    hatbotMsg('21:04', `<p>Done. I'll check every morning at 08:00 and tell you in one line.</p>${scheduleCard()}`),
    '<div class="day">Today</div>',
    hatbotMsg('03:14', alertCard()),
    hatbotMsg('08:01', '<p>Framework 16 is still out of stock in the EU store. I\'ll check again tomorrow at 08:00.</p>'),
    userMsg('09:12', 'keep those stock reports to one line unless something changes'),
    hatbotMsg('09:12', `<p>Got it. I've updated your preferences.</p>${memoryCard()}`),
    userMsg('10:31', 'Book a table for 2 at Bistro Lumen tomorrow at 19:30, under my name'),
    hatbotMsg('10:31', `<p>On it.</p>${taskCard()}`),
    hatbotMsg('10:42', `${state.approval === 'pending' ? '<p>The form is filled in.</p>' : ''}${approvalCard()}`),
    ...state.extra,
    state.typing ? hatbotMsg('', '<div class="typing"><span></span><span></span><span></span></div>') : '',
  ].filter(Boolean);
}

// Only messages added after the first paint animate in; re-renders must not replay the whole thread.
let animFrom = Infinity;
function renderChat(scrollToEnd) {
  const view = $('#view');
  const items = chatItems();
  if (animFrom === Infinity) animFrom = items.length;
  view.innerHTML = `<div class="chat-scroll">
    ${state.paused ? `<div class="paused-banner">${ic('pause')}All activity is paused. Schedules and triggers will queue until you resume.<span style="flex:1"></span><button class="btn sm" data-action="toggle-pause">Resume</button></div>` : ''}
    <div class="thread">${items.map((h, i) => (i >= animFrom ? h.replace('class="msg', 'class="msg new') : h)).join('')}</div></div>`;
  animFrom = items.filter((h) => !h.includes('class="typing"')).length;
  if (scrollToEnd) view.scrollTop = view.scrollHeight;
}

function renderComposer() {
  const wrap = $('#composer-wrap');
  if (state.view !== 'chat') { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (wrap.dataset.ready) return;
  wrap.dataset.ready = '1';
  wrap.innerHTML = `
    <div class="composer">
      <button class="icon-btn" title="Attach">${ic('clip')}</button>
      <textarea id="draft" rows="1" placeholder="Message Hatbot…"></textarea>
      <button class="icon-btn send" id="send" title="Send" disabled>${ic('up')}</button>
    </div>`;
  const ta = $('#draft');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    $('#send').disabled = !ta.value.trim();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#send').addEventListener('click', send);
}

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function send() {
  const ta = $('#draft');
  const text = ta.value.trim();
  if (!text) return;
  ta.value = ''; ta.style.height = 'auto'; $('#send').disabled = true;
  state.extra.push(userMsg(nowTime(), text));
  state.typing = true;
  renderChat(true);
  setTimeout(() => {
    state.typing = false;
    state.extra.push(hatbotMsg(nowTime(), '<p>This is a prototype, so I can\'t act on that.</p>'));
    renderChat(true);
    fitScreens();
  }, 1100);
}

// ---------- Tasks ----------
function renderTasks() {
  const filters = [['all', 'All'], ['active', 'Running'], ['you', 'Needs you'], ['scheduled', 'Scheduled'], ['done', 'Done']];
  const match = {
    all: () => true,
    active: (t) => t.status === 'running',
    you: (t) => t.status === 'approval' || t.status === 'takeover',
    scheduled: (t) => t.status === 'scheduled',
    done: (t) => ['done', 'resolved', 'cancelled', 'expired'].includes(t.status),
  }[state.taskFilter];
  const rows = allTasks().filter(match);
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><div class="seg">${filters.map(([id, l]) => `<button class="${state.taskFilter === id ? 'active' : ''}" data-filter="${id}">${l}</button>`).join('')}</div>
</div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Task</th><th class="hide-phone-col">Lane</th><th class="hide-phone-col">Model</th><th class="num hide-phone-col">Steps</th><th class="num">Cost</th><th>Status</th><th class="hide-phone-col">When</th></tr></thead>
      <tbody>${rows.map((t) => `
        <tr data-task="${t.id}" class="${state.selectedTask === t.id ? 'sel' : ''}">
          <td class="wrap"><div class="task-title">${t.lane === 'Screen' ? ic('monitor') : ic('server')}${esc(t.title)}</div></td>
          <td class="hide-phone-col">${t.lane}</td><td class="hide-phone-col">${t.model}</td>
          <td class="num hide-phone-col">${t.steps ?? '–'}</td><td class="num">${t.cost != null ? money(t.cost) : '–'}</td>
          <td>${statusChip(t.status)}</td><td class="hide-phone-col muted">${t.when}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">Nothing here.</td></tr>'}
      </tbody></table></div></div>`;
}

// ---------- Schedules & triggers ----------
function renderSchedules() {
  const row = (icon, cls, title, sub, val, on) => `<div class="row"><div class="ico ${cls}">${ic(icon)}</div>
    <div class="txt"><b>${title}</b><span>${sub}</span></div><div class="val hide-phone">${val}</div>
    <button class="switch ${on ? 'on' : ''}" data-action="toggle-switch" aria-label="Enabled"></button>${ic('chevron', 'chev')}</div>`;
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><span class="spacer"></span><button class="btn">${ic('plus')}New</button></div>
    <section class="group"><h2>Schedules</h2><div class="group-box">
      ${row('clock', '', 'Framework 16 stock check', 'Every day at 08:00', 'Next: tomorrow 08:00', true)}
      ${row('clock', '', 'Weekly homelab report', 'Sundays at 18:00', 'Next: Sun 18:00', true)}
      ${row('clock', '', 'Certificate expiry check', '1st of the month at 09:00', 'Paused', false)}
    </div></section>
    <section class="group"><h2>Triggers</h2><div class="group-box">
      ${row('bell', 'attn', 'Uptime Kuma alerts', 'Webhook', 'Last: today 03:12', true)}
      ${row('zap', 'gray', 'Forgejo: scout PR reviews', 'Signed webhook', 'Last: yesterday', true)}
    </div></section>
    <section class="group"><h2>Webhook URL</h2><div class="group-box"><div class="row"><div class="ico gray">${ic('globe')}</div><div class="txt"><b class="mono">https://hatbot.gaycats.ovh/api/v1/hooks/…</b></div></div></div></section>
  </div>`;
}

// ---------- Memory ----------
function renderMemory() {
  const files = Object.keys(MEMORY);
  const groups = {};
  files.forEach((f) => { const g = f.includes('/') ? f.split('/')[0] : ''; (groups[g] ||= []).push(f); });
  const tree = Object.entries(groups).map(([g, fs]) => `${g ? `<div class="folder">${ic('folder')}${g}/</div>` : ''}
    ${fs.map((f) => `<button class="${state.memFile === f && !state.memDiff ? 'active' : ''}" data-file="${f}">${ic('file')}${f.split('/').pop()}${f === 'skills/book-restaurant.md' ? '<span class="badge" title="Draft"></span>' : ''}</button>`).join('')}`).join('');
  const diff = state.memDiff && COMMITS.find((c) => c.sha === state.memDiff);
  const content = diff
    ? `<div style="padding:16px 20px"><div class="diff">${diff.diff.map(([k, l]) => `<div class="${k}">${k === 'add' ? '+ ' : k === 'del' ? '- ' : '  '}${esc(l)}</div>`).join('')}</div></div>`
    : `<pre class="editor-text" contenteditable="true" spellcheck="false">${esc(MEMORY[state.memFile]).replace(/^(#+ .*)$/gm, '<span class="h">$1</span>')}</pre>`;
  $('#view').innerHTML = `<div class="memory">
    <div class="tree">${tree}</div>
    <div class="editor">
      <div class="editor-bar">${diff
        ? `<span class="path">${diff.sha}</span><span class="muted">${diff.who} · ${esc(diff.msg)} · ${diff.file}</span><span class="spacer"></span><button class="btn sm" data-action="close-diff">Back to file</button><button class="btn sm" data-action="revert" data-sha="${diff.sha}">${ic('undo')}Revert</button>`
        : `<span class="path">${state.memFile}</span><span class="spacer"></span><button class="btn sm accent" data-action="save-mem">Save</button>`}</div>
      ${content}
      <div class="history"><h3 class="section-title">History</h3>
        ${COMMITS.map((c) => `<div class="commit"><span class="sha">${c.sha}</span><div><div>${esc(c.msg)}</div><div class="who">${c.who} · ${c.file} · ${c.when}</div></div>
          <div style="display:flex;gap:4px"><button class="btn sm ghost" data-diff="${c.sha}">Diff</button><button class="btn sm ghost" data-action="revert" data-sha="${c.sha}">Revert</button></div></div>`).join('')}
      </div>
    </div></div>`;
}

// ---------- Spend ----------
function spendChart() {
  const W = 720, H = 230, L = 40, R = 8, T = 14, B = 26, max = 10;
  const pw = W - L - R, ph = H - T - B, band = pw / DAILY.length, bw = Math.min(16, band - 4);
  const y = (v) => T + ph - (v / max) * ph;
  const ticks = [0, 2, 4, 6, 8, 10];
  const peak = DAILY.reduce((a, d, i) => (d.v > DAILY[a].v ? i : a), 0);
  const bars = DAILY.map((d, i) => {
    const x = L + i * band + (band - bw) / 2, top = y(d.v), h = T + ph - top, r = Math.min(4, h);
    const path = `M${x},${T + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${T + ph} Z`;
    return `<rect class="hit" x="${L + i * band}" y="${T}" width="${band}" height="${ph}" data-i="${i}"/><path class="bar" d="${path}"/>`;
  }).join('');
  const labelAt = (i) => `<text x="${L + i * band + band / 2}" y="${y(DAILY[i].v) - 6}" text-anchor="middle" style="fill:var(--text-2);font-weight:600">${money(DAILY[i].v)}</text>`;
  const xLabels = [0, 7, 14, 21, 28].map((i) => `<text x="${L + i * band + band / 2}" y="${H - 6}" text-anchor="middle">${fmtShort(DAILY[i].date)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily spend, last 30 days">
    ${ticks.map((t) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">$${t}</text>`).join('')}
    <line class="refline" x1="${L}" x2="${W - R}" y1="${y(10)}" y2="${y(10)}"/>
    <text x="${W - R}" y="${y(10) - 5}" text-anchor="end" style="fill:var(--text-2)">Daily limit $10</text>
    ${bars}${labelAt(peak)}${labelAt(DAILY.length - 1)}${xLabels}
  </svg><div class="tooltip" id="tip"></div>`;
}
function renderSpend() {
  const models = [['Opus 5.5', 13.9], ['Sonnet 5.5', 6.65], ['Haiku 5.5', 0.85]];
  const mMax = Math.max(...models.map((m) => m[1]));
  $('#view').innerHTML = `<div class="page">
    <div class="kpis">
      <div class="tile"><div class="label">Today</div><div class="value tnum">${money(TODAY)} <small>of $10</small></div><div class="meter"><span style="width:${TODAY * 10}%"></span></div></div>
      <div class="tile"><div class="label">This month</div><div class="value tnum">${money(MONTH)} <small>of $200</small></div><div class="meter"><span style="width:${(MONTH / 200) * 100}%"></span></div></div>
      <div class="tile"><div class="label">Average per task</div><div class="value tnum">$0.33</div></div>
      <div class="tile"><div class="label">Tasks this month</div><div class="value tnum">64</div></div>
    </div>
    <div class="chart-card">
      <div class="chart-head"><h3>Last 30 days</h3><span class="spacer"></span>
        <div class="seg"><button class="${state.spendMode === 'chart' ? 'active' : ''}" data-spend="chart">Chart</button><button class="${state.spendMode === 'table' ? 'active' : ''}" data-spend="table">Table</button></div></div>
      ${state.spendMode === 'chart' ? `<div class="chart" id="chart">${spendChart()}</div>` : `<div style="max-height:260px;overflow:auto"><table class="table"><thead><tr><th>Day</th><th class="num">Spend</th><th class="num">Tasks</th></tr></thead><tbody>
        ${[...DAILY].reverse().map((d) => `<tr><td>${fmtDay(d.date)}</td><td class="num">${money(d.v)}</td><td class="num">${d.tasks}</td></tr>`).join('')}</tbody></table></div>`}
    </div>
    <div class="chart-card">
      <div class="chart-head"><h3>By model</h3></div>
      <div class="hbars">${models.map(([n, v]) => `<div class="hbar"><span>${n}</span><div class="track"><div class="fill" style="width:${(v / mMax) * 100}%"></div></div><span class="v">${money(v)}</span></div>`).join('')}</div>
    </div>
  </div>`;
  const chart = $('#chart');
  if (!chart) return;
  const tip = $('#tip');
  chart.addEventListener('mousemove', (e) => {
    const hit = e.target.closest('.hit');
    chart.querySelectorAll('.bar.hl').forEach((b) => b.classList.remove('hl'));
    if (!hit) { tip.classList.remove('show'); return; }
    const d = DAILY[+hit.dataset.i];
    hit.nextElementSibling.classList.add('hl');
    const box = chart.getBoundingClientRect(), hb = hit.getBoundingClientRect();
    tip.innerHTML = `<b>${fmtDay(d.date)}</b>${money(d.v)} · ${d.tasks} task${d.tasks === 1 ? '' : 's'}`;
    tip.style.left = `${hb.left - box.left + hb.width / 2}px`;
    tip.style.top = `${hb.top - box.top + (hb.height * (1 - d.v / 10))}px`;
    tip.classList.add('show');
  });
  chart.addEventListener('mouseleave', () => { tip.classList.remove('show'); chart.querySelectorAll('.bar.hl').forEach((b) => b.classList.remove('hl')); });
}

// ---------- Settings ----------
function renderSettings() {
  const sel = (opts, v) => `<select>${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  $('#view').innerHTML = `<div class="page">
    <section class="group"><h2>Appearance</h2><div class="group-box">
      <div class="row"><div class="txt"><b>Theme</b></div>
        <div class="seg">${['system', 'light', 'dark'].map((t) => `<button class="${state.theme === t ? 'active' : ''}" data-theme-set="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
    </div></section>
    <section class="group"><h2>Account</h2><div class="group-box">
      <div class="row"><div class="txt"><b>Password</b></div><button class="btn sm">Change…</button></div>
      <div class="row"><div class="txt"><b>Two-factor (TOTP)</b></div><span class="chip ok">On</span></div>
      <div class="row"><div class="txt"><b>API tokens</b></div><span class="val">1 token</span>${ic('chevron', 'chev')}</div>
      <div class="row"><div class="txt"><b>Sign out</b></div><button class="btn sm" data-action="logout">Sign out</button></div>
    </div></section>
    <section class="group"><h2>Notifications</h2><div class="group-box">
      <div class="row"><div class="txt"><b>Server</b></div><input type="text" value="https://ntfy.gaycats.ovh" style="width:210px"></div>
      <div class="row"><div class="txt"><b>Approve from notification</b></div><button class="switch on" data-action="toggle-switch"></button></div>
      <div class="row"><div class="txt"><b>Test notification</b></div><button class="btn sm" data-action="test-ntfy">Send test</button></div>
    </div></section>
    <section class="group"><h2>Spending limits</h2><div class="group-box">
      <div class="row"><div class="txt"><b>Per day</b></div>$<input type="number" value="10"></div>
      <div class="row"><div class="txt"><b>Per month</b></div>$<input type="number" value="200"></div>
      <div class="row"><div class="txt"><b>Per task</b></div>$<input type="number" value="3"></div>
    </div></section>
    <section class="group"><h2>Models</h2><div class="group-box">
      <div class="row"><div class="txt"><b>Brain</b></div>${sel(['Sonnet 5.5', 'Opus 5.5'], 'Sonnet 5.5')}</div>
      <div class="row"><div class="txt"><b>Desktop driver</b></div>${sel(['Opus 5.5', 'Sonnet 5.5'], 'Opus 5.5')}</div>
      <div class="row"><div class="txt"><b>Screening & summaries</b></div>${sel(['Haiku 5.5'], 'Haiku 5.5')}</div>
    </div></section>
    <section class="group"><h2>Desktop</h2><div class="group-box">
      <div class="row"><div class="txt"><b>hatbot-desktop</b></div><span class="chip ok">Online</span></div>
      <div class="row"><div class="txt"><b>Snapshots</b></div><button class="btn sm danger-text" data-action="rollback">Roll back…</button></div>
    </div></section>
    <section class="group"><h2>Safety</h2><div class="group-box">
      <div class="row"><div class="txt"><b>Untrusted-content rule</b></div><span class="chip ok">On</span></div>
      <div class="row"><div class="txt"><b>Approval timeout</b></div>${sel(['24 hours', '12 hours', '48 hours'], '24 hours')}</div>
      <div class="row"><div class="txt"><b>Pause all activity</b></div><button class="btn sm danger" data-action="toggle-pause">${state.paused ? 'Resume' : 'Pause all'}</button></div>
    </div></section>
  </div>`;
}

// ---------- More (phone) ----------
function renderMore() {
  const item = (id, label, icon, sub) => `<div class="row" data-nav="${id}" style="cursor:pointer"><div class="ico">${ic(icon)}</div><div class="txt"><b>${label}</b></div>${ic('chevron', 'chev')}</div>`;
  $('#view').innerHTML = `<div class="page"><div class="group-box">
    ${item('schedules', 'Schedules & Triggers', 'clock', '3 schedules · 2 triggers')}
    ${item('spend', 'Spend', 'gauge', `${money(TODAY)} today · ${money(MONTH)} this month`)}
    ${item('settings', 'Settings', 'sliders', 'Theme, ntfy, limits, models')}
  </div></div>`;
}

// ---------- Inspector ----------
function renderLive() {
  const s = state.task.stage;
  const banner = state.teach
    ? `<div class="control-banner rec"><span class="rec-dot"></span>Recording. Show Hatbot how it's done.<span class="spacer"></span><button class="btn sm danger" data-action="stop-teach">Stop & create skill</button></div>`
    : state.takeover
      ? `<div class="control-banner attn">${ic('hand')}You're in control. Hatbot is paused.<span class="spacer"></span><button class="btn sm primary" data-action="handback">Hand back</button></div>`
      : '';
  const nowLabel = s === 'waiting' ? `${ic('shield')}Step 14: waiting for approval to click “Confirm reservation”`
    : s === 'running' ? `${ic('pointer')}Step ${state.task.step}: submitting the reservation`
    : s === 'done' ? `${ic('check')}Done: booking confirmed (LM-4821)` : `${ic('x')}Cancelled. Nothing was submitted.`;
  const log = [
    ['10:42', 'shield', 'Asked for approval: Confirm reservation', 'attn'],
    ['10:41', 'keyboard', 'Typed phone number from about-you.md'],
    ['10:41', 'keyboard', 'Typed “Kubus” in Name'],
    ['10:40', 'pointer', 'Selected 2 guests'],
    ['10:40', 'pointer', 'Picked 19:30 from time list'],
    ['10:39', 'camera', 'Screenshot: reservation form'],
  ];
  if (s === 'done') log.unshift(['10:44', 'check', 'Read confirmation code LM-4821'], ['10:43', 'pointer', 'Clicked Confirm reservation']);
  if (s === 'cancelled') log.unshift(['10:43', 'x', 'You denied the action; task cancelled']);
  return `${banner}
    ${screenEl(state.teach ? 'recording' : state.takeover ? 'control' : '')}
    <div class="live-controls">
      ${state.takeover ? '' : `<button class="btn tint-attn" data-action="takeover">${ic('hand')}Take over</button>`}
      ${state.teach ? '' : `<button class="btn" data-action="teach">${ic('record')}Teach</button>`}
      <button class="btn ghost" data-action="screenshot">${ic('camera')}Snapshot</button>
    </div>
    <div class="panel now"><h3 class="section-title">Now</h3><div class="label">${nowLabel}</div>
      <div class="progress ${s === 'done' || s === 'cancelled' ? 'done' : s === 'waiting' ? 'wait' : ''}"></div></div>
    <div class="panel"><h3 class="section-title">Recent steps</h3><ul class="log">
      ${log.map(([t, i, txt, cls]) => `<li class="${cls || ''}"><span class="t">${t}</span>${ic(i)}<span>${txt}</span></li>`).join('')}
    </ul></div>`;
}
function renderDetails() {
  const t = allTasks().find((x) => x.id === state.selectedTask) || allTasks()[0];
  const pct = t.cost != null ? Math.min(100, (t.cost / 3) * 100) : 0;
  const ask = t.status === 'takeover'
    ? `<div class="control-banner ask">${ic('hand')}<div><b>Hatbot needs you:</b> log in to ovh.com (2FA). It'll continue once you hand back.</div><span class="spacer"></span><button class="btn sm primary" data-action="takeover">Take over</button></div>` : '';
  const steps = t.steps
    ? Array.from({ length: Math.min(t.steps, 6) }, (_, i) => `<div class="tl-step"><div class="tl-thumb ${t.lane === 'Screen' ? '' : 'none'}"></div><div><div>${t.lane === 'Screen' ? ['Opened page', 'Screenshot', 'Clicked field', 'Typed value', 'Scrolled', 'Checked result'][i] : ['Read Kuma payload', 'proxmox_status(forgejo)', 'ssh_exec journalctl', 'Matched runbook', 'ssh_exec systemctl restart', 'Verified HTTP 200'][i]}</div></div>`).join('')
    : '<div class="muted">Hasn\'t run yet.</div>';
  return `${ask}<div class="panel">
    <div style="display:flex;gap:8px;align-items:flex-start"><div style="font-weight:600;font-size:14px;flex:1">${esc(t.title)}</div>${statusChip(t.status)}</div>
    <dl class="kv"><dt>Origin</dt><dd>${t.origin}</dd><dt>Lane</dt><dd>${t.lane}</dd><dt>Model</dt><dd>${t.model}</dd><dt>Started</dt><dd>${t.started || '–'}</dd><dt>Steps</dt><dd>${t.steps ?? '–'}</dd>
      <dt>Trust</dt><dd>${t.tainted && t.tainted.length ? t.tainted.map((s) => `<span class="chip warn">${ic('globe')}${esc(s)}</span>`).join(' ') : '<span class="chip ok">Trusted sources only</span>'}</dd></dl>
    ${t.cost != null ? `<div class="mini-meter"><div class="top"><span>Cost</span><span class="tnum">${money(t.cost)} of $3.00</span></div><div class="meter"><span style="width:${pct}%"></span></div></div>` : ''}
  </div>
  <div class="panel"><h3 class="section-title">Timeline</h3><div class="timeline">${steps}</div></div>
  <div style="display:flex;gap:6px"><button class="btn sm">${ic('expand')}Full transcript</button>${['running', 'approval', 'takeover'].includes(t.status) ? '<button class="btn sm danger-text">Cancel task</button>' : ''}</div>`;
}
function renderInspector() {
  $('#inspector').innerHTML = `<div class="grabber"></div>
    <div class="insp-head"><div class="seg"><button class="${state.inspTab === 'live' ? 'active' : ''}" data-tab="live">Live</button><button class="${state.inspTab === 'details' ? 'active' : ''}" data-tab="details">Details</button></div>
      <span class="spacer"></span><button class="tb-btn" data-action="close-insp" title="Close">${ic('x')}</button></div>
    <div class="insp-body">${state.inspTab === 'live' ? renderLive() : renderDetails()}</div>`;
}

// ---------- Tab bar (phone) ----------
function renderTabbar() {
  const n = needsYou();
  const tabs = [['chat', 'Chat', 'chat'], ['tasks', 'Tasks', 'tasks'], ['live', 'Live', 'monitor'], ['memory', 'Memory', 'book'], ['more', 'More', 'more']];
  const active = (id) => (id === 'live' ? state.sheetOpen : !state.sheetOpen && (state.view === id || (id === 'more' && ['more', 'schedules', 'spend', 'settings'].includes(state.view))));
  $('#tabbar').innerHTML = tabs.map(([id, l, i]) => `<button class="${active(id) ? 'active' : ''}" data-tabbar="${id}">${ic(i)}${l}${id === 'tasks' && n ? `<span class="badge">${n}</span>` : ''}</button>`).join('');
}

// ---------- Login ----------
function renderLogin() {
  $('#login').innerHTML = `<div class="login-card">
    <div class="brand-mark">${ic('hat')}</div><h2>Hatbot</h2>
    <input class="field" type="password" placeholder="Password" value="••••••••••">
    <div class="muted" style="font-size:12px">Code from your authenticator</div>
    <div class="otp">${Array.from({ length: 6 }, () => '<input inputmode="numeric" maxlength="1">').join('')}</div>
    <button class="btn accent" data-action="login">Sign in</button></div>`;
  const inputs = [...document.querySelectorAll('.otp input')];
  inputs.forEach((inp, i) => inp.addEventListener('input', () => { if (inp.value && inputs[i + 1]) inputs[i + 1].focus(); }));
}

// ---------- Render ----------
let lastView = null;
function render(opts = {}) {
  document.documentElement.dataset.theme = state.theme;
  const app = $('#app');
  app.classList.toggle('insp-collapsed', !state.inspOpen);
  app.classList.toggle('sheet-open', state.sheetOpen);
  const view = $('#view');
  const keep = lastView === state.view ? view.scrollTop : 0;
  renderSidebar(); renderToolbar(); renderTabbar(); renderInspector(); renderComposer();
  ({ chat: () => renderChat(opts.scrollEnd), tasks: renderTasks, schedules: renderSchedules, memory: renderMemory, spend: renderSpend, settings: renderSettings, more: renderMore })[state.view]();
  if (!opts.scrollEnd) view.scrollTop = lastView === state.view ? keep : state.view === 'chat' ? view.scrollHeight : 0;
  lastView = state.view;
  requestAnimationFrame(fitScreens);
}

function toast(text, icon = 'check') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${ic(icon)}${text}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 2800);
}
const isPhone = () => window.matchMedia('(max-width: 899px)').matches;
function openInspector(tab) {
  state.inspTab = tab;
  if (isPhone()) state.sheetOpen = true; else state.inspOpen = true;
}

// ---------- Flows ----------
function approve() {
  state.approval = 'approved';
  state.task.stage = 'running';
  state.task.step = 15;
  toast('Approved. Hatbot is continuing.');
  render();
  setTimeout(() => { state.task.step = 16; state.task.cost = 0.35; render(); }, 1200);
  setTimeout(() => {
    state.task = { stage: 'done', step: 17, cost: 0.38 };
    state.screen = 'confirm';
    state.extra.push(hatbotMsg('10:44', '<p>Booked: <b>Saturday 10 October, 19:30, table for 2</b> at Bistro Lumen. Confirmation <span class="mono">LM-4821</span>. I noted it in <span class="mono">journal/2026-10.md</span>.</p>'));
    render({ scrollEnd: state.view === 'chat' });
  }, 2600);
}
function deny() {
  state.approval = 'denied';
  state.task.stage = 'cancelled';
  state.extra.push(hatbotMsg('10:43', '<p>Okay, I didn\'t submit it. The form is still filled in on the desktop if you want to finish it yourself: open the live view and hit <b>Take over</b>.</p>'));
  render({ scrollEnd: state.view === 'chat' });
}

// ---------- Events ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-nav],[data-action],[data-tab],[data-task],[data-filter],[data-file],[data-diff],[data-spend],[data-theme-set],[data-tabbar]');
  if (!t) return;
  const d = t.dataset;
  if (d.nav) { state.view = d.nav; state.memDiff = null; state.sheetOpen = false; return render(); }
  if (d.tabbar) {
    if (d.tabbar === 'live') { state.inspTab = 'live'; state.sheetOpen = true; return render(); }
    state.view = d.tabbar; state.sheetOpen = false; return render();
  }
  if (d.tab) { state.inspTab = d.tab; return render(); }
  if (d.task) { state.selectedTask = d.task; openInspector('details'); return render(); }
  if (d.filter) { state.taskFilter = d.filter; return render(); }
  if (d.file) { state.memFile = d.file; state.memDiff = null; return render(); }
  if (d.diff) { state.memDiff = d.diff; return render(); }
  if (d.spend) { state.spendMode = d.spend; return render(); }
  if (d.themeSet) { state.theme = d.themeSet; localStorage.setItem('hatbot-theme', state.theme); return render(); }
  switch (d.action) {
    case 'approve': return approve();
    case 'deny': return deny();
    case 'open-live': openInspector('live'); return render();
    case 'toggle-insp': state.inspOpen = !state.inspOpen; return render();
    case 'close-insp': state.inspOpen = false; state.sheetOpen = false; return render();
    case 'close-sheet': state.sheetOpen = false; return render();
    case 'cycle-theme': {
      const order = ['system', 'light', 'dark'];
      state.theme = order[(order.indexOf(state.theme) + 1) % 3];
      localStorage.setItem('hatbot-theme', state.theme);
      toast(`Theme: ${state.theme}`, state.theme === 'dark' ? 'moon' : 'sun');
      return render();
    }
    case 'toggle-pause':
      state.paused = !state.paused;
      toast(state.paused ? 'All activity paused' : 'Resumed', state.paused ? 'pause' : 'play');
      return render();
    case 'takeover': state.takeover = true; openInspector('live'); toast('You have control. Hatbot is paused.', 'hand'); return render();
    case 'handback': state.takeover = false; state.teach = false; toast('Handed back to Hatbot'); return render();
    case 'teach': state.takeover = true; state.teach = true; openInspector('live'); return render();
    case 'stop-teach':
      state.teach = false; state.takeover = false; state.memFile = 'skills/book-restaurant.md';
      toast('Draft skill ready for review: skills/book-restaurant.md', 'file');
      return render();
    case 'screenshot': return toast('Snapshot saved to the task timeline', 'camera');
    case 'toggle-switch': t.classList.toggle('on'); return;
    case 'revert': return toast(`Reverted ${d.sha}. New commit 5e2b8f0`, 'undo');
    case 'close-diff': state.memDiff = null; return render();
    case 'save-mem': return toast('Saved. Committed as you (e7a1c03)', 'commit');
    case 'test-ntfy': return toast('Test notification sent', 'bell');
    case 'rollback': return toast('Prototype: this would confirm, then roll back to a snapshot', 'undo');
    case 'logout': renderLogin(); $('#login').hidden = false; return;
    case 'login': $('#login').hidden = true; return toast('Signed in');
  }
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
window.matchMedia('(max-width: 899px)').addEventListener('change', () => { state.sheetOpen = false; render(); });

render();
