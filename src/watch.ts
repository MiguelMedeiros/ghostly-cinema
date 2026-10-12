/**
 * The side that watches: the contact's catalogue, kept in this chat's storage so it shows while the contact is away,
 * the pictures asked for and kept, and where each title was left.
 */
import { readCatalogue, type CatItem, type Catalogue } from "./catalogue.ts";
import { type Link } from "./link.ts";
import { getLarge, putLarge } from "./store.ts";
import type { MiniAppApi } from "./vendor/miniApp.ts";

/** Where a title was left: seconds in, its length, when. */
export interface Position {
  t: number;
  d: number;
  at: number;
}

/** Bytes of the contact's pictures kept here, of the chat's 5 MiB. */
export const THEIR_PICTURES_BUDGET = 2 * 1024 * 1024;
/** Watched to here, a title counts as seen: the credits. */
export const SEEN_AT = 0.94;

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export class Watch {
  catalogue: Catalogue | null = null;
  positions = new Map<string, Position>();
  private pictures = new Map<string, Promise<string | null>>();
  private pictureKeys: { key: string; size: number }[] = [];
  private fetching: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly api: MiniAppApi,
    private readonly link: Link,
  ) {}

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const l of this.listeners) l();
  }

  async load(): Promise<void> {
    this.catalogue = readCatalogue(await getLarge(this.api, "theirs"));
    for (const key of await this.api.storage.keys()) {
      if (key.startsWith("pos:")) {
        const v = await this.api.storage.get(key);
        if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number")) {
          this.positions.set(key.slice(4), { t: v[0] as number, d: v[1] as number, at: v[2] as number });
        }
      } else if (key.startsWith("tp:")) {
        const v = await this.api.storage.get(key);
        if (typeof v === "string") this.pictureKeys.push({ key, size: v.length });
      }
    }
  }

  /** The contact said its library's revision: ask for the catalogue when it is not the one kept. */
  heard(rev: number): Promise<void> {
    if (!rev) {
      if (this.catalogue) {
        this.catalogue = null;
        this.changed();
      }
      return Promise.resolve();
    }
    if (this.catalogue?.rev === rev) return Promise.resolve();
    this.fetching ??= this.fetch().finally(() => (this.fetching = null));
    return this.fetching;
  }

  private async fetch(): Promise<void> {
    const reply = await this.link.request({ k: "cat" });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(reply.bytes));
    } catch {
      return;
    }
    const cat = readCatalogue(value);
    if (!cat) return;
    // A picture of a title that changed is asked again.
    const before = new Map((this.catalogue?.items ?? []).map((i) => [i.id, i]));
    for (const i of cat.items) if (before.get(i.id) && before.get(i.id)!.at !== i.at) this.pictures.delete(i.id);
    this.catalogue = cat;
    this.changed();
    await putLarge(this.api, "theirs", cat as never).catch(() => {});
  }

  item(id: string): CatItem | undefined {
    return this.catalogue?.items.find((i) => i.id === id);
  }

  /** A title's (or show's) picture as a `data:` URL, from storage or asked for; null when it has none. */
  picture(id: string): Promise<string | null> {
    let p = this.pictures.get(id);
    if (!p) {
      p = this.loadPicture(id);
      this.pictures.set(id, p);
      p.then((v) => v === null && this.pictures.delete(id)).catch(() => this.pictures.delete(id));
    }
    return p;
  }

  private async loadPicture(id: string): Promise<string | null> {
    const kept = await this.api.storage.get(`tp:${id}`);
    if (typeof kept === "string") return `data:image/jpeg;base64,${kept}`;
    if (!this.link.open) return null;
    try {
      const reply = await this.link.request({ k: "pic", id });
      const text = b64(reply.bytes);
      await this.keep(`tp:${id}`, text);
      return `data:image/jpeg;base64,${text}`;
    } catch {
      return null;
    }
  }

  /** Keeps a picture, letting the oldest go past the budget. */
  private async keep(key: string, text: string): Promise<void> {
    let total = this.pictureKeys.reduce((s, k) => s + k.size, 0);
    while (total + text.length > THEIR_PICTURES_BUDGET && this.pictureKeys.length) {
      const old = this.pictureKeys.shift()!;
      total -= old.size;
      await this.api.storage.delete(old.key).catch(() => {});
    }
    try {
      await this.api.storage.set(key, text);
      this.pictureKeys.push({ key, size: text.length });
    } catch {
      /* full: shown as a title card */
    }
  }

  async savePosition(id: string, t: number, d: number): Promise<void> {
    const pos = { t: Math.round(t * 10) / 10, d: Math.round(d), at: Date.now() };
    this.positions.set(id, pos);
    await this.api.storage.set(`pos:${id}`, [pos.t, pos.d, pos.at]).catch(() => {});
  }

  /** Where to start a title: where it was left, unless it was watched to the end. */
  resumeAt(id: string): number {
    const p = this.positions.get(id);
    if (!p || p.t < 10 || (p.d && p.t / p.d >= SEEN_AT)) return 0;
    return p.t;
  }

  /** Titles started and not finished, the most recent first. */
  continueWatching(): CatItem[] {
    const items = this.catalogue?.items ?? [];
    return [...this.positions]
      .filter(([id, p]) => p.t >= 10 && !(p.d && p.t / p.d >= SEEN_AT) && items.some((i) => i.id === id))
      .sort((a, b) => b[1].at - a[1].at)
      .map(([id]) => items.find((i) => i.id === id)!);
  }

  /** The next episode after this one in its show, for "Next episode". */
  nextEpisode(id: string): CatItem | undefined {
    const item = this.item(id);
    if (!item || item.k !== "e") return undefined;
    const eps = (this.catalogue?.items ?? []).filter((i) => i.k === "e" && i.sh === item.sh).sort((a, b) => a.sn! - b.sn! || a.ep! - b.ep!);
    return eps[eps.indexOf(item) + 1];
  }
}
