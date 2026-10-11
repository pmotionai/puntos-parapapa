// Servidor de la demo de puntos de Parapapa: sirve la página y guarda un único estado compartido
// (tarjeta de la clienta de ejemplo + solicitudes de sello) para que el móvil del cliente y el del negocio se vean en directo.
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 10002;
const PUB = path.join(__dirname, "public");
let state = null, ver = 0;

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/state"){
    if (req.method === "GET") return send(res, 200, { ver, state });
    if (req.method === "PUT"){
      let b = "";
      req.on("data", c => { b += c; if (b.length > 2e5) req.destroy(); });
      req.on("end", () => { try { state = JSON.parse(b); ver++; send(res, 200, { ver }); } catch (e) { send(res, 400, { error: "json" }); } });
      return;
    }
    return send(res, 405, { error: "method" });
  }
  const file = path.join(PUB, url.pathname === "/" ? "index.html" : path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUB)) return send(res, 403, "no", "text/plain");
  fs.readFile(file, (e, d) => e ? send(res, 404, "No encontrado", "text/plain") : send(res, 200, d, file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream"));
}).listen(PORT, () => console.log("Puntos Parapapa en :" + PORT));
