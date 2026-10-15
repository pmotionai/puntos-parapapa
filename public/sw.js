// Service worker mínimo: permite instalar la tarjeta como app y la abre aunque no haya cobertura.
// La página y los iconos se guardan; /api/state siempre va a la red (los sellos son en directo).
const CACHE = "parapapa-v3";

// Aviso push: llega vacío y aquí se pide el texto al servidor para este móvil
self.addEventListener("push", e => {
  e.waitUntil(self.registration.pushManager.getSubscription().then(sub =>
    fetch("/api/pushmsg", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ endpoint: sub && sub.endpoint }) })
      .then(r => r.json()).catch(() => ({ title:"Parapapa", body:"Tienes novedades en tu tarjeta ☕", url:"/#cliente" }))
  ).then(m => self.registration.showNotification(m.title || "Parapapa", {
    body:m.body, icon:"/icon-192.png", badge:"/icon-192.png", tag:"parapapa", renotify:true, vibrate:[60,40,60], data:{ url:m.url || "/#cliente" } })));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/#cliente";
  e.waitUntil(self.clients.matchAll({ type:"window", includeUncontrolled:true }).then(list => {
    const w = list.find(c => new URL(c.url).origin === location.origin);
    if (w){ w.navigate ? w.navigate(url).catch(()=>{}) : 0; return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
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
  e.respondWith(fetch(e.request, { cache:"no-store" }).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(url.pathname === "/" || url.pathname === "/index.html" ? "/" : e.request, copy));
    return r;
  }).catch(() => caches.match(url.pathname === "/index.html" ? "/" : e.request, { ignoreSearch:true })));
});
