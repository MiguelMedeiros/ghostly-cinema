/**
 * The catalogue: what one side's library looks like to the contact. Titles, seasons and episodes, lengths, codecs,
 * audio and subtitle languages, which titles have a picture. No paths: where the files are on the person's disk
 * stays on their side.
 *
 * It arrives from the contact, so `readCatalogue` checks every field and drops what does not fit.
 */
import type { Entry, Library } from "./library.ts";

export interface CatSubtitle {
  id: string;
  /** BCP 47 language, when the file's name says one. */
  l?: string;
  f?: 1;
  h?: 1;
}

export interface CatItem {
  id: string;
  /** Film or episode. */
  k: "f" | "e";
  /** The film's title, or the episode's. */
  t: string;
  y?: number;
  /** Episodes: the show's id, season, episode, the last episode of a double one. */
  sh?: string;
  sn?: number;
  ep?: number;
  ee?: number;
  /** Seconds. */
  d?: number;
  /** Bytes. */
  z: number;
  /** The Media Source type with codecs, once the file was read. */
  m?: string;
  /** The audio tracks' languages, in order (`und` for none). */
  au?: string[];
  sb?: CatSubtitle[];
  /** It has a picture to ask for. */
  p?: 1;
  /** Why it cannot play: "convert" (not MP4), or what reading it found. */
  x?: string;
  w?: number;
  h?: number;
  /** When the file changed, in ms: "recently added". */
  at?: number;
}

export interface CatShow {
  id: string;
  t: string;
  y?: number;
  p?: 1;
}

export interface Catalogue {
  v: 1;
  /** Rises with every change; the contact asks again when it does. */
  rev: number;
  items: CatItem[];
  shows: CatShow[];
}

/** What reading a file found (`mp4.ts`), kept per entry. */
export interface Scan {
  d?: number;
  m?: string;
  au?: string[];
  w?: number;
  h?: number;
  x?: string;
  /** A picture was made for it. */
  p?: 1;
}

export const LIMITS = { items: 20_000, shows: 2_000, text: 200, subtitles: 32, audio: 16 };

export function itemOf(e: Entry, scan: Scan | undefined): CatItem {
  const v = e.video;
  const item: CatItem = { id: e.id, k: v.kind === "film" ? "f" : "e", t: v.kind === "film" ? v.title : (v.episodeTitle ?? ""), z: e.size, at: e.modified };
  if (v.kind === "film" && v.year) item.y = v.year;
  if (v.kind === "episode") {
    item.sh = e.showId;
    item.sn = v.season;
    item.ep = v.episode;
    if (v.episodeEnd) item.ee = v.episodeEnd;
  }
  if (!e.container) item.x = "convert";
  if (scan) {
    for (const key of ["d", "m", "au", "w", "h", "x", "p"] as const) if (scan[key] !== undefined) (item as unknown as Record<string, unknown>)[key] = scan[key];
  }
  if (e.subtitles.length) {
    item.sb = e.subtitles.slice(0, LIMITS.subtitles).map((s) => ({ id: s.id, ...(s.lang && { l: s.lang }), ...(s.forced && { f: 1 as const }), ...(s.sdh && { h: 1 as const }) }));
  }
  return item;
}

export function catalogueOf(lib: Library, scans: Record<string, Scan>, rev: number, showPictures: Record<string, boolean>): Catalogue {
  return {
    v: 1,
    rev,
    items: [...lib.films, ...lib.episodes].map((e) => itemOf(e, scans[e.id])),
    shows: lib.shows.map((s) => ({ id: s.id, t: s.title, ...(s.year && { y: s.year }), ...(showPictures[s.id] && { p: 1 as const }) })),
  };
}

const str = (v: unknown, max = LIMITS.text): v is string => typeof v === "string" && v.length <= max;
const id = (v: unknown): v is string => typeof v === "string" && /^[0-9a-z]{1,16}$/.test(v);
const int = (v: unknown, max = 1e9): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const num = (v: unknown, max = 1e9): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
const lang = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(v);
const MIME = /^video\/mp4; codecs="[A-Za-z0-9.\-, ]{1,120}"$/;

/** A catalogue from the contact, checked field by field; null when it is not one. */
export function readCatalogue(value: unknown): Catalogue | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (c.v !== 1 || !num(c.rev, Number.MAX_SAFE_INTEGER) || !Array.isArray(c.items) || !Array.isArray(c.shows)) return null;
  const shows: CatShow[] = [];
  const showIds = new Set<string>();
  for (const raw of c.shows.slice(0, LIMITS.shows)) {
    const s = raw as Record<string, unknown>;
    if (!s || !id(s.id) || !str(s.t) || showIds.has(s.id)) continue;
    showIds.add(s.id);
    shows.push({ id: s.id, t: s.t, ...(int(s.y, 3000) && { y: s.y }), ...(s.p === 1 && { p: 1 as const }) });
  }
  const items: CatItem[] = [];
  const ids = new Set<string>();
  for (const raw of c.items.slice(0, LIMITS.items)) {
    const i = raw as Record<string, unknown>;
    if (!i || !id(i.id) || ids.has(i.id) || (i.k !== "f" && i.k !== "e") || !str(i.t) || !num(i.z, Number.MAX_SAFE_INTEGER)) continue;
    const item: CatItem = { id: i.id, k: i.k, t: i.t, z: i.z };
    if (i.k === "e") {
      if (!id(i.sh) || !showIds.has(i.sh) || !int(i.sn, 999) || !int(i.ep, 9999)) continue;
      item.sh = i.sh;
      item.sn = i.sn;
      item.ep = i.ep;
      if (int(i.ee, 9999) && i.ee > i.ep) item.ee = i.ee;
    }
    if (int(i.y, 3000)) item.y = i.y;
    if (num(i.d, 1e6)) item.d = i.d;
    if (typeof i.m === "string" && MIME.test(i.m)) item.m = i.m;
    if (Array.isArray(i.au) && i.au.length <= LIMITS.audio && i.au.every((a) => typeof a === "string" && /^[a-z]{3}$/.test(a))) item.au = i.au as string[];
    if (Array.isArray(i.sb)) {
      const subs: CatSubtitle[] = [];
      for (const rs of i.sb.slice(0, LIMITS.subtitles)) {
        const s = rs as Record<string, unknown>;
        if (!s || !id(s.id)) continue;
        subs.push({ id: s.id, ...(lang(s.l) && { l: s.l }), ...(s.f === 1 && { f: 1 as const }), ...(s.h === 1 && { h: 1 as const }) });
      }
      if (subs.length) item.sb = subs;
    }
    if (i.p === 1) item.p = 1;
    if (typeof i.x === "string" && /^[a-z-]{1,24}$/.test(i.x)) item.x = i.x;
    if (int(i.w, 16384)) item.w = i.w;
    if (int(i.h, 16384)) item.h = i.h;
    if (num(i.at, Number.MAX_SAFE_INTEGER)) item.at = i.at;
    ids.add(i.id);
    items.push(item);
  }
  return { v: 1, rev: c.rev, items, shows };
}

/** A title as people read it: "Inception (2010)", "Dark · S1 E2 · Lies". */
export function displayTitle(item: CatItem, show?: CatShow): string {
  if (item.k === "f") return item.y ? `${item.t} (${item.y})` : item.t;
  const ep = `S${item.sn} E${item.ep}${item.ee ? `–${item.ee}` : ""}`;
  return [show?.t, ep, item.t].filter(Boolean).join(" · ");
}
