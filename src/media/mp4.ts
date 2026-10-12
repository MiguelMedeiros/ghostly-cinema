/**
 * MP4, M4V and MOV, on the side that has the file: find its `moov` with a few ranged reads (it is often at the end),
 * read the sample tables, and cut the film into fragmented MP4 on demand, so a Media Source player on the contact's
 * side can start anywhere. Nothing reads the whole file: a fragment reads only its samples' bytes.
 *
 * What it plays is what browsers' Media Source plays: H.264, HEVC (WebKit), AV1 and VP9 video; AAC, MP3, AC-3,
 * E-AC-3, Opus and FLAC audio. Whether the contact's browser takes a codec is the contact's to check
 * (`MediaSource.isTypeSupported` with `mime()`).
 */
import { type Box, children, child, fourcc, i32, path, type RangeReader, u16, u32, u64, Writer } from "./bytes.ts";

export type TrackKind = "video" | "audio";

export interface Track {
  id: number;
  kind: TrackKind;
  /** The RFC 6381 codec string, for `isTypeSupported` (`avc1.64001f`, `mp4a.40.2`). */
  codec: string;
  timescale: number;
  /** ISO 639-2 code from `mdhd` (`und` when absent). */
  language: string;
  /** The whole `stsd` box, copied into the init segment as it is. */
  stsd: Uint8Array;
  width: number;
  height: number;
  /** Per sample: where its bytes are, how many, its decode time and duration (in `timescale`), and the offset to presentation. */
  offsets: Float64Array;
  sizes: Uint32Array;
  dts: Float64Array;
  durations: Uint32Array;
  /** Composition offset with the edit list applied: presentation = dts + cts. May be negative. */
  cts: Int32Array;
  /** 1 when the sample is a random access point. */
  sync: Uint8Array;
}

export interface MediaIndex {
  /** Seconds. */
  duration: number;
  video: Track;
  audio: Track[];
  /** The `mime` for Media Source: `video/mp4; codecs="…"` for the video and one audio track. */
  brand: string;
}

/** Why a file cannot be played as it is. */
export type Unplayable = "not-mp4" | "no-moov" | "fragmented" | "no-video" | "encrypted" | "unknown-codec" | "damaged" | "too-large";

export class MediaError extends Error {
  constructor(readonly why: Unplayable) {
    super(why);
  }
}

/** The biggest `moov` we read: a three-hour film's tables are a few MiB. */
const MAX_MOOV = 64 * 1024 * 1024;

/** Where the top-level boxes of the file are, read 16 bytes at a time. */
export async function topLevel(reader: RangeReader): Promise<{ type: string; offset: number; size: number }[]> {
  const out: { type: string; offset: number; size: number }[] = [];
  let at = 0;
  while (at + 8 <= reader.size && out.length < 4096) {
    const head = await reader.read(at, 16);
    if (head.length < 8) break;
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    if (size === 1) {
      if (head.length < 16) break;
      size = u64(head, 8);
    } else if (size === 0) {
      size = reader.size - at;
    }
    if (size < 8) break;
    out.push({ type, offset: at, size });
    at += size;
  }
  return out;
}

/** Reads the file's `moov` and indexes it. */
export async function indexMp4(reader: RangeReader): Promise<MediaIndex> {
  const boxes = await topLevel(reader);
  if (!boxes.length || !["ftyp", "moov", "free", "skip", "wide", "mdat", "pdin", "uuid"].includes(boxes[0].type)) {
    throw new MediaError("not-mp4");
  }
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) throw new MediaError(boxes.some((b) => b.type === "moof") ? "fragmented" : "no-moov");
  if (moov.size > MAX_MOOV) throw new MediaError("too-large");
  const bytes = await reader.read(moov.offset, moov.size);
  if (bytes.length < moov.size) throw new MediaError("damaged");
  return parseMoov(bytes, reader.size);
}

