/**
 * The player on the watching side: Media Source fed with the fragments the other side cuts on demand. It keeps
 * about `AHEAD` seconds ahead of the playhead, and on a seek outside what it holds it drops the request under way and
 * asks for the fragment at the new time.
 *
 * Attaching Media Source in the app's sandbox (an opaque origin, `media-src data: blob:`) differs by engine, as
 * measured: Chromium takes `URL.createObjectURL(mediaSource)` and refuses `srcObject`; WebKit refuses that
 * `blob:null/…` URL and takes `video.srcObject = mediaSource`. So `srcObject` first, the URL when it throws.
 */
import type { CatSubtitle } from "./catalogue.ts";
import { LinkError, type Link } from "./link.ts";
import { decodeText, parseSubtitles } from "./subtitles.ts";

/** Seconds kept ahead of the playhead, and behind it. */
export const AHEAD = 60;
export const BEHIND = 30;

export type Phase = "starting" | "playing" | "buffering" | "paused" | "ended" | "error";

export interface PlayerState {
  phase: Phase;
  /** A `LinkError` code or `codec`, when `phase` is `error`. */
  error?: string;
  time: number;
  duration: number;
  /** Bytes a second arriving now. */
  rate: number;
}

export interface Appended {
  start: number;
  end: number;
  to: number;
  last: boolean;
}

/** How far behind the playhead a held range may end and still be carried on from, rather than asked for again. */
const CARRY_ON = 30;

/**
 * What to ask for next, from where the playhead is, what the buffer holds and the fragments appended: a fragment
 * from a video sample (carrying on from the last one), one at a time (a seek), nothing (enough ahead), or "end".
 *
 * A seek lands on the keyframe before the time asked, and one fragment (about 1 MiB) may end before that time when
 * the film's bitrate is high: then the playhead is just past a held range, and the stream carries on from it. Asking
 * for the time again would bring the same fragment back for ever.
 */
export function nextAsk(t: number, ranges: { start: number; end: number }[], appended: Appended[], duration: number): { from?: number; at?: number } | "end" | null {
  const range = ranges.find((r) => r.start - 0.3 <= t && t < r.end);
  const tailOf = (end: number) => appended.find((a) => Math.abs(a.end - end) < 0.6 || (a.start <= end && end <= a.end));
  if (!range) {
    const before = ranges.filter((r) => r.start - 0.3 <= t && r.end <= t && t - r.end < CARRY_ON).sort((x, y) => y.end - x.end)[0];
    const tail = before && tailOf(before.end);
    return tail && !tail.last ? { from: tail.to } : { at: t };
  }
  if (range.end - t >= AHEAD) return null;
  const tail = tailOf(range.end);
  if (tail?.last && range.end >= duration - 1) return "end";
  return tail ? { from: tail.to } : { at: range.end };
}

type MediaSourceCtor = typeof MediaSource;

function mediaSourceCtor(): MediaSourceCtor | undefined {
  const w = window as unknown as { MediaSource?: MediaSourceCtor; ManagedMediaSource?: MediaSourceCtor };
  return w.MediaSource ?? w.ManagedMediaSource;
}

/** Whether this browser can play a catalogue item's `m`. */
export function canPlay(mime: string | undefined): boolean {
  if (!mime) return false;
  const ctor = mediaSourceCtor();
  try {
    return !!ctor && ctor.isTypeSupported(mime);
  } catch {
    return false;
  }
}

/** Attaches a media source to the video; returns how to detach it. */
function attach(video: HTMLVideoElement, ms: MediaSource): () => void {
  const v = video as HTMLVideoElement & { srcObject: unknown };
  try {
    v.srcObject = ms;
    if (v.srcObject === ms) return () => (v.srcObject = null);
  } catch {
    /* Chromium: srcObject takes no MediaSource */
  }
  const url = URL.createObjectURL(ms);
  video.src = url;
  return () => {
    video.removeAttribute("src");
    URL.revokeObjectURL(url);
  };
}

const waitEvent = (target: EventTarget, name: string) => new Promise<void>((resolve) => target.addEventListener(name, () => resolve(), { once: true }));

