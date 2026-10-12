// Values bigger than one storage value, kept in pieces; the catalogue a contact sends, checked field by field.
import { describe, expect, it } from "vitest";
import { catalogueOf, displayTitle, readCatalogue } from "../src/catalogue.ts";
import { buildLibrary } from "../src/library.ts";
import { deleteLarge, getLarge, pieces, putLarge } from "../src/store.ts";
import { paced } from "../src/broker.ts";
import { MockBroker, peakPerSecond } from "./mockBroker.ts";

describe("large values", () => {
  it("splits text by UTF-8 bytes, never inside a character", () => {
    const text = "ação🎬".repeat(5000);
    const parts = pieces(text, 1000);
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(1000);
  });

  it("keeps a value of 300 KB in pieces, replaces it, and deletes it", async () => {
    const api = new MockBroker("a");
    const big = { list: Array.from({ length: 3000 }, (_, i) => ({ i, name: `Título número ${i} "aspas" \\ barra` })) };
    await putLarge(api, "lib", big);
    expect(await getLarge(api, "lib")).toEqual(big);
    const keys = (await api.storage.keys()).length;
    await putLarge(api, "lib", { small: true });
    expect(await getLarge(api, "lib")).toEqual({ small: true });
    expect((await api.storage.keys()).length).toBeLessThan(keys);
    await deleteLarge(api, "lib");
    expect(await api.storage.keys()).toEqual([]);
    expect(await getLarge(api, "lib")).toBeUndefined();
  });

  it("gives nothing when a piece is missing", async () => {
    const api = new MockBroker("a");
    await putLarge(api, "x", { a: "b".repeat(70_000) });
    const piece = (await api.storage.keys()).find((k) => k.startsWith("x:"))!;
    await api.storage.delete(piece);
    expect(await getLarge(api, "x")).toBeUndefined();
  });

  it("keeps every call under the broker's 50 a second", async () => {
    const api = new MockBroker("a");
    const times: { at: number }[] = [];
    const counting = { ...api, storage: { ...api.storage, set: async (k: string, v: never) => { times.push({ at: Date.now() }); return api.storage.set(k, v); } } };
    const p = paced(counting as never, 46);
    await Promise.all(Array.from({ length: 120 }, (_, i) => p.storage.set(`k${i}`, i)));
    expect(peakPerSecond(times)).toBeLessThanOrEqual(46);
  }, 10_000);
});

describe("the catalogue", () => {
  const lib = buildLibrary([
    { path: "x/Inception (2010)/Inception.mp4", size: 100, modified: 5 },
    { path: "x/Inception (2010)/Inception.pt-BR.srt", size: 1, modified: 5 },
    { path: "x/Dark/Season 1/Dark.S01E01.Secrets.mp4", size: 200, modified: 6 },
    { path: "x/Up.mkv", size: 300, modified: 7 },
  ]);
  const scans = { [lib.films[0].id]: { d: 8880, m: 'video/mp4; codecs="avc1.640028, mp4a.40.2"', au: ["eng", "por"], w: 1920, h: 800, p: 1 as const } };
  const cat = catalogueOf(lib, scans, 42, { [lib.shows[0].id]: true });

  it("says what each title is, with no path", () => {
    expect(JSON.stringify(cat)).not.toContain("x/");
    const inception = cat.items.find((i) => i.t === "Inception")!;
    expect(inception).toMatchObject({ k: "f", y: 2010, d: 8880, au: ["eng", "por"], p: 1, sb: [{ l: "pt-BR" }] });
    expect(cat.items.find((i) => i.t === "Up")!.x).toBe("convert");
    const ep = cat.items.find((i) => i.k === "e")!;
    expect(displayTitle(ep, cat.shows[0])).toBe("Dark · S1 E1 · Secrets");
    expect(displayTitle(inception)).toBe("Inception (2010)");
  });

  it("reads back what it wrote", () => {
    expect(readCatalogue(JSON.parse(JSON.stringify(cat)))).toEqual(cat);
  });

  it("drops what a contact should not send", () => {
    const bad = JSON.parse(JSON.stringify(cat));
    bad.items.push({ id: "../etc", k: "f", t: "x", z: 1 });
    bad.items.push({ id: "abc", k: "e", t: "orphan", z: 1, sh: "nope", sn: 1, ep: 1 });
    bad.items.push({ id: "abd", k: "f", t: "x".repeat(500), z: 1 });
    bad.items.push({ id: "abe", k: "f", t: "ok", z: 1, m: 'video/mp4; codecs="x"><img', au: ["<b>"], sb: [{ id: "zz", l: "javascript:" }], x: "<script>" });
    bad.items.push({ id: cat.items[0].id, k: "f", t: "duplicate", z: 1 });
    const read = readCatalogue(bad)!;
    expect(read.items.map((i) => i.t)).toEqual([...cat.items.map((i) => i.t), "ok"]);
    expect(read.items.at(-1)).toEqual({ id: "abe", k: "f", t: "ok", z: 1, sb: [{ id: "zz" }] });
    expect(readCatalogue({ v: 2, rev: 1, items: [], shows: [] })).toBeNull();
    expect(readCatalogue("nope")).toBeNull();
  });
});
