// Two sides of one chat on the mock broker: Miguel picks a folder, Ana sees his library, its pictures and subtitles,
// and plays a film from its start and from the middle; after a reload the library is still there and a film asks
// for the folder again. ffprobe, where installed, checks that what Ana received is a film.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Cinema } from "../src/app.ts";
import type { Picked, PictureMaker } from "../src/share.ts";
import { decodeText, parseSubtitles } from "../src/subtitles.ts";
import { chatPair, peakPerSecond, type MockBroker } from "./mockBroker.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name));

/** Pictures without a page: a few bytes that say where they came from. */
const pictures: PictureMaker = {
  fromImage: async (file) => new Uint8Array([0xff, 0xd8, 0xff, 1, (await file.arrayBuffer()).byteLength & 0xff]),
  fromVideo: async () => new Uint8Array([0xff, 0xd8, 0xff, 2]),
};

const SRT = "1\n00:00:01,000 --> 00:00:02,000\nOlá, Ana!\n";

function folder(): Picked[] {
  const file = (bytes: Uint8Array | string, modified = 1000) => new File([bytes as BlobPart], "x", { lastModified: modified });
  return [
    { path: "Cinema/Films/Test Pattern (2026)/Test.Pattern.2026.mp4", file: file(fixture("film.mp4")) },
    { path: "Cinema/Films/Test Pattern (2026)/Test.Pattern.2026.pt-BR.srt", file: file(SRT) },
    { path: "Cinema/Films/Test Pattern (2026)/poster.jpg", file: file(new Uint8Array([1, 2, 3])) },
    { path: "Cinema/Films/Dubbed (2025).mp4", file: file(fixture("dubbed.mp4")) },
    { path: "Cinema/Films/Old Episode.mkv", file: file(fixture("episode.mkv")) },
    { path: "Cinema/Series/Tones/Season 1/Tones.S01E01.Low.m4v", file: file(fixture("faststart.m4v")) },
    { path: "Cinema/Series/Tones/Season 1/Tones.S01E02.High.mov", file: file(fixture("camera.mov")) },
  ];
}

