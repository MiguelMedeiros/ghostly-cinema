// Two sides of one chat on this machine, to try the built Cinema by hand: Miguel on the left, Ana on the right, each
// in <iframe sandbox="allow-scripts"> served with the web runner's header, as Ghostly runs an app. The page around
// them plays the broker: it relays `chat.send` between the two (32 KiB a frame, 48 a second) and keeps each side's
// storage in this page's localStorage, so a reload of one side keeps its library.
//
//   npm run build && npm run demo        (then open http://localhost:5180)
//
// "Compartilhar a biblioteca de exemplo" (or http://localhost:5180/?amostra) hands Miguel's side the files of
// demo-library/ (not in git: put your own test films there) without a folder picker.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 5180;
const RUNNER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** Runs in each frame before Cinema: `window.ghostly`, answered by the page around it. */
const BROKER = `<script>
(() => {
  const side = new URLSearchParams(location.search).get("side");
  let next = 0;
  const pending = new Map();
  const listeners = { message: new Set(), peer: new Set() };
  const call = (type, args) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    parent.postMessage({ side, id, type, args }, "*");
  });
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== parent || !m || typeof m !== "object") return;
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
    } else if (m.event === "chat.message") listeners.message.forEach((f) => f(m.data));
    else if (m.event === "chat.peer") listeners.peer.forEach((f) => f(m.data));
    else if (m.event === "demo.pick") {
      const list = m.data.map((x) => ({ path: x.path, file: new File([x.blob], x.path.split("/").pop(), { lastModified: x.modified }) }));
      dispatchEvent(new CustomEvent("cinema:pick", { detail: list }));
    }
  });
  window.ghostly = {
    context: () => call("context", []),
    file: async () => new ArrayBuffer(0),
    storage: {
      get: (k) => call("storage.get", [k]).then((v) => (v === null ? undefined : v)),
      set: (k, v) => call("storage.set", [k, v]),
      delete: (k) => call("storage.delete", [k]),
      keys: () => call("storage.keys", []),
    },
    chat: {
      send: (v) => call("chat.send", [v]),
      on: (event, f) => (listeners[event].add(f), () => listeners[event].delete(f)),
    },
    close: async () => {},
  };
  call("hello", []);
})();
</script>`;

