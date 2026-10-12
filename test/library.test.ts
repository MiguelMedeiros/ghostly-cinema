// A picked folder becomes a library: films and shows, subtitles and pictures beside them, samples left out.
import { describe, expect, it } from "vitest";
import { buildLibrary, hashId, type PickedFile } from "../src/library.ts";

const MB = 1024 * 1024;
const files = (paths: [string, number?][]): PickedFile[] => paths.map(([path, size = 700 * MB]) => ({ path, size, modified: 1 }));

const FOLDER = files([
  ["Cinema/Films/Inception (2010)/Inception.2010.1080p.mp4"],
  ["Cinema/Films/Inception (2010)/Inception.2010.1080p.pt-BR.srt", 80_000],
  ["Cinema/Films/Inception (2010)/Inception.2010.1080p.en.srt", 80_000],
  ["Cinema/Films/Inception (2010)/poster.jpg", 200_000],
  ["Cinema/Films/Inception (2010)/Inception-sample.mp4", 30 * MB],
  ["Cinema/Films/Up.2009.mkv"],
  ["Cinema/Films/Up.2009.jpg", 90_000],
  ["Cinema/Films/Amelie.mp4"],
  ["Cinema/Films/folder.jpg", 90_000],
  ["Cinema/Series/Dark/poster.jpg", 100_000],
  ["Cinema/Series/Dark/Season 1/Dark.S01E02.Lies.mp4"],
  ["Cinema/Series/Dark/Season 1/Dark.S01E01.Secrets.mp4"],
  ["Cinema/Series/Dark/Season 1/Dark.S01E01.Secrets-thumb.jpg", 20_000],
  ["Cinema/Series/Dark/Season 2/Dark.S02E01.mp4"],
  ["Cinema/Series/Dark/Season 2/Subs/Dark.S02E01/2_English.srt", 40_000],
  ["Cinema/Series/Dark/Season 2/Subs/Dark.S02E01/3_Portuguese.srt", 40_000],
  ["Cinema/Series/dark.s03e01.mp4"],
  ["Cinema/.DS_Store", 6000],
  ["Cinema/__MACOSX/Films/._Up.2009.mkv", 4000],
  ["Cinema/notes.txt", 100],
]);

describe("a library from a folder", () => {
  const lib = buildLibrary(FOLDER);

  it("finds the films, sorted, and leaves the sample out", () => {
    expect(lib.films.map((f) => [f.video.title, f.video.year])).toEqual([["Amelie", undefined], ["Inception", 2010], ["Up", 2009]]);
    expect(lib.skipped).toBe(1);
    expect(lib.films.find((f) => f.video.title === "Up")!.container).toBe(false);
    expect(lib.films.find((f) => f.video.title === "Inception")!.container).toBe(true);
  });

  it("takes the pictures beside a film, and a folder's only when the film is alone in it", () => {
    const by = (t: string) => lib.films.find((f) => f.video.title === t)!;
    expect(by("Inception").picture).toBe("Cinema/Films/Inception (2010)/poster.jpg");
    expect(by("Up").picture).toBe("Cinema/Films/Up.2009.jpg");
    // folder.jpg sits among several films: it is nobody's poster.
    expect(by("Amelie").picture).toBeUndefined();
  });

  it("matches subtitles by name, beside it and in a Subs folder", () => {
    const inception = lib.films.find((f) => f.video.title === "Inception")!;
    expect(inception.subtitles.map((s) => s.lang)).toEqual(["en", "pt-BR"]);
    const s2 = lib.episodes.find((e) => e.video.season === 2)!;
    expect(s2.subtitles.map((s) => s.lang)).toEqual(["en", "pt"]);
  });

  it("groups episodes into one show, in order, with the show's poster", () => {
    expect(lib.shows).toHaveLength(1);
    const dark = lib.shows[0];
    expect(dark.title).toBe("Dark");
    expect(dark.poster).toBe("Cinema/Series/Dark/poster.jpg");
    expect(lib.episodes.map((e) => [e.video.season, e.video.episode])).toEqual([[1, 1], [1, 2], [2, 1], [3, 1]]);
    expect(new Set(lib.episodes.map((e) => e.showId))).toEqual(new Set([dark.id]));
    expect(lib.episodes[0].picture).toBe("Cinema/Series/Dark/Season 1/Dark.S01E01.Secrets-thumb.jpg");
  });

  it("gives the same ids when the folder is picked again", () => {
    const again = buildLibrary([...FOLDER].reverse());
    expect(again.films.map((f) => f.id)).toEqual(lib.films.map((f) => f.id));
    expect(again.shows[0].id).toBe(lib.shows[0].id);
    expect(hashId("a")).not.toBe(hashId("b"));
    expect(hashId("Cinema/Films/Up.2009.mkv")).toMatch(/^[0-9a-z]{1,11}$/);
  });

  it("ignores hidden files and what is not a video", () => {
    const all = [...lib.films, ...lib.episodes].map((e) => e.path);
    expect(all.some((p) => p.includes("__MACOSX") || p.endsWith(".txt"))).toBe(false);
  });
});
