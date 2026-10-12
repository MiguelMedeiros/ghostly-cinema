/**
 * A stand-in for the client's broker, with the WISP's rules: storage per app and per chat with its limits, and
 * `chat.send` only while both sides have the app open, delivered in order and asynchronously, as a copy. Like the
 * real one, it refuses more than 48 frames a second (`too-fast`), and it can play a channel with a small send budget
 * that answers `offline` when full, as Iroh and HyperDHT do in a browser.
 */
import { MINI_APP_LIMITS, type MiniAppApi, type MiniAppContext, type MiniAppJson, type MiniAppPeerEvent } from "../src/vendor/miniApp.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Strict JSON, as the client's broker takes it. */
export function strictJson(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(strictJson);
  if (typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.values(value).every(strictJson);
}

export interface ChannelOptions {
  /** Delay before a frame reaches the other side, in ms. */
  latencyMs?: number;
  /** Bytes the channel holds before `chat.send` answers `offline` (Iroh in a browser: 120 KiB). */
  budgetBytes?: number;
  /** How long `chat.send` takes to answer, as a round trip to the client does. */
  sendDelayMs?: number;
}

export class MockBroker implements MiniAppApi {
  readonly stored = new Map<string, string>();
  /** Every value this side sent, as sent, with when. */
  readonly sent: { at: number; value: MiniAppJson }[] = [];
  /** `chat.send` calls refused, by code. */
  readonly refused = new Map<string, number>();
  peer: MockBroker | null = null;
  isOpen = false;
  displayName: string | undefined;
  channel: ChannelOptions = {};
  private queued = 0;
  private messageListeners = new Set<(data: MiniAppJson) => void>();
  private peerListeners = new Set<(peer: MiniAppPeerEvent) => void>();
  private incoming: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    public version = "0.1.0",
    readonly inChat = true,
  ) {}

  async context(): Promise<MiniAppContext> {
    const context: MiniAppContext = { version: this.version, inChat: this.inChat, peer: this.peer?.isOpen ? { version: this.peer.version } : null, theme: "dark", locale: "en" };
    if (this.displayName !== undefined) context.name = this.displayName;
    return context;
  }

  async file(): Promise<ArrayBuffer> {
    throw new Error("no-file");
  }

  storage = {
    get: async (key: string): Promise<MiniAppJson | undefined> => {
      const text = this.stored.get(key);
      return text === undefined ? undefined : (JSON.parse(text) as MiniAppJson);
    },
    set: async (key: string, value: MiniAppJson): Promise<void> => {
      if (new TextEncoder().encode(key).length > MINI_APP_LIMITS.storageKeyBytes) throw new Error("bad-key");
      if (!strictJson(value)) throw new Error("bad-request");
      const text = JSON.stringify(value);
      if (bytes(value) > MINI_APP_LIMITS.storageValueBytes) throw new Error("too-large");
      const row = (k: string, v: string) => new TextEncoder().encode(k).length + new TextEncoder().encode(v).length + MINI_APP_LIMITS.storageRowBytes;
      const total = [...this.stored].reduce((n, [k, v]) => (k === key ? n : n + row(k, v)), row(key, text));
      if (total > MINI_APP_LIMITS.storageScopeBytes) throw new Error("full");
      this.stored.set(key, text);
    },
    delete: async (key: string): Promise<void> => {
      this.stored.delete(key);
    },
    keys: async (): Promise<string[]> => [...this.stored.keys()],
  };

  chat = {
    send: async (value: MiniAppJson): Promise<void> => {
      const refuse = (code: string) => {
        this.refused.set(code, (this.refused.get(code) ?? 0) + 1);
        throw new Error(code);
      };
      if (this.channel.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, this.channel.sendDelayMs));
      const peer = this.peer;
      if (!this.isOpen) refuse("not-open");
      if (!peer?.isOpen) refuse("peer-closed");
      if (!strictJson(value)) refuse("bad-request");
      const size = bytes(value);
      if (size > MINI_APP_LIMITS.chatDataBytes) refuse("too-large");
      const now = Date.now();
      if (this.sent.filter((s) => s.at > now - 1000).length >= 48) refuse("too-fast");
      if (this.channel.budgetBytes !== undefined && this.queued + size > this.channel.budgetBytes) refuse("offline");
      this.sent.push({ at: now, value });
      this.queued += size;
      peer!.deliver(JSON.parse(JSON.stringify(value)) as MiniAppJson, this.channel.latencyMs ?? 0, () => (this.queued -= size));
    },
    on: ((event: "message" | "peer", listener: (data: never) => void) => {
      const set = (event === "message" ? this.messageListeners : this.peerListeners) as Set<(data: never) => void>;
      set.add(listener);
      return () => set.delete(listener);
    }) as MiniAppApi["chat"]["on"],
  };

  async close(): Promise<void> {
    this.shutdown();
  }

  launch(): void {
    this.isOpen = true;
    this.peer?.emitPeer({ open: true, version: this.version });
  }

  shutdown(): void {
    this.isOpen = false;
    this.messageListeners.clear();
    this.peerListeners.clear();
    this.peer?.emitPeer({ open: false });
  }

  /** A frame from the peer's side, as the broker would hand it over: for injecting what a hostile peer sends. */
  inject(value: unknown): void {
    this.deliver(value as MiniAppJson, 0, () => {});
  }

  private deliver(value: MiniAppJson, latencyMs: number, drained: () => void): void {
    this.incoming = this.incoming.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      drained();
      if (!this.isOpen) return;
      for (const listener of [...this.messageListeners]) listener(value);
    });
  }

  emitPeer(event: MiniAppPeerEvent): void {
    if (!this.isOpen) return;
    this.incoming = this.incoming.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.isOpen) return;
      for (const listener of [...this.peerListeners]) listener(event);
    });
  }
}

/** Two sides of one chat. */
export function chatPair(): [MockBroker, MockBroker] {
  const a = new MockBroker("miguel");
  const b = new MockBroker("ana");
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** The most frames sent in any one second. */
export function peakPerSecond(sent: { at: number }[]): number {
  let peak = 0;
  for (let i = 0, j = 0; i < sent.length; i++) {
    while (sent[i].at - sent[j].at >= 1000) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return peak;
}
