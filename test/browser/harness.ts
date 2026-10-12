/**
 * The built Cinema (dist/index.html) in real browsers, for the Playwright specs: each side in its own browser
 * context, the page inside `<iframe sandbox="allow-scripts">` served with the web runner's CSP header (WISP 1200), so
 * the frame has an opaque origin and what the runner forbids fails here too.
 *
 * The broker each frame gets as `window.ghostly` is a script injected before the page's own; its storage and the
 * chat between the two sides live in Node (exposeBinding), so storage survives a reload, a test can close and reopen
 * a side, and the relay enforces the broker's limits: 32 KiB a frame, 48 frames a second (`too-fast`).
 *
 * Nothing leaves the machine: a local server answers both URLs.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Frame, Page } from "@playwright/test";

const dist = join(import.meta.dirname, "../../dist/index.html");

/** The web runner's header (WISP 1200, "The runner and the broker"). */
export const RUNNER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** Serves the host page and the app's frame with the runner's header. */
export async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const page = readFileSync(dist, "utf8");
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/app")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": RUNNER_CSP, "x-content-type-options": "nosniff" });
      res.end(page);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe sandbox="allow-scripts" allow="" title="Cinema" src="/app"></iframe></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

interface BrokerOptions {
  locale: string;
  inChat: boolean;
  displayName?: string;
}

/** Runs in the frame before Cinema: the test broker, talking to Node. */
function installBroker(options: BrokerOptions): void {
  if (window === window.top) return;
  const w = window as unknown as Record<string, unknown> & Window;
  w.__violations = [] as string[];
  document.addEventListener("securitypolicyviolation", (e) => (w.__violations as string[]).push(`${e.violatedDirective} ${e.blockedURI}`));
  const listeners = { message: new Set<(d: unknown) => void>(), peer: new Set<(d: unknown) => void>() };
  const call = (name: string, ...args: unknown[]) => (w[name] as (...a: unknown[]) => Promise<unknown>)(...args);
  const checked = async (name: string, ...args: unknown[]) => {
    const answer = (await call(name, ...args)) as { ok: boolean; value?: unknown; error?: string };
    if (!answer.ok) throw new Error(answer.error);
    return answer.value;
  };
  w.__deliver = (data: unknown) => listeners.message.forEach((l) => l(data));
  w.__peerEvent = (event: unknown) => listeners.peer.forEach((l) => l(event));
  w.ghostly = {
    context: () => checked("__cinemaContext", options),
    file: async () => new ArrayBuffer(0),
    storage: {
      get: async (key: string) => {
        const v = await checked("__cinemaStorage", "get", key);
        return v === null ? undefined : v;
      },
      set: (key: string, value: unknown) => checked("__cinemaStorage", "set", key, JSON.parse(JSON.stringify(value))),
      delete: (key: string) => checked("__cinemaStorage", "delete", key),
      keys: () => checked("__cinemaStorage", "keys"),
    },
    chat: {
      send: (value: unknown) => checked("__cinemaSend", JSON.parse(JSON.stringify(value))),
      on: (event: "message" | "peer", listener: (d: unknown) => void) => {
        listeners[event].add(listener);
        return () => listeners[event].delete(listener);
      },
    },
    close: async () => {},
  };
  void call("__cinemaHello");
}

export interface Side {
  name: string;
  page: Page;
  context: BrowserContext;
  /** The frame Cinema runs in, once its broker said hello. */
  frame: Frame;
  storage: Map<string, string>;
  /** When each chat frame was sent, for the 48 a second. */
  sent: number[];
  /** Frames the relay refused as too fast. */
  tooFast: number;
}

export interface Chat {
  sides: Map<string, Side>;
  url: string;
  close: () => Promise<void>;
}

export async function chat(): Promise<Chat> {
  const server = await serve();
  return { sides: new Map(), url: server.url, close: server.close };
}

/** Opens one side of the chat (or reopens it, keeping its storage). */
export async function openSide(
  browser: Browser,
  room: Chat,
  options: { name: string; displayName?: string; locale?: string; inChat?: boolean; contextOptions?: BrowserContextOptions; storage?: Map<string, string> },
): Promise<Side> {
  const context = await browser.newContext(options.contextOptions);
  const page = await context.newPage();
  const side = {
    name: options.name,
    page,
    context,
    storage: options.storage ?? room.sides.get(options.name)?.storage ?? new Map<string, string>(),
    sent: [],
    tooFast: 0,
  } as unknown as Side;
  const others = () => [...room.sides.values()].filter((s) => s !== side && s.frame && !s.page.isClosed());
  let resolveFrame!: (frame: Frame) => void;
  const ready = new Promise<Frame>((resolve) => (resolveFrame = resolve));
  await page.exposeBinding("__cinemaContext", async (_source, o: BrokerOptions) => ({
    ok: true,
    value: { version: "0.1.0", inChat: o.inChat, peer: others().length ? { version: "0.1.0" } : null, theme: "dark", locale: o.locale, ...(o.displayName && { name: o.displayName }) },
  }));
  await page.exposeBinding("__cinemaHello", async ({ frame }) => {
    side.frame = frame;
    for (const other of others()) {
      await other.frame.evaluate(() => (window as unknown as { __peerEvent: (e: unknown) => void }).__peerEvent({ open: true, version: "0.1.0" })).catch(() => {});
    }
    resolveFrame(frame);
  });
  await page.exposeBinding("__cinemaStorage", async (_source, op: string, key?: string, value?: unknown) => {
    if (op === "get") return { ok: true, value: side.storage.has(key!) ? JSON.parse(side.storage.get(key!)!) : null };
    if (op === "set") {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 64 * 1024) return { ok: false, error: "too-large" };
      side.storage.set(key!, text);
      return { ok: true };
    }
    if (op === "delete") return side.storage.delete(key!), { ok: true };
    return { ok: true, value: [...side.storage.keys()] };
  });
  await page.exposeBinding("__cinemaSend", async (_source, data: unknown) => {
    const other = others()[0];
    if (!other) return { ok: false, error: "peer-closed" };
    if (Buffer.byteLength(JSON.stringify(data)) > 32 * 1024) return { ok: false, error: "too-large" };
    const now = Date.now();
    side.sent = side.sent.filter((t) => t > now - 1000);
    if (side.sent.length >= 48) {
      side.tooFast++;
      return { ok: false, error: "too-fast" };
    }
    side.sent.push(now);
    void other.frame.evaluate((d) => (window as unknown as { __deliver: (d: unknown) => void }).__deliver(d), data).catch(() => {});
    return { ok: true };
  });
  await page.addInitScript(installBroker, { locale: options.locale ?? "en", inChat: options.inChat ?? true, displayName: options.displayName } satisfies BrokerOptions);
  room.sides.set(options.name, side);
  await page.goto(room.url);
  side.frame = await ready;
  return side;
}

/** Closes one side, as a closed app: the other hears it. */
export async function closeSide(room: Chat, side: Side): Promise<void> {
  await side.context.close();
  for (const other of room.sides.values()) {
    if (other !== side && !other.page.isClosed()) {
      await other.frame.evaluate(() => (window as unknown as { __peerEvent: (e: unknown) => void }).__peerEvent({ open: false })).catch(() => {});
    }
  }
}

/** The CSP violations the frame saw. */
export const violations = (side: Side) => side.frame.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
