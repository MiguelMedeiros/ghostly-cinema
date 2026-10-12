// The MP4 side of streaming: index a file from its moov, cut it into fragments, and check the fragments hold every
// sample, in order, with the times the file gives. ffprobe, where it is installed, reads the result back too.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesReader, children, u32 } from "../src/media/bytes.ts";
import { buildSegment, indexMp4, initSegment, MediaError, planSegment, syncBefore, topLevel, type MediaIndex } from "../src/media/mp4.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name)));

let ffprobe = false;
try {
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  ffprobe = true;
} catch {
  /* not installed: the byte checks still run */
}

/** Every segment of the film, from the start, with the given size target. */
async function wholeFilm(bytes: Uint8Array, index: MediaIndex, audioIndex = 0, targetBytes = 8 * 1024) {
  const reader = bytesReader(bytes);
  const audio = index.audio[audioIndex];
  const segments: Uint8Array[] = [];
  const plans = [];
  let from = 0;
  while (from < index.video.dts.length) {
    const plan = planSegment(index, from, audio, targetBytes);
    plans.push(plan);
    segments.push(await buildSegment(reader, index, plan, audio, segments.length + 1));
    from = plan.to;
  }
  return { init: initSegment(index, audio), segments, plans };
}

/** The samples a fragment carries, per track id, read back from its moof and mdat. */
function samplesOf(fragment: Uint8Array): Map<number, Uint8Array[]> {
  const out = new Map<number, Uint8Array[]>();
  const [moof, mdat] = children(fragment, 0, fragment.length);
  expect(moof.type).toBe("moof");
  expect(mdat.type).toBe("mdat");
  for (const traf of children(fragment, moof.body, moof.end).filter((b) => b.type === "traf")) {
    const boxes = children(fragment, traf.body, traf.end);
    const tfhd = boxes.find((b) => b.type === "tfhd")!;
    const trun = boxes.find((b) => b.type === "trun")!;
    const id = u32(fragment, tfhd.body + 4);
    const count = u32(fragment, trun.body + 4);
    let at = moof.start + u32(fragment, trun.body + 8);
    const list: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const size = u32(fragment, trun.body + 12 + i * 16 + 4);
      list.push(fragment.subarray(at, at + size));
      at += size;
    }
    out.set(id, list);
  }
  return out;
}

describe("indexing an MP4", () => {
  it("finds the moov at the end of a download, with B-frames and AAC", async () => {
    const bytes = fixture("film.mp4");
    const boxes = await topLevel(bytesReader(bytes));
    expect(boxes.map((b) => b.type)).toEqual(["ftyp", "free", "mdat", "moov"]);
    const index = await indexMp4(bytesReader(bytes));
    expect(index.duration).toBeCloseTo(6, 1);
    expect(index.video.codec).toBe("avc1.4d400b");
    expect(index.video.width).toBe(160);
    expect(index.video.height).toBe(90);
    expect(index.video.dts.length).toBe(150);
    expect(index.audio).toHaveLength(1);
    expect(index.audio[0].codec).toBe("mp4a.40.2");
    expect(index.brand).toBe('video/mp4; codecs="avc1.4d400b, mp4a.40.2"');
    // A keyframe every 25 frames, and the edit list takes the B-frame delay off: the first frame shows at 0.
    expect([...index.video.sync].filter(Boolean)).toHaveLength(6);
    expect(index.video.dts[0] + index.video.cts[0]).toBe(0);
  });

  it("reads the moov first in a faststart M4V and a QuickTime MOV", async () => {
    for (const name of ["faststart.m4v", "camera.mov"]) {
      const index = await indexMp4(bytesReader(fixture(name)));
      expect(index.video.codec, name).toMatch(/^avc1\./);
      expect(index.audio[0]?.codec, name).toBe("mp4a.40.2");
      expect(index.duration, name).toBeCloseTo(3, 1);
    }
  });

  it("gives HEVC its codec string", async () => {
    const index = await indexMp4(bytesReader(fixture("hevc.mp4")));
    expect(index.video.codec).toMatch(/^hvc1\.1\.6\.L\d+\.90$/);
  });

  it("keeps every audio language of a dubbed film", async () => {
    const index = await indexMp4(bytesReader(fixture("dubbed.mp4")));
    expect(index.audio.map((a) => a.language)).toEqual(["por", "eng"]);
  });

  it("plays a film with no sound", async () => {
    const index = await indexMp4(bytesReader(fixture("silent.mp4")));
    expect(index.audio).toEqual([]);
    expect(index.brand).toBe('video/mp4; codecs="avc1.4d400b"');
  });

  it("says why it cannot play MKV, fragmented MP4, a cut file and noise", async () => {
    const why = async (bytes: Uint8Array) => {
      try {
        await indexMp4(bytesReader(bytes));
        return "played";
      } catch (error) {
        return error instanceof MediaError ? error.why : String(error);
      }
    };
    expect(await why(fixture("episode.mkv"))).toBe("not-mp4");
    expect(await why(fixture("fragmented.mp4"))).toBe("fragmented");
    const film = fixture("film.mp4");
    expect(await why(film.subarray(0, film.length - 200))).toMatch(/no-moov|damaged/);
    expect(await why(new Uint8Array(4096).fill(7))).toBe("not-mp4");
    expect(await why(new Uint8Array(0))).toBe("not-mp4");
  });
});