async function sides(): Promise<{ miguel: Cinema; ana: Cinema; a: MockBroker; b: MockBroker }> {
  const [a, b] = chatPair();
  a.displayName = "Miguel";
  b.displayName = "Ana";
  a.launch();
  const miguel = new Cinema(a, pictures);
  await miguel.start();
  b.launch();
  const ana = new Cinema(b, pictures);
  await ana.start();
  return { miguel, ana, a, b };
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("Miguel shares, Ana watches", () => {
  it("shows Miguel's library to Ana, with names, lengths, pictures and what needs converting", async () => {
    const { miguel, ana } = await sides();
    await until(() => ana.peer.name === "Miguel" && miguel.peer.name === "Ana");
    expect(ana.watch.catalogue).toBeNull();
    await miguel.share.pick(folder());
    await miguel.share.idle();
    await until(() => ana.watch.catalogue?.rev === miguel.share.rev && ana.watch.catalogue.items.some((i) => i.d));
    const cat = ana.watch.catalogue!;
    const film = cat.items.find((i) => i.t === "Test Pattern")!;
    expect(film).toMatchObject({ k: "f", y: 2026, d: 6, m: 'video/mp4; codecs="avc1.4d400b, mp4a.40.2"', p: 1, sb: [{ l: "pt-BR" }] });
    expect(cat.items.find((i) => i.t === "Old Episode")!.x).toBe("convert");
    expect(cat.items.find((i) => i.t === "Dubbed")!.au).toEqual(["por", "eng"]);
    expect(cat.shows.map((s) => s.t)).toEqual(["Tones"]);
    expect(cat.items.filter((i) => i.k === "e").map((i) => [i.sn, i.ep, i.t])).toEqual([[1, 1, "Low"], [1, 2, "High"]]);
    // The poster beside the film, made small (the stand-in says it came from a 3-byte image).
    expect(await ana.watch.picture(film.id)).toBe(`data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 1, 3))}`);
    // The show's picture from its first episode.
    expect(await ana.watch.picture(cat.shows[0].id)).toBe(`data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 2))}`);
    // No path ever crossed.
    expect(JSON.stringify(cat)).not.toContain("Cinema/");
  }, 20_000);

  it("streams a film from its start and from the middle, with its subtitles", async () => {
    const { miguel, ana, a, b } = await sides();
    await miguel.share.pick(folder());
    await miguel.share.idle();
    await until(() => !!ana.watch.catalogue?.items.some((i) => i.d));
    const film = ana.watch.catalogue!.items.find((i) => i.t === "Test Pattern")!;

    const init = await ana.link.request({ k: "init", id: film.id });
    expect(init.meta).toMatchObject({ m: film.m, au: ["und"] });
    const segments: Uint8Array[] = [];
    let from = 0;
    for (;;) {
      const seg = await ana.link.request({ k: "seg", id: film.id, from });
      segments.push(seg.bytes);
      if (seg.meta!.last) break;
      from = seg.meta!.to as number;
    }
    // A seek: from the keyframe before 3.5 s.
    const seek = await ana.link.request({ k: "seg", id: film.id, at: 3.5 });
    expect(seek.meta).toMatchObject({ from: 75, s: 3 });

    const sub = await ana.link.request({ k: "sub", id: film.id, s: film.sb![0].id });
    expect(parseSubtitles(decodeText(sub.bytes))).toEqual([{ start: 1, end: 2, text: "Olá, Ana!" }]);
    expect(peakPerSecond(a.sent)).toBeLessThanOrEqual(48);
    expect(peakPerSecond(b.sent)).toBeLessThanOrEqual(48);

    let ffprobe = true;
    try {
      execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    } catch {
      ffprobe = false;
    }
    if (ffprobe) {
      const dir = mkdtempSync(join(tmpdir(), "cinema-flow-"));
      try {
        const file = join(dir, "received.mp4");
        writeFileSync(file, Buffer.concat([init.bytes, ...segments]));
        const frames = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" });
        expect(Number(frames.trim())).toBe(150);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("plays the other language of a dubbed film", async () => {
    const { miguel, ana } = await sides();
    await miguel.share.pick(folder());
    await miguel.share.idle();
    await until(() => !!ana.watch.catalogue?.items.some((i) => i.d));
    const dubbed = ana.watch.catalogue!.items.find((i) => i.t === "Dubbed")!;
    const english = await ana.link.request({ k: "init", id: dubbed.id, a: 1 });
    expect(english.meta!.au).toEqual(["por", "eng"]);
    const portuguese = await ana.link.request({ k: "init", id: dubbed.id, a: 0 });
    expect(english.bytes).not.toEqual(portuguese.bytes);
  }, 20_000);

  it("keeps the library after a reload; a film then waits for the folder", async () => {
    const { miguel, a, b } = await sides();
    await miguel.share.pick(folder());
    await miguel.share.idle();
    const rev = miguel.share.rev;
    // Miguel's app reloads: the same storage, no files.
    a.shutdown();
    miguel.close();
    a.launch();
    const again = new Cinema(a, pictures);
    await again.start();
    expect(again.share.rev).toBe(rev);
    expect(again.share.linked).toBe(false);
    // Ana's side, reopened, gets the kept library and asks for a film.
    b.shutdown();
    b.launch();
    const ana = new Cinema(b, pictures);
    await ana.start();
    await until(() => ana.watch.catalogue?.rev === rev);
    const film = ana.watch.catalogue!.items.find((i) => i.t === "Test Pattern")!;
    expect(await ana.watch.picture(film.id)).toMatch(/^data:image\/jpeg;base64,/);
    await expect(ana.link.request({ k: "init", id: film.id })).rejects.toThrow("not-picked");
    // Picked again: the same ids, the scans kept, and it plays.
    await again.share.pick(folder());
    expect(again.share.catalogue()!.items.find((i) => i.id === film.id)!.d).toBe(6);
    const init = await ana.link.request({ k: "init", id: film.id });
    expect(init.bytes.length).toBeGreaterThan(500);
  }, 20_000);

  it("answers nothing to a contact when this side shares nothing", async () => {
    const { ana, miguel } = await sides();
    await until(() => ana.peer.open);
    await expect(ana.link.request({ k: "cat" })).rejects.toThrow("no-library");
    expect(miguel.watch.catalogue).toBeNull();
  });
});
