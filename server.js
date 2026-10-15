// Servidor de la tarjeta de puntos de Parapapa (sírvelo).
// - Clientes reales: cada uno se registra una vez (nombre, teléfono, privacidad y, si quiere, ofertas) y su móvil guarda su identificador.
//   Al escanear el QR del mostrador la tarjeta ya sabe quién es y pide el sello sola.
// - Panel del negocio protegido con PIN (NEGOCIO_PIN, por defecto 2580 en la demo).
// - Avisos push (Web Push con VAPID, sin librerías): el push va vacío y el service worker pide el texto a /api/pushmsg.
// - Demo: los datos viven en memoria. Si el servidor gratuito se duerme, cada móvil vuelve a subir su copia al abrirse.
//   En la versión real van a una base de datos (Supabase / Postgres en la UE).
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 10002;
const PUB = path.join(__dirname, "public");
const PIN = process.env.NEGOCIO_PIN || "2580";
const BUILD = process.env.RENDER_GIT_COMMIT || String(fs.statSync(path.join(PUB, "index.html")).mtimeMs);

/* ---------- datos ---------- */
let DB = { gen: Date.now().toString(36), clients: {}, reqs: [], nextCard: 1 };
const killed = new Set();     // generaciones borradas con «Reiniciar la demo»: esas copias no se recuperan
let ver = 0; const bump = () => { ver++; };
const now = () => Date.now();
const rid = n => crypto.randomBytes(n).toString("base64url");
const telNorm = t => String(t || "").replace(/[^\d]/g, "").replace(/^34(?=\d{9}$)/, "");
const safe = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);
const pub = c => c && { id:c.id, name:c.name, tel:c.tel, card:c.card, ofertas:c.ofertas, privAt:c.privAt, stamps:c.stamps, free:c.free, visits:c.visits, last:c.last, canal:c.canal, avisos:c.avisos.slice(-5) };
const byTel = t => Object.values(DB.clients).find(c => c.tel && c.tel === telNorm(t));
function newClient(o){
  const c = { id:rid(12), name:safe(o.name, 40), tel:telNorm(o.tel).slice(0, 15), card:String(DB.nextCard++).padStart(4, "0"),
    ofertas:!!o.ofertas, privAt:new Date().toISOString(), canal:o.canal || "app", stamps:0, free:0, visits:0, last:0, avisos:[] };
  DB.clients[c.id] = c; bump(); return c;
}
function addAviso(c, m){ c.avisos.push({ id:now() + "" + Math.random().toString(36).slice(2,6), m, at:now() }); c.avisos = c.avisos.slice(-8); }
function addStamp(c){
  c.stamps++; const full = c.stamps % 10 === 0; if (full) c.free++; c.visits++; c.last = now();
  const m = full ? "🎉 ¡Tarjeta completa! Tu próximo café es gratis." : `+1 sello. Te faltan ${10 - c.stamps % 10} para el café gratis.`;
  addAviso(c, m); bump(); notifyClient(c.id, { title:"Tu tarjeta de cafés", body:m, url:"/#cliente", ask:true });
}

