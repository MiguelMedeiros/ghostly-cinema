/**
 * What a person runs to make a file Cinema can play: the video copied as it is when the browser decodes it (a few
 * seconds, no loss), only the audio made AAC, which every browser's Media Source takes (MP3, AC-3 and DTS inside MP4
 * are refused by Chromium and WebKit alike, measured). A video the browser cannot decode is encoded again.
 */

/** Video codecs Media Source takes in MP4 in the browsers Cinema runs in (HEVC only in WebKit, so it is not here). */
const COPYABLE_VIDEO = /^(avc1|avc3|av01|vp09)\b/;

/** The `ffmpeg` line for a file, given its catalogue type (`video/mp4; codecs="…"`) when it was read. */
export function convertCommand(fileName: string, mime?: string): string {
  const out = `${fileName.replace(/\.[^.]+$/, "")}.mp4`;
  const target = out === fileName ? out.replace(/\.mp4$/, ".cinema.mp4") : out;
  const video = /codecs="([^",]+)/.exec(mime ?? "")?.[1];
  const reencode = video !== undefined && !COPYABLE_VIDEO.test(video);
  const v = reencode ? "-c:v libx264 -crf 20" : "-c:v copy";
  return `ffmpeg -i "${fileName}" -map 0:v:0 -map 0:a? ${v} -c:a aac -b:a 192k -movflags +faststart "${target}"`;
}

/** A height for the label: a widescreen 1280x534 film is 720p, not SD. */
export function qualityLabel(width: number | undefined, height: number | undefined): string | null {
  const lines = Math.max(height ?? 0, Math.round(((width ?? 0) * 9) / 16));
  if (!lines) return null;
  return lines >= 1600 ? "4K" : lines >= 1000 ? "1080p" : lines >= 700 ? "720p" : "SD";
}
