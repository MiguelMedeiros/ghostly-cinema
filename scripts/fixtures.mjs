// Makes the small test videos in test/fixtures with ffmpeg: a few seconds each, a test pattern and a tone, in the
// shapes a library holds (moov at the end, at the start, QuickTime, HEVC, two audio languages, MKV, fragmented).
// They are committed, so tests and CI need no ffmpeg; run this again only to change them.
//
//   node scripts/fixtures.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dirname, "../test/fixtures");
mkdirSync(out, { recursive: true });

const video = (seconds, size = "160x90") => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25:duration=${seconds}`];
const tone = (seconds, hz = 440) => ["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`];
const h264 = ["-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p", "-g", "25", "-bf", "2", "-crf", "35", "-preset", "veryfast"];
const aac = ["-c:a", "aac", "-b:a", "32k", "-ac", "1"];
const clean = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"];

const files = {
  // The usual download: moov after mdat, B-frames, an edit list for their delay and the AAC priming.
  "film.mp4": [...video(6), ...tone(6), ...h264, ...aac, ...clean],
  // Made for the web: moov first.
  "faststart.m4v": [...video(3), ...tone(3), ...h264, ...aac, ...clean, "-movflags", "+faststart", "-f", "mp4"],
  "camera.mov": [...video(3), ...tone(3), ...h264, ...aac, ...clean, "-f", "mov"],
  "hevc.mp4": [...video(2), ...tone(2), "-c:v", "libx265", "-tag:v", "hvc1", "-x265-params", "log-level=error:keyint=25", "-pix_fmt", "yuv420p", ...aac, ...clean],
  // Dubbed: Portuguese first, English second.
  "dubbed.mp4": [...video(3), ...tone(3, 330), ...tone(3, 550), "-map", "0:v", "-map", "1:a", "-map", "2:a", ...h264, ...aac,
    "-metadata:s:a:0", "language=por", "-metadata:s:a:1", "language=eng", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"],
  "silent.mp4": [...video(2), ...h264, "-an", ...clean],
  "episode.mkv": [...video(2), ...tone(2), ...h264, ...aac, ...clean],
  "fragmented.mp4": [...video(2), ...tone(2), ...h264, ...aac, ...clean, "-movflags", "frag_keyframe+empty_moov"],
};

for (const [name, args] of Object.entries(files)) {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args, join(out, name)], { stdio: "inherit" });
  console.log("made", name);
}