/* ---------- Web Push ---------- */
const VPUB = process.env.VAPID_PUBLIC || "", VPRIV = process.env.VAPID_PRIVATE || "";
let vKey = null;
if (VPUB && VPRIV){
  const raw = Buffer.from(VPUB, "base64url");
  vKey = crypto.createPrivateKey({ format:"jwk", key:{ kty:"EC", crv:"P-256", d:VPRIV,
    x:raw.subarray(1, 33).toString("base64url"), y:raw.subarray(33, 65).toString("base64url") } });
}
const subs = new Map();   // endpoint → { sub, role, cid, reviewed, msg }
function vapidJWT(aud){
  const h = Buffer.from(JSON.stringify({ typ:"JWT", alg:"ES256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ aud, exp:Math.floor(now()/1000) + 12*3600, sub:"mailto:contacto@pmotionia.com" })).toString("base64url");
  const sig = crypto.sign("sha256", Buffer.from(h + "." + p), { key:vKey, dsaEncoding:"ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${sig}`;
}
function push(endpoint){
  if (!vKey) return;
  const u = new URL(endpoint);
  const req = https.request(u, { method:"POST", headers:{ TTL:"3600", Urgency:"high", "Content-Length":0,
    Authorization:`vapid t=${vapidJWT(u.origin)}, k=${VPUB}` } }, res => {
    console.log("push", u.host, res.statusCode);
    if (res.statusCode === 404 || res.statusCode === 410) subs.delete(endpoint);
    res.resume();
  });
  req.on("error", e => console.log("push error", u.host, e.message)); req.end();
}
function deliver(ep, s, msg){
  s.msg = (msg.ask && !s.reviewed) ? { title:msg.title, body:msg.body + " ¿Te ha gustado? Toca y déjanos una reseña ⭐", url:"/?resena=1#cliente" } : msg;
  push(ep);
}
function notifyClient(cid, msg){ for (const [ep, s] of subs) if (s.role === "cliente" && s.cid === cid) deliver(ep, s, msg); }
function notifyNegocio(msg){ for (const [ep, s] of subs) if (s.role === "negocio") deliver(ep, s, msg); }

/* ---------- HTTP ---------- */
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req, cb) => { let b = ""; req.on("data", c => { b += c; if (b.length > 2e5) req.destroy(); }); req.on("end", () => { try { cb(JSON.parse(b || "{}")); } catch (e) { cb(null); } }); };
const DAY = 864e5;

function panel(){
  const cs = Object.values(DB.clients);
  const mes = cs.reduce((a, c) => a + (c.last > now() - 30*DAY ? c.visits : 0), 0);
  const rep = cs.length ? Math.round(100 * cs.filter(c => c.visits >= 2).length / cs.length) : 0;
  return { ver, gen:DB.gen,
    reqs: DB.reqs.filter(r => r.status === "pendiente").map(r => ({ ...r, name:(DB.clients[r.cid] || {}).name || "Cliente", stamps:(DB.clients[r.cid] || {}).stamps || 0 })),
    clients: cs.sort((a, b) => (b.last || 0) - (a.last || 0)).map(pub),
    stats: { clientes:cs.length, visitasMes:mes, repiten:rep, conOfertas:cs.filter(c => c.ofertas).length } };
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x"), P = url.pathname, POST = req.method === "POST";
  if (P === "/api/version") return send(res, 200, BUILD, "text/plain");
  if (P === "/api/vapid") return vKey ? send(res, 200, VPUB, "text/plain") : send(res, 503, "sin claves", "text/plain");

  /* --- cliente --- */
  if (P === "/api/register" && POST) return readBody(req, b => {
    if (!b || !safe(b.name, 40) || telNorm(b.tel).length < 9) return send(res, 400, { error:"Faltan el nombre o un teléfono válido" });
    if (!b.priv) return send(res, 400, { error:"Hay que aceptar la política de privacidad" });
    if (byTel(b.tel)) return send(res, 409, { error:"Ya hay una tarjeta con este teléfono", exists:true });
    const c = newClient({ name:b.name, tel:b.tel, ofertas:b.ofertas, canal:"app" });
    addAviso(c, "¡Bienvenido/a a Parapapa! Cada café suma un sello; al décimo, invitamos nosotros ☕");
    console.log("registro", c.card); send(res, 200, { gen:DB.gen, client:pub(c) });
  });
  if (P === "/api/login" && POST) return readBody(req, b => {
    const c = b && byTel(b.tel);          // demo: sin código por SMS (en la versión real, código de un solo uso)
    return c ? send(res, 200, { gen:DB.gen, client:pub(c) }) : send(res, 404, { error:"No hay ninguna tarjeta con ese teléfono" });
  });
  if (P === "/api/me" && POST) return readBody(req, b => {
    if (!b || !b.id) return send(res, 400, { error:"id" });
    let c = DB.clients[b.id];
    if (!c && b.copy && (b.gen === DB.gen || killed.has(b.gen))) return send(res, 410, { error:"reset" });     // se dio de baja o se reinició la demo
    if (!c && b.copy && b.copy.id === b.id && !byTel(b.copy.tel)){                       // el servidor se ha reiniciado: el móvil devuelve su copia
      c = { ...b.copy, tel:telNorm(b.copy.tel), avisos:(b.copy.avisos || []).slice(-8), privAt:b.copy.privAt || new Date().toISOString() };
      DB.clients[c.id] = c; DB.nextCard = Math.max(DB.nextCard, (+c.card || 0) + 1); bump();
    }
    if (!c) return send(res, 410, { error:"No encontramos tu tarjeta" });
    const r = DB.reqs.filter(x => x.cid === c.id).slice(-1)[0];
    send(res, 200, { gen:DB.gen, ver, client:pub(c), req:r ? { id:r.id, status:r.status, at:r.at } : null });
  });
  if (P === "/api/request" && POST) return readBody(req, b => {
    const c = b && DB.clients[b.id];
    if (!c) return send(res, 410, { error:"No encontramos tu tarjeta" });
    let r = DB.reqs.find(x => x.cid === c.id && x.status === "pendiente");
    if (!r){ r = { id:rid(6), cid:c.id, at:now(), status:"pendiente" }; DB.reqs.push(r); DB.reqs = DB.reqs.slice(-200); bump();
      notifyNegocio({ title:"Nueva solicitud de sello", body:`☕ ${c.name} pide un sello. Toca para aceptarlo.`, url:"/#negocio" }); }
    send(res, 200, { req:{ id:r.id, status:r.status, at:r.at } });
  });
  if (P === "/api/delete-me" && POST) return readBody(req, b => {     // derecho de supresión
    const c = b && DB.clients[b.id];
    if (c){ delete DB.clients[c.id]; DB.reqs = DB.reqs.filter(r => r.cid !== c.id); for (const [ep, s] of subs) if (s.cid === c.id) subs.delete(ep); bump(); console.log("baja", c.card); }
    send(res, 200, { ok:true, gen:DB.gen });
  });

  /* --- negocio (PIN) --- */
  if (P.startsWith("/api/neg/")){
    if (req.headers["x-pin"] !== PIN) return send(res, 401, { error:"PIN incorrecto" });
    if (P === "/api/neg/panel") return send(res, 200, panel());
    if (!POST) return send(res, 405, { error:"method" });
    return readBody(req, b => {
      if (!b) return send(res, 400, { error:"json" });
      if (P === "/api/neg/decide"){
        const r = DB.reqs.find(x => x.id === b.id); const c = r && DB.clients[r.cid];
        if (!r || r.status !== "pendiente" || !c) return send(res, 404, { error:"Ya no está pendiente" });
        r.status = b.ok ? "aceptada" : "rechazada"; bump();
        if (b.ok) addStamp(c); else notifyClient(c.id, { title:"Parapapa", body:"No hemos podido confirmar el sello. Pregunta en la barra.", url:"/#cliente" });
        return send(res, 200, panel());
      }
      if (P === "/api/neg/stamp"){ const c = DB.clients[b.id]; if (!c) return send(res, 404, { error:"Cliente no encontrado" }); addStamp(c); return send(res, 200, panel()); }
      if (P === "/api/neg/newclient"){
        if (!safe(b.name, 40)) return send(res, 400, { error:"Falta el nombre" });
        if (b.tel && byTel(b.tel)) return send(res, 409, { error:"Ya hay un cliente con ese teléfono" });
        const c = newClient({ name:b.name, tel:b.tel, ofertas:b.ofertas, canal:"mostrador" });
        if (b.first) addStamp(c);
        return send(res, 200, { ...panel(), created:pub(c) });
      }
      if (P === "/api/neg/broadcast"){
        const m = safe(b.m, 200); if (!m) return send(res, 400, { error:"Escribe el aviso" });
        let cs = Object.values(DB.clients).filter(c => c.ofertas);                       // solo a quien aceptó recibir ofertas
        if (b.seg === "dormidos") cs = cs.filter(c => !c.last || c.last < now() - 30*DAY);
        if (b.seg === "top") cs = cs.sort((a, z) => z.visits - a.visits).slice(0, 10);
        cs.forEach(c => { addAviso(c, m); notifyClient(c.id, { title:"Novedad de Parapapa", body:m, url:"/#cliente" }); }); bump();
        return send(res, 200, { ...panel(), sent:cs.length });
      }
      if (P === "/api/neg/reset"){ killed.add(DB.gen); DB = { gen:Date.now().toString(36), clients:{}, reqs:[], nextCard:1 }; for (const [ep, s] of subs) if (s.role === "cliente") subs.delete(ep); bump(); return send(res, 200, panel()); }
      send(res, 404, { error:"no" });
    });
  }

  /* --- push --- */
  if (P === "/api/subscribe" && POST) return readBody(req, b => {
    if (!b || !b.sub || !b.sub.endpoint || !/^https:\/\//.test(b.sub.endpoint)) return send(res, 400, { error:"sub" });
    const role = b.role === "negocio" ? "negocio" : "cliente";
    if (role === "negocio" && b.pin !== PIN) return send(res, 401, { error:"PIN" });
    const old = subs.get(b.sub.endpoint);
    const s = { sub:b.sub, role, cid:role === "cliente" ? b.cid : null, reviewed:!!b.reviewed, msg:old ? old.msg : null };
    subs.set(b.sub.endpoint, s);
    console.log("subscribe", role, new URL(b.sub.endpoint).host, "total", subs.size);
    if (b.test){ s.msg = { title:"Avisos activados", body:role === "negocio" ? "Te avisaremos de cada solicitud de sello ☕" : "Te avisaremos de tus sellos y ofertas ☕", url:role === "negocio" ? "/#negocio" : "/#cliente" }; push(b.sub.endpoint); }
    send(res, 200, { ok:true });
  });
  if (P === "/api/pushmsg" && POST) return readBody(req, b => {
    const s = b && subs.get(b.endpoint);
    const m = (s && s.msg) || { title:"Parapapa", body:"Tienes novedades en tu tarjeta ☕", url:"/#cliente" };
    if (s) s.msg = null;
    send(res, 200, m);
  });

  /* --- archivos --- */
  const file = path.join(PUB, P === "/" ? "index.html" : path.normalize(decodeURIComponent(P)));
  if (!file.startsWith(PUB)) return send(res, 403, "no", "text/plain");
  const TYPES = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".webmanifest":"application/manifest+json", ".png":"image/png" };
  fs.readFile(file, (e, d) => e ? send(res, 404, "No encontrado", "text/plain") : send(res, 200, d, TYPES[path.extname(file)] || "application/octet-stream"));
}).listen(PORT, () => console.log("Puntos Parapapa en :" + PORT + (vKey ? " · push activado" : " · push sin claves")));