describe("cutting it into fragments", () => {
  it("carries every sample once, in order, byte for byte", async () => {
    const bytes = fixture("film.mp4");
    const index = await indexMp4(bytesReader(bytes));
    const { segments, plans } = await wholeFilm(bytes, index);
    expect(segments.length).toBeGreaterThan(3);
    const got = new Map<number, Uint8Array[]>();
    for (const s of segments) for (const [id, list] of samplesOf(s)) got.set(id, [...(got.get(id) ?? []), ...list]);
    for (const track of [index.video, index.audio[0]]) {
      const list = got.get(track.id)!;
      expect(list).toHaveLength(track.sizes.length);
      list.forEach((sample, k) => expect(sample).toEqual(bytes.subarray(track.offsets[k], track.offsets[k] + track.sizes[k])));
    }
    // The plans tile the film: each starts where the last ended.
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].from).toBe(plans[i - 1].to);
      expect(plans[i].audioFrom).toBe(plans[i - 1].audioTo);
    }
  });

  it("ends a segment on a keyframe when one is close", async () => {
    const index = await indexMp4(bytesReader(fixture("film.mp4")));
    const plan = planSegment(index, 0, index.audio[0], 1);
    expect(plan.to).toBe(1);
    const big = planSegment(index, 0, index.audio[0], 20 * 1024);
    expect(index.video.sync[big.to] || big.to === index.video.dts.length).toBeTruthy();
  });

  it("seeks to the keyframe before a time", async () => {
    const index = await indexMp4(bytesReader(fixture("film.mp4")));
    expect(syncBefore(index.video, 0)).toBe(0);
    expect(syncBefore(index.video, 2.5)).toBe(50);
    expect(syncBefore(index.video, 3.99)).toBe(75);
    expect(syncBefore(index.video, 99)).toBe(125);
    const plan = planSegment(index, syncBefore(index.video, 2.5), index.audio[0], 4096);
    expect(plan.start).toBeCloseTo(2, 1);
    // Audio from the same time.
    const a = index.audio[0];
    expect(a.dts[plan.audioFrom] / a.timescale).toBeGreaterThanOrEqual(plan.start - 0.03);
  });

  it.runIf(ffprobe)("makes a file ffprobe reads whole: init, then every fragment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cinema-mp4-"));
    try {
      for (const [name, audioIndex] of [["film.mp4", 0], ["dubbed.mp4", 1], ["camera.mov", 0], ["hevc.mp4", 0], ["silent.mp4", 0]] as const) {
        const bytes = fixture(name);
        const index = await indexMp4(bytesReader(bytes));
        const { init, segments } = await wholeFilm(bytes, index, audioIndex, 16 * 1024);
        const file = join(dir, name + ".frag.mp4");
        writeFileSync(file, Buffer.concat([init, ...segments]));
        const count = (stream: string) =>
          Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
        expect(count("v:0"), name).toBe(index.video.dts.length);
        if (index.audio.length) expect(count("a:0"), name).toBe(index.audio[audioIndex].dts.length);
        // Decodes with no error.
        execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { stdio: "pipe" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
