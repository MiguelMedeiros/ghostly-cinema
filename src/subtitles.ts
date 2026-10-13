/**
 * Subtitles beside a video, `.srt` or `.vtt`, read as text and turned into cues the player adds with `VTTCue`: no URL
 * is loaded. Many `.srt` files, Brazilian ones among them, are Windows-1252 rather than UTF-8; they are read as such
 * when UTF-8 does not fit.
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** The most cues one file may give: a feature film has about 2,000. */
const MAX_CUES = 20_000;
/** The arrow between a cue's times. */
const ARROW = /\s*-{1,2}>\s*/;
const MAX_TEXT = 1000;

/** UTF-8 when the bytes are UTF-8 (a BOM, or no invalid sequence), otherwise Windows-1252. UTF-16 with a BOM too. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** `00:01:02,345`, `01:02.345`, `00:01:02.3` → seconds, or NaN. */
export function parseTimestamp(text: string): number {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(text);
  if (!m) return NaN;
  const [, h = "0", min, s, ms = "0"] = m;
  if (Number(min) > 59 || Number(s) > 59) return NaN;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

/** Markup a player would show as text: SRT's `<i>`, `{\an8}`, font tags. Kept: line breaks. Removed: the rest. */
function plain(text: string): string {
  return text
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/<\/?(?:i|b|u|font|c|v|ruby|rt|lang)(?:[\s.][^>]*)?>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim()
    .slice(0, MAX_TEXT);
}

/** Cues from SRT or WebVTT text (both are read the same way: blocks with a `start --> end` line). */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    // `-->` as the formats say; `->` as some files have it (Tears of Steel's own pt-BR subtitles).
    const at = lines.findIndex((l) => ARROW.test(l));
    if (at < 0) continue;
    const [left, right = ""] = lines[at].split(ARROW);
    const start = parseTimestamp(left);
    const end = parseTimestamp(right.trim().split(/\s+/)[0] ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = plain(lines.slice(at + 1).join("\n"));
    if (!body) continue;
    cues.push({ start, end, text: body });
    if (cues.length >= MAX_CUES) break;
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Moves every cue by `seconds` (a subtitle out of step with the video). */
export function shiftCues(cues: Cue[], seconds: number): Cue[] {
  return cues.map((c) => ({ ...c, start: Math.max(0, c.start + seconds), end: Math.max(0, c.end + seconds) })).filter((c) => c.end > c.start);
}