/** Indexes a `moov` box held whole in `b`. `fileSize` bounds every sample. */
export function parseMoov(b: Uint8Array, fileSize = Number.MAX_SAFE_INTEGER): MediaIndex {
  const moov = children(b, 0, b.length).find((x) => x.type === "moov");
  if (!moov) throw new MediaError("no-moov");
  if (child(b, moov, "mvex")) throw new MediaError("fragmented");
  const mvhd = child(b, moov, "mvhd");
  if (!mvhd) throw new MediaError("damaged");
  const movieScale = b[mvhd.body] === 1 ? u32(b, mvhd.body + 20) : u32(b, mvhd.body + 12);
  const movieDuration = b[mvhd.body] === 1 ? u64(b, mvhd.body + 24) : u32(b, mvhd.body + 16);
  const tracks: Track[] = [];
  let encrypted = false;
  let unknown = false;
  for (const trak of children(b, moov.body, moov.end).filter((x) => x.type === "trak")) {
    try {
      const track = parseTrak(b, trak, movieScale, fileSize);
      if (track) tracks.push(track);
    } catch (error) {
      if (error instanceof MediaError && error.why === "encrypted") encrypted = true;
      else if (error instanceof MediaError && error.why === "unknown-codec") unknown = true;
      else throw error;
    }
  }
  const video = tracks.find((t) => t.kind === "video");
  if (!video) throw new MediaError(encrypted ? "encrypted" : unknown ? "unknown-codec" : "no-video");
  const audio = tracks.filter((t) => t.kind === "audio");
  const seconds = movieScale ? movieDuration / movieScale : 0;
  const duration = seconds > 0 ? seconds : trackSeconds(video);
  return { duration, video, audio, brand: mime(video, audio[0]) };
}

/** The Media Source type for a video track and, optionally, one audio track. */
export function mime(video: Pick<Track, "codec">, audio?: Pick<Track, "codec">): string {
  return `video/mp4; codecs="${[video.codec, audio?.codec].filter(Boolean).join(", ")}"`;
}

function trackSeconds(t: Track): number {
  const n = t.dts.length;
  return n ? (t.dts[n - 1] + t.durations[n - 1]) / t.timescale : 0;
}

