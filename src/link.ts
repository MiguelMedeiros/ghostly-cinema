/**
 * Bytes over `apps/1`: what Cinema sends between the two sides of a chat. `apps/1` carries JSON frames of at most
 * 32 KiB, at most 48 a second, on the chat's own ordered channel, and tells the app nothing about how full that
 * channel is. So:
 *
 * - every frame goes through one queue, at most `FRAMES_PER_SECOND` a second, control frames first;
 * - bytes travel as base64 chunks of `CHUNK_BYTES`, pulled by the side that asked (`get`), acknowledged, with only a
 *   window of chunks unacknowledged at a time: a small window when the channel pushes back, a bigger one when it
 *   does not;
 * - a frame `chat.send` refused because the channel was full (`offline`, `too-fast`) while the contact is still open
 *   is sent again a little later, and the window shrinks. On Iroh and HyperDHT in a browser a full channel answers
 *   `offline`, the same as a lost session (`ghostlink.ts`), so only the peer's own `chat.peer` event ends transfers.
 *
 * Frames from the contact are untrusted: every field is checked before it is used, and a frame that is not one of
 * ours is dropped.
 */
import type { MiniAppApi, MiniAppJson, MiniAppPeerEvent } from "./vendor/miniApp.ts";

/** The protocol this build speaks, said in `hello`. */
export const PROTOCOL = 1;
/**
 * Raw bytes in one `dat` frame: 32,640 characters of base64 and the frame's own fields (about 60 with large
 * numbers), under the 32 KiB `chat.send` takes.
 */
export const CHUNK_BYTES = 24_480;
/**
 * Frames this side sends a second, under the 48 `chat.send` allows and the broker's 50 requests of every kind (the
 * pacing in broker.ts keeps all calls under 46). With CHUNK_BYTES this is the ceiling of a stream: about 8.8 Mbit/s.
 */
export const FRAMES_PER_SECOND = 44;
/** Chunks in flight, unacknowledged: where the window starts, and its bounds. */
export const WINDOW = { start: 4, min: 1, max: 16 };
/** The most one transfer may carry: a fragment or a catalogue is far below it. */
export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
/** A transfer that hears nothing for this long ends, so a lost frame never holds the link. */
export const STALL_MS = 15_000;

export type Kind = "cat" | "pic" | "init" | "seg" | "sub";
const KINDS: readonly Kind[] = ["cat", "pic", "init", "seg", "sub"];

/** What a request asks for: its kind and plain parameters. */
export interface Ask {
  k: Kind;
  id?: string;
  /** seg: the video sample to start at, or the time (seconds) to seek to; the audio track. */
  from?: number;
  at?: number;
  a?: number;
  /** sub: which subtitle. */
  s?: string;
}

export interface Reply {
  meta?: { [key: string]: MiniAppJson };
  bytes: Uint8Array;
}

/** Why a request failed, as the other side said it or as this side saw it. */
export class LinkError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface LinkStats {
  /** Bytes received in data chunks over the last few seconds, per second. */
  rate: number;
  window: number;
  /** Frames sent again after the channel refused them. */
  retries: number;
}

export type Serve = (ask: Ask) => Promise<Reply>;

type Frame = { [key: string]: MiniAppJson };

const isInt = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isStr = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Reads an `Ask` out of an untrusted `get` frame, or null. */
export function readAsk(f: Frame): Ask | null {
  if (!KINDS.includes(f.k as Kind)) return null;
  const ask: Ask = { k: f.k as Kind };
  if (f.id !== undefined) {
    if (!isStr(f.id, 64)) return null;
    ask.id = f.id;
  }
  if (f.from !== undefined) {
    if (!isInt(f.from, 0, 1e9)) return null;
    ask.from = f.from;
  }
  if (f.at !== undefined) {
    if (typeof f.at !== "number" || !Number.isFinite(f.at) || f.at < 0 || f.at > 1e6) return null;
    ask.at = f.at;
  }
  if (f.a !== undefined) {
    if (!isInt(f.a, 0, 64)) return null;
    ask.a = f.a;
  }
  if (f.s !== undefined) {
    if (!isStr(f.s, 64)) return null;
    ask.s = f.s;
  }
  return ask;
}

interface Outgoing {
  r: number;
  bytes: Uint8Array;
  chunks: number;
  /** Next chunk to send, and every chunk before `acked` is acknowledged. */
  next: number;
  acked: number;
  heard: number;
}