export class StreamPlayer {
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private detach: (() => void) | null = null;
  private appended: Appended[] = [];
  private busy = false;
  private request: AbortController | null = null;
  private duration = 0;
  private phase: Phase = "starting";
  private error?: string;
  private disposed = false;
  private failures = 0;
  private tracks = new Map<string, TextTrack>();
  private off: (() => void)[] = [];

  constructor(
    readonly video: HTMLVideoElement,
    private readonly link: Link,
    private readonly id: string,
    private readonly audio: number,
    private readonly onState: (state: PlayerState) => void,
  ) {}

  async start(at: number): Promise<void> {
    this.emit("starting");
    let init;
    try {
      init = await this.link.request({ k: "init", id: this.id, a: this.audio });
    } catch (error) {
      return this.fail(error);
    }
    const mime = typeof init.meta?.m === "string" ? init.meta.m : "";
    this.duration = typeof init.meta?.d === "number" ? init.meta.d : 0;
    const Ctor = mediaSourceCtor();
    if (!Ctor || !canPlay(mime)) return this.fail(new LinkError("codec"));
    const ms = new Ctor();
    this.ms = ms;
    const v = this.video;
    v.disableRemotePlayback = true;
    v.playsInline = true;
    const opened = waitEvent(ms, "sourceopen");
    this.detach = attach(v, ms);
    await opened;
    if (this.disposed) return;
    try {
      if (this.duration > 0) ms.duration = this.duration;
      this.sb = ms.addSourceBuffer(mime);
      await this.append(init.bytes);
    } catch {
      return this.fail(new LinkError("codec"));
    }
    const on = (name: string, fn: () => void) => {
      v.addEventListener(name, fn);
      this.off.push(() => v.removeEventListener(name, fn));
    };
    on("seeking", () => this.seeking());
    on("timeupdate", () => {
      this.pump();
      this.emit(this.phase === "error" ? "error" : v.paused ? "paused" : "playing");
    });
    on("waiting", () => this.emit("buffering"));
    on("playing", () => this.emit("playing"));
    on("pause", () => this.emit("paused"));
    on("ended", () => this.emit("ended"));
    if (at > 0) v.currentTime = at;
    this.pump();
    v.play().catch(() => this.emit("paused"));
  }

  private emit(phase: Phase): void {
    if (this.disposed) return;
    if (this.phase === "error" && phase !== "error" && phase !== "starting") return;
    this.phase = phase;
    this.onState({ phase, ...(this.error && phase === "error" && { error: this.error }), time: this.video.currentTime, duration: this.duration, rate: this.link.stats().rate });
  }

  private fail(error: unknown): void {
    const code = error instanceof LinkError ? error.code : "failed";
    if (code === "cancelled" || this.disposed) return;
    this.error = code;
    this.phase = "error";
    this.emit("error");
  }

  /** Starts again from where the video is, after an error. */
  retry(): void {
    this.error = undefined;
    this.phase = "buffering";
    this.failures = 0;
    this.emit("buffering");
    if (!this.sb) void this.start(this.video.currentTime);
    else this.pump();
  }