function parseTrak(b: Uint8Array, trak: Box, movieScale: number, fileSize: number): Track | null {
  const tkhd = child(b, trak, "tkhd");
  const mdhd = path(b, trak, "mdia", "mdhd");
  const hdlr = path(b, trak, "mdia", "hdlr");
  const stbl = path(b, trak, "mdia", "minf", "stbl");
  if (!tkhd || !mdhd || !hdlr || !stbl) return null;
  const handler = fourcc(b, hdlr.body + 8);
  const kind: TrackKind | null = handler === "vide" ? "video" : handler === "soun" ? "audio" : null;
  if (!kind) return null;
  const id = b[tkhd.body] === 1 ? u32(b, tkhd.body + 20) : u32(b, tkhd.body + 12);
  // tkhd flags: 1 = enabled. A disabled track is kept only when it is the one of its kind.
  const timescale = b[mdhd.body] === 1 ? u32(b, mdhd.body + 20) : u32(b, mdhd.body + 12);
  if (!timescale) throw new MediaError("damaged");
  const langBits = u16(b, mdhd.body + (b[mdhd.body] === 1 ? 32 : 20));
  const language = langBits
    ? String.fromCharCode(((langBits >> 10) & 31) + 0x60, ((langBits >> 5) & 31) + 0x60, (langBits & 31) + 0x60)
    : "und";
  const tkhdEnd = tkhd.end;
  const width = u32(b, tkhdEnd - 8) / 65536;
  const height = u32(b, tkhdEnd - 4) / 65536;

  const stsd = child(b, stbl, "stsd");
  if (!stsd) throw new MediaError("damaged");
  const entry = children(b, stsd.body + 8, stsd.end)[0];
  if (!entry) throw new MediaError("damaged");
  if (entry.type === "encv" || entry.type === "enca") throw new MediaError("encrypted");
  const codec = codecString(b, entry, kind);
  if (!codec) throw new MediaError("unknown-codec");

  // Sample tables.
  const stts = child(b, stbl, "stts");
  const stsc = child(b, stbl, "stsc");
  const stsz = child(b, stbl, "stsz") ?? child(b, stbl, "stz2");
  const stco = child(b, stbl, "stco") ?? child(b, stbl, "co64");
  if (!stts || !stsc || !stsz || !stco) throw new MediaError("damaged");
  const sizes = readSizes(b, stsz);
  const n = sizes.length;
  const dts = new Float64Array(n);
  const durations = new Uint32Array(n);
  {
    const count = u32(b, stts.body + 4);
    let s = 0;
    let t = 0;
    for (let e = 0; e < count && s < n; e++) {
      const run = u32(b, stts.body + 8 + e * 8);
      const delta = u32(b, stts.body + 12 + e * 8);
      for (let k = 0; k < run && s < n; k++, s++) {
        dts[s] = t;
        durations[s] = delta;
        t += delta;
      }
    }
    if (s < n) throw new MediaError("damaged");
  }
  const cts = new Int32Array(n);
  const ctts = child(b, stbl, "ctts");
  if (ctts) {
    const signed = b[ctts.body] === 1;
    const count = u32(b, ctts.body + 4);
    let s = 0;
    for (let e = 0; e < count && s < n; e++) {
      const run = u32(b, ctts.body + 8 + e * 8);
      const off = signed ? i32(b, ctts.body + 12 + e * 8) : u32(b, ctts.body + 12 + e * 8);
      for (let k = 0; k < run && s < n; k++, s++) cts[s] = off;
    }
  }
  const sync = new Uint8Array(n);
  const stss = child(b, stbl, "stss");
  if (stss && kind === "video") {
    const count = u32(b, stss.body + 4);
    for (let e = 0; e < count; e++) {
      const k = u32(b, stss.body + 8 + e * 4) - 1;
      if (k >= 0 && k < n) sync[k] = 1;
    }
    if (n) sync[0] = 1;
  } else {
    sync.fill(1);
  }
  const offsets = new Float64Array(n);
  {
    const co64 = stco.type === "co64";
    const chunks = u32(b, stco.body + 4);
    const chunkOffset = (c: number) => (co64 ? u64(b, stco.body + 8 + c * 8) : u32(b, stco.body + 8 + c * 4));
    const entries = u32(b, stsc.body + 4);
    let s = 0;
    for (let e = 0; e < entries; e++) {
      const first = u32(b, stsc.body + 8 + e * 12) - 1;
      const per = u32(b, stsc.body + 12 + e * 12);
      const last = e + 1 < entries ? u32(b, stsc.body + 8 + (e + 1) * 12) - 1 : chunks;
      for (let c = first; c < last && c < chunks && s < n; c++) {
        let at = chunkOffset(c);
        for (let k = 0; k < per && s < n; k++, s++) {
          offsets[s] = at;
          at += sizes[s];
        }
      }
    }
    if (s < n) throw new MediaError("damaged");
  }
  for (let s = 0; s < n; s++) if (offsets[s] + sizes[s] > fileSize) throw new MediaError("damaged");

  // The edit list: where the media starts (`media_time`) and any empty time first. Applied to the composition
  // offsets, so presentation starts where the file says (B-frame delay, audio priming).
  const elst = path(b, trak, "edts", "elst");
  let shift = 0;
  if (elst) {
    const v1 = b[elst.body] === 1;
    const count = u32(b, elst.body + 4);
    let at = elst.body + 8;
    let empty = 0;
    for (let e = 0; e < count; e++, at += v1 ? 20 : 12) {
      const segDuration = v1 ? u64(b, at) : u32(b, at);
      const mediaTime = v1 ? u64(b, at + 8) : i32(b, at + 4);
      if (mediaTime === -1 || (!v1 && mediaTime < 0) || (v1 && u32(b, at + 8) === 0xffffffff)) {
        empty += movieScale ? (segDuration / movieScale) * timescale : 0;
        continue;
      }
      shift = Math.round(empty) - mediaTime;
      break;
    }
  }
  if (shift) for (let s = 0; s < n; s++) cts[s] += shift;
  return { id, kind, codec, timescale, language, stsd: b.slice(stsd.start, stsd.end), width, height, offsets, sizes, dts, durations, cts, sync };
}

function readSizes(b: Uint8Array, box: Box): Uint32Array {
  if (box.type === "stsz") {
    const fixed = u32(b, box.body + 4);
    const n = u32(b, box.body + 8);
    if (n > (box.end - box.body) * 8) throw new MediaError("damaged");
    const sizes = new Uint32Array(n);
    if (fixed) sizes.fill(fixed);
    else for (let s = 0; s < n; s++) sizes[s] = u32(b, box.body + 12 + s * 4);
    return sizes;
  }
  // stz2
  const field = b[box.body + 7];
  const n = u32(b, box.body + 8);
  const sizes = new Uint32Array(n);
  for (let s = 0; s < n; s++) {
    if (field === 4) sizes[s] = (b[box.body + 12 + (s >> 1)] >> (s & 1 ? 0 : 4)) & 15;
    else if (field === 8) sizes[s] = b[box.body + 12 + s];
    else sizes[s] = u16(b, box.body + 12 + s * 2);
  }
  return sizes;
}

