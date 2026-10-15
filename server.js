// Servidor de la demo de puntos de Parapapa: sirve la página y guarda un único estado compartido
// (tarjeta de la clienta de ejemplo + solicitudes de sello) para que el móvil del cliente y el del negocio se vean en directo.
// Notificaciones push (Web Push con VAPID, sin librerías): el push va vacío y el service worker pide el texto a /api/pushmsg.
// Claves en variables de entorno: VAPID_PUBLIC (punto público sin comprimir, base64url) y VAPID_PRIVATE (d, base64url).
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 10002;
const PUB = path.join(__dirname, "public");
let state = null, ver = 0;
// Versión publicada: cambia en cada deploy. La tarjeta la consulta al abrirse y se actualiza sola si hay una nueva.
const BUILD = process.env.RENDER_GIT_COMMIT || String(fs.statSync(path.join(PUB, "index.html")).mtimeMs);

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req, cb) => { let b = ""; req.on("data", c => { b += c; if (b.length > 2e5) req.destroy(); }); req.on("end", () => { try { cb(JSON.parse(b || "{}")); } catch (e) { cb(null); } }); };

/* ---------- Web Push ---------- */
const VPUB = process.env.VAPID_PUBLIC || "", VPRIV = process.env.VAPID_PRIVATE || "";
let vKey = null;
if (VPUB && VPRIV){
  const raw = Buffer.from(VPUB, "base64url");
  vKey = crypto.createPrivateKey({ format:"jwk", key:{ kty:"EC", crv:"P-256", d:VPRIV,
    x:raw.subarray(1, 33).toString("base64url"), y:raw.subarray(33, 65).toString("base64url") } });
}
const subs = new Map();   // endpoint → { sub, role:"cliente"|"negocio", msg }
function vapidJWT(aud){
  const h = Buffer.from(JSON.stringify({ typ:"JWT", alg:"ES256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ aud, exp:Math.floor(Date.now()/1000) + 12*3600, sub:"mailto:contacto@pmotionia.com" })).toString("base64url");
  const sig = crypto.sign("sha256", Buffer.from(h + "." + p), { key:vKey, dsaEncoding:"ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${sig}`;
}
function push(endpoint){
  if (!vKey) return;
  const u = new URL(endpoint);
  const req = https.request(u, { method:"POST", headers:{ TTL:"3600", Urgency:"high", "Content-Length":0,
    Authorization:`vapid t=${vapidJWT(u.origin)}, k=${VPUB}` } }, res => {
    console.log("push", u.host, res.statusCode);
    if (res.statusCode === 404 || res.statusCode === 410) subs.delete(endpoint);   // el móvil ya no acepta avisos
    res.resume();
  });
  req.on("error", e => console.log("push error", u.host, e.message)); req.end();
}
function notify(role, msg){ for (const [ep, s] of subs) if (s.role === role){ s.msg = msg; push(ep); } }
// Compara el estado nuevo con el anterior: aviso nuevo → clientes; solicitud nueva → negocio
function onNewState(prev, next){
  const pa = new Set(((prev && prev.avisos) || []).map(a => a.id)), pr = new Set(((prev && prev.reqs) || []).map(r => r.id));
  const avs = (next.avisos || []).filter(a => !pa.has(a.id));
  if (prev && avs.length) { const m = avs[avs.length-1].m; notify("cliente", { title:/sello|café gratis|Tarjeta completa/i.test(m) ? "Tu tarjeta de cafés" : "Novedad de Parapapa", body:m, url:"/#cliente" }); }
  const rqs = (next.reqs || []).filter(r => r.status === "pendiente" && !pr.has(r.id));
  if (prev && rqs.length) notify("negocio", { title:"Nueva solicitud de sello", body:`☕ ${rqs[0].name} pide un sello. Toca para aceptarlo.`, url:"/#negocio" });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/state"){
    if (req.method === "GET") return send(res, 200, { ver, state });
    if (req.method === "PUT") return readBody(req, b => { if (!b) return send(res, 400, { error:"json" }); const prev = state; state = b; ver++; onNewState(prev, b); send(res, 200, { ver }); });
    return send(res, 405, { error: "method" });
  }
  if (url.pathname === "/api/version") return send(res, 200, BUILD, "text/plain");
  if (url.pathname === "/api/vapid") return vKey ? send(res, 200, VPUB, "text/plain") : send(res, 503, "sin claves", "text/plain");
  if (url.pathname === "/api/subscribe" && req.method === "POST") return readBody(req, b => {
    if (!b || !b.sub || !b.sub.endpoint || !/^https:\/\//.test(b.sub.endpoint)) return send(res, 400, { error:"sub" });
    const old = subs.get(b.sub.endpoint);
    subs.set(b.sub.endpoint, { sub:b.sub, role:b.role === "negocio" ? "negocio" : "cliente", msg:old ? old.msg : null });
    console.log("subscribe", b.role, new URL(b.sub.endpoint).host, "total", subs.size);
    if (b.test) { subs.get(b.sub.endpoint).msg = { title:"Avisos activados", body:"Te avisaremos de tus sellos y ofertas ☕", url:b.role === "negocio" ? "/#negocio" : "/#cliente" }; push(b.sub.endpoint); }
    send(res, 200, { ok:true });
  });
  if (url.pathname === "/api/pushmsg" && req.method === "POST") return readBody(req, b => {
    const s = b && subs.get(b.endpoint);
    const m = (s && s.msg) || { title:"Parapapa", body:"Tienes novedades en tu tarjeta ☕", url:"/#cliente" };
    if (s) s.msg = null;
    send(res, 200, m);
  });
  const file = path.join(PUB, url.pathname === "/" ? "index.html" : path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUB)) return send(res, 403, "no", "text/plain");
  const TYPES = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".webmanifest":"application/manifest+json", ".png":"image/png" };
  fs.readFile(file, (e, d) => e ? send(res, 404, "No encontrado", "text/plain") : send(res, 200, d, TYPES[path.extname(file)] || "application/octet-stream"));
}).listen(PORT, () => console.log("Puntos Parapapa en :" + PORT + (vKey ? " · push activado" : " · push sin claves")));