interface Incoming {
  r: number;
  n: number;
  meta?: Frame;
  bytes?: Uint8Array;
  got: Uint8Array;
  have: number;
  /** Every chunk before `contiguous` is here. */
  contiguous: number;
  lastAck: number;
  heard: number;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  onProgress?: (received: number, total: number) => void;
}

/** How long to wait before sending a refused frame again, and between ack batches. */
const RETRY_MS = 120;
const ACK_EVERY = 2;

export interface LinkOptions {
  /** What this side answers to `get`; none means "this side shares nothing". */
  serve?: Serve;
  /** Frames that are not transfers: `hello`, `lib` and the like, already parsed. */
  onFrame?: (frame: Frame) => void;
  /** The contact's app opened or closed. */
  onPeer?: (open: boolean, version?: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class Link {
  private queue: { frame: Frame; control: boolean; resolve: () => void; reject: (e: Error) => void }[] = [];
  private pumping = false;
  /** The frame `chat.send` has now, which stays in the queue until it is taken. */
  private sending: Frame | null = null;
  private sentAt: number[] = [];
  private window = WINDOW.start;
  private goodSince = 0;
  private outgoing = new Map<number, Outgoing>();
  private incoming = new Map<number, Incoming>();
  private nextR = 1;
  private peerOpen = false;
  private received: { at: number; bytes: number }[] = [];
  private retries = 0;
  private serveQueue: Promise<void> = Promise.resolve();
  private stallTimer: unknown = null;
  private unsubscribe: (() => void)[] = [];
  private closed = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly api: MiniAppApi,
    private readonly options: LinkOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.unsubscribe.push(api.chat.on("message", (data) => this.receive(data)));
    this.unsubscribe.push(api.chat.on("peer", (peer) => this.peer(peer)));
  }

  /** Whether the contact's app is open now, as far as this side heard. */
  get open(): boolean {
    return this.peerOpen;
  }

  /** Sets what this side knew of the peer when it started (`context().peer`). */
  setPeer(open: boolean): void {
    this.peerOpen = open;
  }

  stats(): LinkStats {
    const since = this.now() - 3000;
    this.received = this.received.filter((r) => r.at >= since);
    const bytes = this.received.reduce((s, r) => s + r.bytes, 0);
    return { rate: bytes / 3, window: this.window, retries: this.retries };
  }

  /** Sends a frame that is not a transfer (`hello`, `lib`). Resolves once `chat.send` took it. */
  say(frame: Frame): Promise<void> {
    return this.enqueue(frame, true);
  }

  /** Asks the contact for something; resolves with its bytes. `signal` cancels it. */
  request(ask: Ask, opts: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {}): Promise<Reply> {
    if (this.closed) return Promise.reject(new LinkError("closed"));
    if (!this.peerOpen) return Promise.reject(new LinkError("peer-closed"));
    const r = this.nextR++;
    return new Promise<Reply>((resolve, reject) => {
      const t: Incoming = { r, n: -1, got: new Uint8Array(0), have: 0, contiguous: 0, lastAck: 0, heard: this.now(), resolve, reject, onProgress: opts.onProgress };
      this.incoming.set(r, t);
      this.armStall();
      const abort = () => {
        if (!this.incoming.has(r)) return;
        this.incoming.delete(r);
        reject(new LinkError("cancelled"));
        void this.enqueue({ t: "cancel", r }, true).catch(() => {});
      };
      if (opts.signal) {
        if (opts.signal.aborted) return abort();
        opts.signal.addEventListener("abort", abort, { once: true });
      }
      this.enqueue({ t: "get", r, ...(ask as unknown as Frame) }, true).catch((error: Error) => {
        if (this.incoming.delete(r)) reject(error);
      });
    });
  }

  /** Stops everything: the app is closing. */
  close(): void {
    this.closed = true;
    for (const off of this.unsubscribe) off();
    this.failAll(new LinkError("closed"));
    if (this.stallTimer) this.clearTimer(this.stallTimer);
  }

  // Sending

  private enqueue(frame: Frame, control: boolean): Promise<void> {
    if (this.closed) return Promise.reject(new LinkError("closed"));
    return new Promise<void>((resolve, reject) => {
      const item = { frame, control, resolve, reject };
      if (control) {
        // Before the first data frame, but never before the frame chat.send has now.
        const busy = this.queue.length && this.queue[0].frame === this.sending ? 1 : 0;
        const firstData = this.queue.findIndex((q, i) => i >= busy && !q.control);
        if (firstData < 0) this.queue.push(item);
        else this.queue.splice(firstData, 0, item);
      } else {
        this.queue.push(item);
      }
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.closed) {
        // Keep under FRAMES_PER_SECOND over any second.
        const now = this.now();
        this.sentAt = this.sentAt.filter((t) => t > now - 1000);
        if (this.sentAt.length >= FRAMES_PER_SECOND) {
          await this.sleep(this.sentAt[0] + 1000 - now + 1);
          continue;
        }
        const item = this.queue[0];
        try {
          this.sentAt.push(this.now());
          this.sending = item.frame;
          await this.api.chat.send(item.frame);
          this.take(item);
          item.resolve();
          if (!item.control && this.now() - this.goodSince > 1000 && this.window < WINDOW.max) {
            this.window++;
            this.goodSince = this.now();
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : "failed";
          if ((code === "offline" || code === "too-fast") && this.peerOpen) {
            // The channel is full: wait, shrink the window, send the same frame again.
            this.retries++;
            this.window = Math.max(WINDOW.min, Math.floor(this.window / 2));
            this.goodSince = this.now();
            await this.sleep(RETRY_MS);
            continue;
          }
          this.take(item);
          item.reject(new LinkError(code === "offline" || code === "not-open" ? "peer-closed" : code));
        } finally {
          this.sending = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private take(item: { frame: Frame }): void {
    const at = this.queue.indexOf(item as (typeof this.queue)[number]);
    if (at >= 0) this.queue.splice(at, 1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimer(resolve, ms));
  }

  /** Puts as many chunks of the transfers going out on the queue as the window allows. */
  private feed(): void {
    let inFlight = 0;
    for (const o of this.outgoing.values()) inFlight += o.next - o.acked;
    let progressed = true;
    while (inFlight < this.window && progressed) {
      progressed = false;
      // Round robin over the transfers: one chunk each.
      for (const o of this.outgoing.values()) {
        if (inFlight >= this.window) break;
        if (o.next >= o.chunks) continue;
        const i = o.next++;
        inFlight++;
        progressed = true;
        const b = toBase64(o.bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
        // `a` asks for an ack now: the window is full, or this is the last chunk.
        const ask = inFlight >= this.window || i === o.chunks - 1;
        this.enqueue({ t: "dat", r: o.r, i, b, ...(ask && { a: 1 }) }, false).catch(() => this.outgoing.delete(o.r));
      }
    }
  }

  // Receiving

  private peer(event: MiniAppPeerEvent): void {
    const open = event.open === true;
    this.peerOpen = open;
    if (!open) {
      this.failAll(new LinkError("peer-closed"));
      this.queue.splice(0).forEach((q) => q.reject(new LinkError("peer-closed")));
      this.window = WINDOW.start;
    }
    this.options.onPeer?.(open, event.open ? event.version : undefined);
  }

  private failAll(error: LinkError): void {
    for (const t of this.incoming.values()) t.reject(error);
    this.incoming.clear();
    this.outgoing.clear();
  }

  private receive(data: MiniAppJson): void {
    if (this.closed || !data || typeof data !== "object" || Array.isArray(data)) return;
    const f = data as Frame;
    switch (f.t) {
      case "get":
        return this.onGet(f);
      case "hdr":
        return this.onHeader(f);
      case "dat":
        return this.onData(f);
      case "ack":
        return this.onAck(f);
      case "err":
        return this.onError(f);
      case "cancel":
        if (isInt(f.r)) this.dropOutgoing(f.r);
        return;
      default:
        if (typeof f.t === "string") this.options.onFrame?.(f);
    }
  }

  private onGet(f: Frame): void {
    if (!isInt(f.r, 1)) return;
    const r = f.r;
    const ask = readAsk(f);
    const serve = this.options.serve;
    // One request is prepared at a time; its chunks then go out beside the others'.
    this.serveQueue = this.serveQueue.then(async () => {
      if (!ask) return void (await this.enqueue({ t: "err", r, e: "bad-request" }, true).catch(() => {}));
      if (!serve) return void (await this.enqueue({ t: "err", r, e: "no-library" }, true).catch(() => {}));
      let reply: Reply;
      try {
        reply = await serve(ask);
      } catch (error) {
        const code = error instanceof LinkError ? error.code : "failed";
        return void (await this.enqueue({ t: "err", r, e: code }, true).catch(() => {}));
      }
      if (reply.bytes.length > MAX_TRANSFER_BYTES) return void (await this.enqueue({ t: "err", r, e: "too-large" }, true).catch(() => {}));
      const chunks = Math.ceil(reply.bytes.length / CHUNK_BYTES);
      await this.enqueue({ t: "hdr", r, n: reply.bytes.length, ...(reply.meta && { m: reply.meta }) }, true).catch(() => {});
      if (!chunks) return;
      this.outgoing.set(r, { r, bytes: reply.bytes, chunks, next: 0, acked: 0, heard: this.now() });
      this.armStall();
      this.feed();
    });
  }

  /** Forgets a transfer going out, with its chunks still waiting in the queue (never the one being sent). */
  private dropOutgoing(r: number): void {
    this.outgoing.delete(r);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (!q.control && q.frame.r === r && q.frame !== this.sending) {
        this.queue.splice(i, 1);
        q.resolve();
      }
    }
  }

  private onHeader(f: Frame): void {
    if (!isInt(f.r, 1) || !isInt(f.n, 0, MAX_TRANSFER_BYTES)) return;
    const t = this.incoming.get(f.r);
    if (!t || t.n >= 0) return;
    t.n = f.n;
    t.heard = this.now();
    if (f.m && typeof f.m === "object" && !Array.isArray(f.m)) t.meta = f.m as Frame;
    t.got = new Uint8Array(Math.ceil(f.n / CHUNK_BYTES));
    t.bytes = new Uint8Array(f.n);
    if (f.n === 0) this.finish(t);
  }

  private onData(f: Frame): void {
    if (!isInt(f.r, 1) || !isInt(f.i, 0) || typeof f.b !== "string") return;
    const t = this.incoming.get(f.r);
    if (!t || !t.bytes || f.i >= t.got.length || t.got[f.i]) return;
    let chunk: Uint8Array;
    try {
      chunk = fromBase64(f.b);
    } catch {
      return;
    }
    const at = f.i * CHUNK_BYTES;
    const expected = Math.min(CHUNK_BYTES, t.n - at);
    if (chunk.length !== expected) return;
    t.bytes.set(chunk, at);
    t.got[f.i] = 1;
    t.have++;
    t.heard = this.now();
    this.received.push({ at: t.heard, bytes: chunk.length });
    while (t.contiguous < t.got.length && t.got[t.contiguous]) t.contiguous++;
    t.onProgress?.(Math.min(t.n, t.have * CHUNK_BYTES), t.n);
    if (t.have === t.got.length) {
      void this.enqueue({ t: "ack", r: t.r, i: t.contiguous }, true).catch(() => {});
      this.finish(t);
    } else if (f.a === 1 || t.contiguous - t.lastAck >= ACK_EVERY) {
      t.lastAck = t.contiguous;
      void this.enqueue({ t: "ack", r: t.r, i: t.contiguous }, true).catch(() => {});
    }
  }

  private finish(t: Incoming): void {
    this.incoming.delete(t.r);
    t.resolve({ ...(t.meta && { meta: t.meta }), bytes: t.bytes ?? new Uint8Array(0) });
  }

  private onAck(f: Frame): void {
    if (!isInt(f.r, 1) || !isInt(f.i, 0)) return;
    const o = this.outgoing.get(f.r);
    if (!o) return;
    o.acked = Math.max(o.acked, Math.min(f.i, o.next));
    o.heard = this.now();
    if (o.acked >= o.chunks) this.outgoing.delete(o.r);
    this.feed();
  }

  private onError(f: Frame): void {
    if (!isInt(f.r, 1) || typeof f.e !== "string") return;
    const t = this.incoming.get(f.r);
    if (!t) return;
    this.incoming.delete(f.r);
    t.reject(new LinkError(f.e.slice(0, 64)));
  }

  /** Ends transfers that heard nothing for `STALL_MS`, checked every few seconds while any is open. */
  private armStall(): void {
    if (this.stallTimer || this.closed) return;
    this.stallTimer = this.setTimer(() => {
      this.stallTimer = null;
      const old = this.now() - STALL_MS;
      for (const t of [...this.incoming.values()]) {
        if (t.heard < old) {
          this.incoming.delete(t.r);
          t.reject(new LinkError("stalled"));
        }
      }
      for (const o of [...this.outgoing.values()]) if (o.heard < old) this.dropOutgoing(o.r);
      if (this.incoming.size || this.outgoing.size) this.armStall();
      this.feed();
    }, 2000);
  }
}
