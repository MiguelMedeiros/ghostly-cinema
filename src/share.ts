/**
 * The side that shares: the folder the person picked, its library, what reading each file found, the pictures made
 * for it, and the answers to the contact's requests. The files themselves are `File` objects of this session only
 * (an app cannot keep them, WISP 1200 today): after a reload the library and its pictures are still here and the
 * contact still browses, but a film plays only once the folder is picked again.
 */
import { catalogueOf, type Catalogue, type Scan } from "./catalogue.ts";
import { buildLibrary, type Entry, type Library, type PickedFile } from "./library.ts";
import { LinkError, type Ask, type Reply } from "./link.ts";
import { blobReader } from "./media/bytes.ts";
import { buildSegment, indexMp4, initSegment, MediaError, mime, planSegment, syncBefore, type MediaIndex } from "./media/mp4.ts";
import { getLarge, putLarge } from "./store.ts";
import type { MiniAppApi } from "./vendor/miniApp.ts";

/** Makes the small JPEGs the library shows. Needs a page (canvas, video); tests give a stand-in. */
export interface PictureMaker {
  /** A picture file beside a title, made small. */
  fromImage(file: Blob): Promise<Uint8Array | null>;
  /** A frame of the video, a little way in. */
  fromVideo(file: Blob): Promise<Uint8Array | null>;
}

export interface Picked {
  path: string;
  file: Blob & { lastModified?: number };
}

export interface ScanProgress {
  done: number;
  total: number;
  /** What is being read now. */
  current?: string;
}

interface Stored {
  v: 1;
  rev: number;
  /** The picked folder's name. */
  folder: string;
  files: PickedFile[];
  scans: Record<string, Scan>;
  showPictures: Record<string, boolean>;
}

