// Hatbot's service worker: keeps the app shell and its fingerprinted files (scripts, styles, fonts)
// so the app opens quickly and says plainly when Hatbot can't be reached. /api is never touched.
// v2: v1 could hold the app's page kept as a script (an older build's chunk, answered with the app).
const CACHE = "hatbot-v2";
const OFFLINE = "/offline.html";
// Old builds' files pile up in the cache; past this many, the oldest go.
const MAX_ENTRIES = 150;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keep = new Set([OFFLINE, "/"]);
  const keys = (await cache.keys()).filter((k) => !keep.has(new URL(k.url).pathname));
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(k);
}

/** Kept only when it's what was asked for: a page for "/", a script, style or font under /assets. */
const KINDS = {
  page: /^text\/html/,
  asset: /^(text\/css|text\/javascript|application\/javascript|font\/)/,
  any: /./,
};

async function put(req, res, kind) {
  if (!res.ok || res.type !== "basic") return;
  if (!KINDS[kind].test(res.headers.get("content-type") ?? "")) return;
  const cache = await caches.open(CACHE);
  await cache.put(req, res);
  await trim(cache);
}

/** The last app shell, which says it can't reach Hatbot and keeps trying; else the offline page. */
const offline = async () => (await caches.match("/")) ?? (await caches.match(OFFLINE));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Pages: the network first, so a deploy shows at once; then the last shell; then the offline page.
  // A 5xx is a proxy in front of a brain that's restarting, so it counts as offline too.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(async (res) => {
          if (res.status >= 500) return (await offline()) ?? res;
          e.waitUntil(put("/", res.clone(), "page"));
          return res;
        })
        .catch(offline),
    );
    return;
  }

  // Fingerprinted files never change: from the cache once there.
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            e.waitUntil(put(req, res.clone(), "asset"));
            return res;
          }),
      ),
    );
    return;
  }

  // Icons, the manifest, theme.js: the cached copy now, a fresh one for next time.
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req).then((res) => {
        e.waitUntil(put(req, res.clone(), "any"));
        return res;
      });
      if (!hit) return fresh;
      e.waitUntil(fresh.catch(() => {}));
      return hit;
    }),
  );
});