  private buffered(t: number): { start: number; end: number } | null {
    const b = this.sb?.buffered ?? this.video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) - 0.3 <= t && t < b.end(i)) return { start: b.start(i), end: b.end(i) };
    return null;
  }

  private seeking(): void {
    const t = this.video.currentTime;
    if (this.buffered(t)) return;
    // Outside what is held: drop what is on its way and ask for the new place.
    this.request?.abort();
    this.request = null;
    this.busy = false;
    this.pump();
  }

  /** Asks for the next fragment when the buffer ahead is short. One request at a time. */
  private pump(): void {
    if (this.busy || this.disposed || !this.sb || this.phase === "error") return;
    const b = this.sb.buffered;
    const ranges = Array.from({ length: b.length }, (_, i) => ({ start: b.start(i), end: b.end(i) }));
    const ask = nextAsk(this.video.currentTime, ranges, this.appended, this.duration);
    if (ask === "end") {
      if (this.ms?.readyState === "open" && !this.sb.updating) {
        try {
          this.ms.endOfStream();
        } catch {
          /* already ended */
        }
      }
      return;
    }
    if (ask) void this.load(ask);
  }

  private async load(ask: { from?: number; at?: number }): Promise<void> {
    this.busy = true;
    const abort = new AbortController();
    this.request = abort;
    try {
      const reply = await this.link.request({ k: "seg", id: this.id, a: this.audio, ...ask }, { signal: abort.signal });
      if (abort.signal.aborted || this.disposed) return;
      const m = reply.meta ?? {};
      await this.makeRoom();
      await this.append(reply.bytes);
      this.failures = 0;
      this.appended.push({
        start: Number(m.s) || 0,
        end: Number(m.e) || 0,
        to: Number(m.to) || 0,
        last: m.last === true,
      });
      if (this.appended.length > 400) this.appended.splice(0, 200);
    } catch (error) {
      if (abort.signal.aborted) return;
      const code = error instanceof LinkError ? error.code : "failed";
      if ((code === "stalled" || code === "failed") && ++this.failures < 4) {
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        this.fail(error);
      }
    } finally {
      if (this.request === abort) {
        this.request = null;
        this.busy = false;
        if (!abort.signal.aborted) this.pump();
      }
    }
  }

  private append(bytes: Uint8Array): Promise<void> {
    const sb = this.sb!;
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        sb.removeEventListener("updateend", done);
        sb.removeEventListener("error", failed);
        resolve();
      };
      const failed = () => {
        sb.removeEventListener("updateend", done);
        sb.removeEventListener("error", failed);
        reject(new Error("append"));
      };
      sb.addEventListener("updateend", done);
      sb.addEventListener("error", failed);
      try {
        // On an ended source this opens it again (a seek back after the end).
        sb.appendBuffer(bytes as BufferSource);
      } catch (error) {
        sb.removeEventListener("updateend", done);
        sb.removeEventListener("error", failed);
        reject(error);
      }
    });
  }

  /** Lets go of what is far behind the playhead, so the browser's buffer never fills. */
  private async makeRoom(): Promise<void> {
    const sb = this.sb;
    if (!sb) return;
    const t = this.video.currentTime;
    const b = sb.buffered;
    if (!b.length) return;
    const cut = t - BEHIND;
    if (b.start(0) < cut - 1) {
      await new Promise<void>((resolve) => {
        sb.addEventListener("updateend", () => resolve(), { once: true });
        try {
          sb.remove(0, cut);
        } catch {
          resolve();
        }
      });
    }
  }

  /** Shows one subtitle (or none), asking the other side for it the first time. */
  async subtitles(sub: CatSubtitle | null, label: string): Promise<void> {
    for (const track of this.tracks.values()) track.mode = "disabled";
    if (!sub) return;
    let track = this.tracks.get(sub.id);
    if (!track) {
      const reply = await this.link.request({ k: "sub", id: this.id, s: sub.id });
      const cues = parseSubtitles(decodeText(reply.bytes));
      track = this.video.addTextTrack("subtitles", label, sub.l ?? "");
      for (const c of cues) {
        try {
          track.addCue(new VTTCue(c.start, c.end, c.text));
        } catch {
          /* a cue the engine refuses */
        }
      }
      this.tracks.set(sub.id, track);
    }
    for (const t of this.tracks.values()) t.mode = t === track ? "showing" : "disabled";
  }

  dispose(): void {
    this.disposed = true;
    this.request?.abort();
    for (const off of this.off) off();
    try {
      this.video.pause();
    } catch {
      /* gone */
    }
    this.detach?.();
    this.video.load();
  }
}

/** The person's own file, played from this device: no Media Source needed. */
export class LocalPlayer {
  private url: string;
  constructor(
    readonly video: HTMLVideoElement,
    file: Blob,
  ) {
    this.url = URL.createObjectURL(file);
    video.playsInline = true;
    video.src = this.url;
  }
  async start(at: number): Promise<void> {
    if (at > 0) this.video.currentTime = at;
    await this.video.play().catch(() => {});
  }
  async subtitles(file: Blob | null, lang: string | undefined, label: string): Promise<void> {
    for (const t of Array.from(this.video.textTracks)) t.mode = "disabled";
    if (!file) return;
    const track = this.video.addTextTrack("subtitles", label, lang ?? "");
    for (const c of parseSubtitles(decodeText(new Uint8Array(await file.arrayBuffer())))) track.addCue(new VTTCue(c.start, c.end, c.text));
    track.mode = "showing";
  }
  dispose(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}