const hex2 = (v: number) => v.toString(16).padStart(2, "0");

/** The codec string of a sample entry, or null for one Media Source cannot take. */
export function codecString(b: Uint8Array, entry: Box, kind: TrackKind): string | null {
  const type = entry.type;
  if (kind === "video") {
    const kids = { body: entry.body + 78, end: entry.end };
    if (type === "avc1" || type === "avc3") {
      const avcC = child(b, kids, "avcC");
      if (!avcC) return null;
      return `${type}.${hex2(b[avcC.body + 1])}${hex2(b[avcC.body + 2])}${hex2(b[avcC.body + 3])}`;
    }
    if (type === "hvc1" || type === "hev1") {
      const hvcC = child(b, kids, "hvcC");
      if (!hvcC) return null;
      const p = hvcC.body;
      const space = ["", "A", "B", "C"][b[p + 1] >> 6];
      const tier = b[p + 1] & 0x20 ? "H" : "L";
      const profile = b[p + 1] & 0x1f;
      let compat = u32(b, p + 2);
      let reversed = 0;
      for (let i = 0; i < 32; i++) {
        reversed = (reversed << 1) | (compat & 1);
        compat >>>= 1;
      }
      const level = b[p + 12];
      const constraints = [...b.subarray(p + 6, p + 12)];
      while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
      return [`${type}.${space}${profile}`, (reversed >>> 0).toString(16), `${tier}${level}`, ...constraints.map((c) => c.toString(16))].join(".");
    }
    if (type === "av01") {
      const av1C = child(b, kids, "av1C");
      if (!av1C) return "av01.0.08M.08";
      const p = av1C.body;
      const profile = b[p + 1] >> 5;
      const level = b[p + 1] & 0x1f;
      const tier = b[p + 2] & 0x80 ? "H" : "M";
      const high = b[p + 2] & 0x40;
      const twelve = b[p + 2] & 0x20;
      const depth = high ? (twelve ? 12 : 10) : 8;
      return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(depth).padStart(2, "0")}`;
    }
    if (type === "vp09") {
      const vpcC = child(b, kids, "vpcC");
      if (!vpcC) return null;
      const p = vpcC.body + 4;
      return `vp09.${String(b[p]).padStart(2, "0")}.${String(b[p + 1]).padStart(2, "0")}.${String(b[p + 2] >> 4).padStart(2, "0")}`;
    }
    return null;
  }
  // Audio: QuickTime sound entries of version 1 and 2 carry more fields before their children.
  const version = u16(b, entry.body + 8);
  const kids = { body: entry.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), end: entry.end };
  if (type === "mp4a") {
    const esds = child(b, kids, "esds") ?? path(b, kids, "wave", "esds");
    if (!esds) return "mp4a.40.2";
    return esdsCodec(b, esds.body + 4, esds.end);
  }
  if (type === "ac-3") return "ac-3";
  if (type === "ec-3") return "ec-3";
  if (type === "Opus") return "opus";
  if (type === "fLaC") return "flac";
  if (type === ".mp3") return "mp4a.6b";
  return null;
}

/** `mp4a.<object type>[.<audio object type>]` from an ES descriptor. */
function esdsCodec(b: Uint8Array, from: number, to: number): string {
  let at = from;
  const desc = () => {
    const tag = b[at++];
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const c = b[at++];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { tag, len, body: at };
  };
  if (at >= to) return "mp4a.40.2";
  const es = desc();
  if (es.tag !== 3) return "mp4a.40.2";
  const flags = b[at + 2];
  at += 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + b[at];
  if (flags & 0x20) at += 2;
  const dc = desc();
  if (dc.tag !== 4) return "mp4a.40.2";
  const oti = b[at];
  at = dc.body + 13;
  if (oti !== 0x40) return `mp4a.${hex2(oti)}`;
  if (at < to && b[at] === 5) {
    const dsi = desc();
    let aot = b[dsi.body] >> 3;
    if (aot === 31) aot = 32 + (((b[dsi.body] & 7) << 3) | (b[dsi.body + 1] >> 5));
    return `mp4a.40.${aot}`;
  }
  return "mp4a.40.2";
}

/** The fragmented MP4 init segment for the video track and one audio track. */
export function initSegment(index: MediaIndex, audio?: Track): Uint8Array {
  const w = new Writer();
  w.box("ftyp").type("isom").u32(0x200).type("isom").type("iso6").type("mp41").end();
  w.box("moov");
  w.box("mvhd", { version: 0, flags: 0 }).u32(0).u32(0).u32(1000).u32(0).u32(0x00010000).u16(0x0100).zeros(10);
  matrix(w);
  const tracks = [index.video, ...(audio ? [audio] : [])];
  w.zeros(24).u32(Math.max(...tracks.map((t) => t.id)) + 1).end();
  for (const t of tracks) {
    w.box("trak");
    w.box("tkhd", { version: 0, flags: 3 }).u32(0).u32(0).u32(t.id).u32(0).u32(0).zeros(8).u16(0).u16(0);
    w.u16(t.kind === "audio" ? 0x0100 : 0).u16(0);
    matrix(w);
    w.u32(Math.round(t.width * 65536)).u32(Math.round(t.height * 65536)).end();
    w.box("mdia");
    w.box("mdhd", { version: 0, flags: 0 }).u32(0).u32(0).u32(t.timescale).u32(0);
    const lang = /^[a-z]{3}$/.test(t.language) ? t.language : "und";
    w.u16(((lang.charCodeAt(0) - 0x60) << 10) | ((lang.charCodeAt(1) - 0x60) << 5) | (lang.charCodeAt(2) - 0x60)).u16(0).end();
    w.box("hdlr", { version: 0, flags: 0 }).u32(0).type(t.kind === "video" ? "vide" : "soun").zeros(12).u8(0).end();
    w.box("minf");
    if (t.kind === "video") w.box("vmhd", { version: 0, flags: 1 }).zeros(8).end();
    else w.box("smhd", { version: 0, flags: 0 }).zeros(4).end();
    w.box("dinf").box("dref", { version: 0, flags: 0 }).u32(1).box("url ", { version: 0, flags: 1 }).end().end().end();
    w.box("stbl");
    w.bytes(t.stsd);
    w.box("stts", { version: 0, flags: 0 }).u32(0).end();
    w.box("stsc", { version: 0, flags: 0 }).u32(0).end();
    w.box("stsz", { version: 0, flags: 0 }).u32(0).u32(0).end();
    w.box("stco", { version: 0, flags: 0 }).u32(0).end();
    w.end().end().end().end(); // stbl, minf, mdia, trak
  }
  w.box("mvex");
  for (const t of tracks) w.box("trex", { version: 0, flags: 0 }).u32(t.id).u32(1).u32(0).u32(0).u32(0).end();
  w.end().end(); // mvex, moov
  return w.done();
}

function matrix(w: Writer): void {
  for (const v of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]) w.u32(v);
}

/** One piece of the film to send: which samples of each track, from which video sample to which. */
export interface SegmentPlan {
  /** First video sample, and the one after the last. */
  from: number;
  to: number;
  /** Audio samples, first and one after the last. */
  audioFrom: number;
  audioTo: number;
  /** Seconds the video samples cover, by decode time. */
  start: number;
  end: number;
}

/** The last random access point at or before `seconds`. */
export function syncBefore(track: Track, seconds: number): number {
  const target = seconds * track.timescale;
  let lo = 0;
  let hi = track.dts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track.dts[mid] + track.cts[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 0 && !track.sync[lo]) lo--;
  return lo;
}

function firstAtOrAfter(track: Track, seconds: number): number {
  const target = seconds * track.timescale;
  let lo = 0;
  let hi = track.dts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track.dts[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The segment that starts at video sample `from` and holds about `targetBytes` (at least one sample, never past
 * the end). A segment that ends just before a random access point ends there when it is close, so a seek and the
 * steady stream cut the film in the same places.
 */
export function planSegment(index: MediaIndex, from: number, audio: Track | undefined, targetBytes = 1536 * 1024): SegmentPlan {
  const v = index.video;
  const n = v.dts.length;
  if (from < 0 || from >= n) throw new RangeError("from");
  let to = from;
  let bytes = 0;
  while (to < n && (to === from || bytes < targetBytes)) bytes += v.sizes[to++];
  // Prefer to end on a random access point within 25% more bytes.
  if (to < n && !v.sync[to]) {
    let extra = 0;
    for (let k = to; k < n && extra < targetBytes / 4; k++) {
      if (v.sync[k]) {
        to = k;
        break;
      }
      extra += v.sizes[k];
    }
  }
  const start = from === 0 ? -Infinity : v.dts[from] / v.timescale;
  const end = to >= n ? Infinity : v.dts[to] / v.timescale;
  let audioFrom = 0;
  let audioTo = 0;
  if (audio) {
    audioFrom = start === -Infinity ? 0 : firstAtOrAfter(audio, start);
    audioTo = end === Infinity ? audio.dts.length : firstAtOrAfter(audio, end);
  }
  return { from, to, audioFrom, audioTo, start: Math.max(0, start), end: Math.min(index.duration, end) };
}

const SYNC_FLAGS = 0x02000000;
const NON_SYNC_FLAGS = 0x01010000;

/** Reads a segment's samples and writes them as `moof` + `mdat`. `sequence` numbers fragments from 1. */
export async function buildSegment(reader: RangeReader, index: MediaIndex, plan: SegmentPlan, audio: Track | undefined, sequence: number): Promise<Uint8Array> {
  const parts: { track: Track; from: number; to: number }[] = [{ track: index.video, from: plan.from, to: plan.to }];
  if (audio && plan.audioTo > plan.audioFrom) parts.push({ track: audio, from: plan.audioFrom, to: plan.audioTo });

  // Sample bytes, read in runs of nearby samples.
  const wanted: { offset: number; size: number; part: number; k: number }[] = [];
  parts.forEach((p, i) => {
    for (let k = p.from; k < p.to; k++) wanted.push({ offset: p.track.offsets[k], size: p.track.sizes[k], part: i, k });
  });
  const total = wanted.reduce((s, x) => s + x.size, 0);
  const data = parts.map((p) => new Array<Uint8Array>(p.to - p.from));
  const sorted = [...wanted].sort((a, b) => a.offset - b.offset);
  const GAP = 256 * 1024;
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    let end = sorted[i].offset + sorted[i].size;
    while (j < sorted.length && sorted[j].offset - end <= GAP && sorted[j].offset + sorted[j].size - sorted[i].offset <= 16 * 1024 * 1024) {
      end = Math.max(end, sorted[j].offset + sorted[j].size);
      j++;
    }
    const run = await reader.read(sorted[i].offset, end - sorted[i].offset);
    if (run.length < end - sorted[i].offset) throw new MediaError("damaged");
    for (let k = i; k < j; k++) {
      const s = sorted[k];
      data[s.part][s.k - parts[s.part].from] = run.subarray(s.offset - sorted[i].offset, s.offset - sorted[i].offset + s.size);
    }
    i = j;
  }

  const w = new Writer();
  w.box("moof");
  w.box("mfhd", { version: 0, flags: 0 }).u32(sequence).end();
  const dataOffsetFields: number[] = [];
  for (const p of parts) {
    const t = p.track;
    w.box("traf");
    w.box("tfhd", { version: 0, flags: 0x020000 }).u32(t.id).end();
    w.box("tfdt", { version: 1, flags: 0 }).u64(t.dts[p.from]).end();
    w.box("trun", { version: 1, flags: 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800 }).u32(p.to - p.from);
    dataOffsetFields.push(w.length);
    w.u32(0);
    for (let k = p.from; k < p.to; k++) {
      w.u32(t.durations[k]).u32(t.sizes[k]).u32(t.sync[k] ? SYNC_FLAGS : NON_SYNC_FLAGS).i32(t.cts[k]);
    }
    w.end().end(); // trun, traf
  }
  w.end(); // moof
  const moofSize = w.length;
  if (total + 8 > 0xffffffff) throw new MediaError("too-large");
  w.u32(total + 8).type("mdat");
  let at = moofSize + 8;
  parts.forEach((p, i) => {
    w.patch32(dataOffsetFields[i], at);
    for (const sample of data[i]) {
      w.bytes(sample);
      at += sample.length;
    }
  });
  return w.done();
}

export type { Box };