const HOST = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cinema: two sides</title>
<style>
  html, body { margin: 0; height: 100%; background: #08080c; color: #ddd; font: 14px system-ui, sans-serif; }
  body { display: grid; grid-template-rows: auto 1fr; }
  header { display: flex; gap: 0.6em; align-items: center; padding: 0.5em 0.8em; flex-wrap: wrap; }
  header b { margin-right: auto; }
  button { font: inherit; background: #22222d; color: inherit; border: 0; border-radius: 6px; padding: 0.35em 0.8em; cursor: pointer; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 0 6px 6px; min-height: 0; }
  section { display: grid; grid-template-rows: auto 1fr; min-height: 0; }
  section h2 { font-size: 13px; font-weight: 600; margin: 0 0 4px; color: #a78bfa; }
  iframe { border: 0; width: 100%; height: 100%; border-radius: 8px; background: #000; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }
</style></head><body>
<header><b>Cinema · teste com dois lados</b>
  <button id="reload-miguel">Recarregar Miguel</button>
  <button id="reload-ana">Recarregar Ana</button>
  <span id="demo-status"></span>
  <button id="demo">Compartilhar a biblioteca de exemplo</button>
  <button id="clear">Apagar tudo</button>
</header>
<main>
  <section><h2>Miguel (compartilha)</h2><iframe id="miguel" sandbox="allow-scripts" allow="" title="Miguel"></iframe></section>
  <section><h2>Ana (assiste)</h2><iframe id="ana" sandbox="allow-scripts" allow="" title="Ana"></iframe></section>
</main>
<script>
const frames = { miguel: document.getElementById("miguel"), ana: document.getElementById("ana") };
const names = { miguel: "Miguel", ana: "Ana" };
const open = { miguel: false, ana: false };
const sent = { miguel: [], ana: [] };
const other = (side) => (side === "miguel" ? "ana" : "miguel");
const key = (side, k) => "cinema-demo:" + side + ":" + k;
const post = (side, message) => frames[side].contentWindow.postMessage(message, "*");
function closeSide(side) {
  if (!open[side]) return;
  open[side] = false;
  if (open[other(side)]) post(other(side), { event: "chat.peer", data: { open: false } });
}
addEventListener("message", (e) => {
  const m = e.data;
  const side = Object.keys(frames).find((s) => frames[s].contentWindow === e.source);
  if (!side || !m || m.side !== side) return;
  const answer = (value) => post(side, { id: m.id, ok: true, value: value === undefined ? null : value });
  const refuse = (error) => post(side, { id: m.id, ok: false, error });
  const [a, b] = m.args || [];
  switch (m.type) {
    case "hello":
      open[side] = true;
      if (open[other(side)]) post(other(side), { event: "chat.peer", data: { open: true, version: "0.1.0" } });
      return answer();
    case "context":
      return answer({ version: "0.1.0", inChat: true, peer: open[other(side)] ? { version: "0.1.0" } : null, theme: "dark", locale: "pt-BR", name: names[side] });
    case "storage.get": {
      const v = localStorage.getItem(key(side, a));
      return answer(v === null ? null : JSON.parse(v));
    }
    case "storage.set":
      try { localStorage.setItem(key(side, a), JSON.stringify(b)); return answer(); } catch { return refuse("full"); }
    case "storage.delete":
      localStorage.removeItem(key(side, a));
      return answer();
    case "storage.keys": {
      const prefix = key(side, "");
      return answer(Object.keys(localStorage).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
    }
    case "chat.send": {
      if (!open[other(side)]) return refuse("peer-closed");
      if (new TextEncoder().encode(JSON.stringify(a)).length > 32 * 1024) return refuse("too-large");
      const now = Date.now();
      sent[side] = sent[side].filter((t) => t > now - 1000);
      if (sent[side].length >= 48) return refuse("too-fast");
      sent[side].push(now);
      post(other(side), { event: "chat.message", data: a });
      return answer();
    }
    default:
      return refuse("unknown-type");
  }
});
for (const side of ["miguel", "ana"]) {
  document.getElementById("reload-" + side).addEventListener("click", () => {
    closeSide(side);
    frames[side].src = "/app?side=" + side + "&t=" + Date.now();
  });
}
// The frames load only now: the broker above must listen before the app's first call.
for (const side of ["miguel", "ana"]) frames[side].src = "/app?side=" + side;
async function shareSample() {
  const status = document.getElementById("demo-status");
  status.textContent = "Lendo a biblioteca de exemplo…";
  const list = await (await fetch("/demo-library.json")).json();
  const data = [];
  for (const [i, f] of list.entries()) {
    status.textContent = "Lendo " + (i + 1) + " de " + list.length + "…";
    data.push({ path: f.path, modified: f.modified, blob: await (await fetch("/demo-library/" + f.path.split("/").map(encodeURIComponent).join("/"))).blob() });
  }
  post("miguel", { event: "demo.pick", data });
  status.textContent = "";
}
document.getElementById("demo").addEventListener("click", () => void shareSample());
// ?amostra: the sample is shared as soon as Miguel's side is up.
if (new URLSearchParams(location.search).has("amostra")) {
  const wait = setInterval(() => {
    if (open.miguel) {
      clearInterval(wait);
      setTimeout(() => void shareSample(), 800);
    }
  }, 200);
}
document.getElementById("clear").addEventListener("click", () => {
  for (const k of Object.keys(localStorage)) if (k.startsWith("cinema-demo:")) localStorage.removeItem(k);
  for (const side of ["miguel", "ana"]) { closeSide(side); frames[side].src = "/app?side=" + side + "&t=" + Date.now(); }
});
</script></body></html>`;

const LIBRARY = new URL("../demo-library/", import.meta.url);

/** Every file of demo-library, relative to it, the library folder's own name first. */
function sample() {
  const root = fileURLToPath(LIBRARY);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => {
      const full = join(d.parentPath ?? d.path, d.name);
      return { path: relative(root, full).split(sep).join("/"), modified: Math.round(statSync(full).mtimeMs) };
    });
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/demo-library.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(sample()));
    return;
  }
  if (url.pathname.startsWith("/demo-library/")) {
    const rel = decodeURIComponent(url.pathname.slice("/demo-library/".length));
    const full = resolve(fileURLToPath(LIBRARY), rel);
    if (!full.startsWith(fileURLToPath(LIBRARY)) || !existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(full).size, "cache-control": "no-store" });
    createReadStream(full).pipe(res);
    return;
  }
  if (req.url?.startsWith("/app")) {
    const page = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8").replace("<head>", `<head>\n${BROKER}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": RUNNER_CSP, "cache-control": "no-store" });
    res.end(page);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(HOST);
}).listen(PORT, () => console.log(`Cinema, two sides: http://localhost:${PORT}`));
