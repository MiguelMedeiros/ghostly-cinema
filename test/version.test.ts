// The manifest: the version the same in the three places, and what Cinema asks of the person.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { problems, expected, listing, PUBLISHER, SOURCE } from "../scripts/bundle.mjs";

const root = join(import.meta.dirname, "..");
const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown> & { version: string; packages?: Record<string, { version?: string }> };

describe("the manifest", () => {
  const manifest = read("ghostly-app.json");

  it("has the same version as package.json and package-lock.json", () => {
    expect(read("package.json").version).toBe(manifest.version);
    const lock = read("package-lock.json");
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages?.[""]?.version).toBe(manifest.version);
  });

  it("asks for the chat and the name, never the internet, and shows full screen", () => {
    expect(manifest.permissions).toEqual(["chat", "name"]);
    expect(manifest.view).toBe("full");
    expect(manifest.sources).toEqual([SOURCE]);
    expect(String(manifest.title).length).toBeLessThanOrEqual(40);
    expect(String(manifest.tagline).length).toBeLessThanOrEqual(80);
    expect(String(manifest.description).length).toBeLessThanOrEqual(2000);
    expect(String(manifest.releaseNotes).length).toBeLessThanOrEqual(500);
  });
});

describe("the bundle check", () => {
  const source = read("ghostly-app.json");
  const page = new TextEncoder().encode("<!doctype html>");
  const key = "y".repeat(52);

  it("passes this build under any key until the key is pinned", () => {
    expect(PUBLISHER).toBe("");
    expect(problems(expected(source, page, 1, key), source, page)).toEqual([]);
  });

  it("finds another page or a changed manifest", () => {
    const other = new TextEncoder().encode("<!doctype html><p>");
    expect(problems(expected(source, other, 1, key), source, page).join()).toMatch(/is not this build's/);
    expect(problems({ ...expected(source, page, 1, key), title: "Not Cinema" }, source, page).join()).toMatch(/title/);
  });

  it("writes the store's listing pinned to a commit", () => {
    const l = listing(expected(source, page, 1, key), "d".repeat(43), "a".repeat(40));
    expect(l.urls[0]).toBe(`https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-cinema@${"a".repeat(40)}/app.ghostlyapp`);
    expect(l.ref).toBe(`${key}/cinema`);
    expect(l.category).toBe("Video");
  });
});
