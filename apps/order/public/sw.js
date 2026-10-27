/* Stello Kitchens — diner Scan & Order service worker.
 *
 * Hand-written (no workbox). At build time pwa-plugin.ts replaces the two
 * markers below with the build hash and the list of emitted files; in dev the
 * worker is never registered, so the placeholders are harmless.
 *
 * Strategy summary:
 *   - app shell (index.html + hashed /assets/*, icons, manifest): precached
 *   - navigations: network-first, fall back to the cached index.html (SPA)
 *   - /assets/*: cache-first (file names are content-hashed)
 *   - menu snapshot GET /api/v1/public/scan/{t,kiosk}/:token: network-first,
 *     cached copy served when offline
 *   - everything else under /api (orders, call-waiter, status polls, token
 *     board) and every non-GET request: straight to the network, never cached
 *   - Google Fonts: cache-first
 */
const VERSION = "__SW_VERSION__";
const PRECACHE = /* __PRECACHE_MANIFEST__ */ [];

const SHELL_CACHE = `stello-order-shell-${VERSION}`;
// Menu snapshots outlive deploys (the API shape is versioned separately).
const MENU_CACHE = "stello-order-menu-v1";
const FONT_CACHE = "stello-order-fonts-v1";
const KEEP = [SHELL_CACHE, MENU_CACHE, FONT_CACHE];

const MENU_RE = /^\/api\/v1\/public\/scan\/(t|kiosk)\/[^/]+$/;
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const urls = Array.from(new Set(["/index.html", ...PRECACHE]));
      // cache: "reload" so a stale HTTP cache can't poison the new shell.
      await cache.addAll(urls.map((u) => new Request(u, { cache: "reload" })));
      // The bundle is a single eagerly-loaded entry, so an open page never
      // needs a chunk from the old cache — safe to take over immediately.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("stello-order-") && !KEEP.includes(n))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // orders / call-waiter: network only

  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (FONT_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(navigation(req));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    // Only the menu snapshot is cached; status polls and the token board are live data.
    if (MENU_RE.test(url.pathname)) event.respondWith(networkFirst(req, MENU_CACHE));
    return;
  }

  if (url.pathname.startsWith("/assets/") || PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});

async function navigation(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const cached = await caches.match("/index.html", { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Opaque responses (no-cors font CSS) are fine to keep for fonts.
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}
