// Service worker mínimo: permite instalar la tarjeta como app y la abre aunque no haya cobertura.
// La página y los iconos se guardan; /api/state siempre va a la red (los sellos son en directo).
const CACHE = "parapapa-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-180.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Red primero (siempre la última versión); si no hay conexión, la copia guardada.
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(url.pathname === "/" || url.pathname === "/index.html" ? "/" : e.request, copy));
    return r;
  }).catch(() => caches.match(url.pathname === "/index.html" ? "/" : e.request, { ignoreSearch:true })));
});