/** Bytes of pictures kept in this chat's storage for the library, of its 5 MiB. */
export const PICTURE_BUDGET = 2 * 1024 * 1024;
/** The most a picture may be: one storage value as base64. */
const PICTURE_MAX = 44 * 1024;
/** A subtitle file bigger than this is not a subtitle. */
const SUBTITLE_MAX = 4 * 1024 * 1024;
/** Segments of about this much video. */
export const SEGMENT_BYTES = 1024 * 1024;

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export class Share {
  private stored: Stored | null = null;
  private library: Library | null = null;
  private files = new Map<string, Blob>();
  private indexes = new Map<string, Promise<MediaIndex>>();
  private pictureBytes = 0;
  private sequence = 1;
  private scanning: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  progress: ScanProgress | null = null;

  constructor(
    private readonly api: MiniAppApi,
    private readonly pictures: PictureMaker,
    private readonly onChange: (rev: number) => void = () => {},
  ) {}

  /** Reads what was shared in this chat before. */
  async load(): Promise<void> {
    const value = (await getLarge(this.api, "mine")) as Stored | undefined;
    if (value && value.v === 1 && Array.isArray(value.files)) {
      this.stored = value;
      this.library = buildLibrary(value.files);
      const keys = await this.api.storage.keys();
      for (const key of keys.filter((k) => k.startsWith("pic:"))) {
        const v = await this.api.storage.get(key);
        if (typeof v === "string") this.pictureBytes += v.length;
      }
    }
  }

  get rev(): number {
    return this.stored?.rev ?? 0;
  }
  get folder(): string | undefined {
    return this.stored?.folder;
  }
  get lib(): Library | null {
    return this.library;
  }
  /** The files of this session are here: films play. */
  get linked(): boolean {
    return this.files.size > 0;
  }
  /** Whether this entry's file can be read now. */
  has(id: string): boolean {
    const e = this.entry(id);
    return !!e && this.files.has(e.path);
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const l of this.listeners) l();
  }

  catalogue(): Catalogue | null {
    if (!this.stored || !this.library) return null;
    return catalogueOf(this.library, this.stored.scans, this.stored.rev, this.stored.showPictures);
  }

  scan(id: string): Scan | undefined {
    return this.stored?.scans[id];
  }

  private entry(id: string): Entry | undefined {
    return this.library?.films.find((e) => e.id === id) ?? this.library?.episodes.find((e) => e.id === id);
  }

  /**
   * The person picked a folder (or files): the library is built again from it. What reading a file found is kept
   * for a file that did not change; new and changed files are read in the background.
   */
  async pick(picked: Picked[]): Promise<void> {
    const files: PickedFile[] = picked.map((p) => ({ path: p.path, size: p.file.size, modified: p.file.lastModified ?? 0 }));
    this.files = new Map(picked.map((p) => [p.path, p.file]));
    this.indexes.clear();
    const library = buildLibrary(files);
    const before = this.stored;
    const old = new Map((before?.files ?? []).map((f) => [f.path, f]));
    const scans: Record<string, Scan> = {};
    for (const e of [...library.films, ...library.episodes]) {
      const was = old.get(e.path);
      const scan = before?.scans[e.id];
      if (scan && was && was.size === e.size && was.modified === e.modified) scans[e.id] = scan;
    }
    const showPictures: Record<string, boolean> = {};
    for (const s of library.shows) if (before?.showPictures[s.id]) showPictures[s.id] = true;
    const folder = picked[0]?.path.split("/")[0] ?? "";
    this.library = library;
    this.stored = { v: 1, rev: Date.now(), folder, files, scans, showPictures };
    await this.save();
    this.changed();
    this.onChange(this.stored.rev);
    this.scanning = this.scanAll();
  }

  /** Waits for the reading of the files to end (tests). */
  async idle(): Promise<void> {
    while (this.scanning) {
      const s = this.scanning;
      await s;
      if (this.scanning === s) this.scanning = null;
    }
  }

  private async save(): Promise<void> {
    if (this.stored) await putLarge(this.api, "mine", this.stored as never);
  }

  private async scanAll(): Promise<void> {
    const lib = this.library;
    const stored = this.stored;
    if (!lib || !stored) return;
    const todo = [...lib.films, ...lib.episodes].filter((e) => !stored.scans[e.id]);
    const shows = lib.shows.filter((s) => !stored.showPictures[s.id]);
    this.progress = { done: 0, total: todo.length + shows.length };
    let dirty = 0;
    const step = async () => {
      this.progress!.done++;
      this.changed();
      if (++dirty >= 10) {
        dirty = 0;
        await this.save();
      }
    };
    // Films first, by title: what the contact sees first.
    for (const e of todo) {
      if (this.library !== lib) return;
      this.progress.current = e.video.kind === "film" ? e.video.title : `${e.video.show} S${e.video.season}E${e.video.episode}`;
      stored.scans[e.id] = await this.read(e);
      await step();
    }
    for (const s of shows) {
      if (this.library !== lib) return;
      this.progress.current = s.title;
      const poster = s.poster && this.files.get(s.poster);
      let bytes = poster ? await this.pictures.fromImage(poster).catch(() => null) : null;
      if (!bytes) {
        const first = lib.episodes.find((e) => e.showId === s.id && stored.scans[e.id]?.m);
        const file = first && this.files.get(first.path);
        if (file) bytes = await this.pictures.fromVideo(file).catch(() => null);
      }
      if (bytes && (await this.keepPicture(s.id, bytes))) stored.showPictures[s.id] = true;
      await step();
    }
    this.progress = null;
    stored.rev = Date.now();
    await this.save();
    this.changed();
    this.onChange(stored.rev);
  }

  /** Reads one file's moov, and makes its picture. */
  private async read(e: Entry): Promise<Scan> {
    const file = this.files.get(e.path);
    const scan: Scan = {};
    if (!file) return { x: "missing" };
    if (e.container) {
      try {
        const index = await indexMp4(blobReader(file));
        scan.d = Math.round(index.duration);
        scan.m = mime(index.video, index.audio[0]);
        if (index.audio.length) scan.au = index.audio.map((a) => a.language);
        scan.w = Math.round(index.video.width);
        scan.h = Math.round(index.video.height);
      } catch (error) {
        scan.x = error instanceof MediaError ? error.why : "damaged";
      }
    }
    const picture = e.picture && this.files.get(e.picture);
    let bytes = picture ? await this.pictures.fromImage(picture).catch(() => null) : null;
    if (!bytes && e.video.kind === "film" && scan.m) bytes = await this.pictures.fromVideo(file).catch(() => null);
    if (bytes && (await this.keepPicture(e.id, bytes))) scan.p = 1;
    return scan;
  }

  private async keepPicture(id: string, bytes: Uint8Array): Promise<boolean> {
    if (bytes.length > PICTURE_MAX) return false;
    const text = b64(bytes);
    if (this.pictureBytes + text.length > PICTURE_BUDGET) return false;
    try {
      await this.api.storage.set(`pic:${id}`, text);
      this.pictureBytes += text.length;
      return true;
    } catch {
      return false;
    }
  }

  async picture(id: string): Promise<Uint8Array | null> {
    const text = await this.api.storage.get(`pic:${id}`);
    return typeof text === "string" ? unb64(text) : null;
  }

  private index(e: Entry): Promise<MediaIndex> {
    let p = this.indexes.get(e.id);
    if (!p) {
      const file = this.files.get(e.path);
      if (!file) throw new LinkError("not-picked");
      p = indexMp4(blobReader(file));
      p.catch(() => this.indexes.delete(e.id));
      // Two films' tables at most: a long film's are a few MiB.
      if (this.indexes.size >= 2) this.indexes.delete(this.indexes.keys().next().value!);
      this.indexes.set(e.id, p);
    }
    return p;
  }

  /** Answers the contact's `get`. */
  async serve(ask: Ask): Promise<Reply> {
    if (!this.stored || !this.library) throw new LinkError("no-library");
    if (ask.k === "cat") return { bytes: new TextEncoder().encode(JSON.stringify(this.catalogue())) };
    if (!ask.id) throw new LinkError("bad-request");
    if (ask.k === "pic") {
      const bytes = await this.picture(ask.id);
      if (!bytes) throw new LinkError("not-found");
      return { bytes };
    }
    const e = this.entry(ask.id);
    if (!e) throw new LinkError("not-found");
    if (ask.k === "sub") {
      const sub = e.subtitles.find((s) => s.id === ask.s);
      if (!sub) throw new LinkError("not-found");
      const file = this.files.get(sub.path);
      if (!file) throw new LinkError("not-picked");
      if (file.size > SUBTITLE_MAX) throw new LinkError("too-large");
      return { bytes: new Uint8Array(await file.arrayBuffer()) };
    }
    if (!e.container) throw new LinkError("convert");
    if (!this.files.has(e.path)) throw new LinkError("not-picked");
    let index: MediaIndex;
    try {
      index = await this.index(e);
    } catch (error) {
      throw new LinkError(error instanceof MediaError ? error.why : error instanceof LinkError ? error.code : "failed");
    }
    const audio = index.audio[ask.a ?? 0] ?? index.audio[0];
    if (ask.k === "init") {
      return {
        meta: { m: mime(index.video, audio), d: index.duration, au: index.audio.map((a) => a.language), n: index.video.dts.length },
        bytes: initSegment(index, audio),
      };
    }
    // seg: from a sample (the stream goes on), or at a time (a seek or a resume).
    const n = index.video.dts.length;
    const from = ask.from ?? (ask.at !== undefined ? syncBefore(index.video, ask.at) : 0);
    if (from >= n) throw new LinkError("bad-request");
    const plan = planSegment(index, from, audio, SEGMENT_BYTES);
    const file = this.files.get(e.path)!;
    let bytes: Uint8Array;
    try {
      bytes = await buildSegment(blobReader(file), index, plan, audio, this.sequence++);
    } catch {
      throw new LinkError("damaged");
    }
    return { meta: { from: plan.from, to: plan.to, s: plan.start, e: plan.end, last: plan.to >= n }, bytes };
  }
}
