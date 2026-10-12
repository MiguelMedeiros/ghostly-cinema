// The built app: one self-contained HTML file that loads nothing by URL, runs under the runner's lock, stays small,
// and is the same bytes on every build.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const outs: string[] = [];
let page: string;

async function buildOnce(): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "cinema-build-"));
  outs.push(out);
  await build({ configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  return out;
}

beforeAll(async () => {
  page = readFileSync(join(await buildOnce(), "index.html"), "utf8");
}, 60_000);

afterAll(() => outs.forEach((o) => rmSync(o, { recursive: true, force: true })));

describe("the Cinema bundle", () => {
  it("is one HTML file with its script and styles inline", () => {
    expect(readdirSync(outs[0])).toEqual(["index.html"]);
    expect(page).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/\b(?:src|href|srcset|action|poster)\s*=\s*["']/i);
    expect(page).not.toMatch(/type="module"/);
    expect(page.match(/<script\b/g)).toHaveLength(1);
    expect(page.match(/<style\b/g)).toHaveLength(1);
  });

  it("names no address and no way to reach the network", () => {
    expect(page).not.toMatch(/\b(?:https?|wss?):\/\//i);
    expect(page).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|RTCPeerConnection|Worker)\s*\(/);
    expect(page).not.toMatch(/\bimport\s*\(/);
  });

  // The web runner locks the page with a nonce once the entry is written (WISP 1200): markup handlers and scripts
  // made later never run there, and the app parses no markup, so a contact's text is only ever text.
  it("runs under the runner's lock and parses no markup", () => {
    expect(page).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/createElement\(\s*["'`]script["'`]/);
    expect(page).not.toMatch(/\b(?:innerHTML|insertAdjacentHTML|outerHTML|document\.write)\b|setAttribute\(\s*["'`]on/);
    // No frames and no <link>, which the runner's hint guard takes out.
    expect(page).not.toMatch(/createElement\(\s*["'`](?:iframe|link|object|embed)["'`]/);
  });

  it("stays far under the 16 MiB a bundle may be", () => {
    expect(Buffer.byteLength(page)).toBeLessThanOrEqual(160 * 1024);
  });

  it("is the same bytes when built again", async () => {
    const again = readFileSync(join(await buildOnce(), "index.html"), "utf8");
    expect(again).toBe(page);
  }, 60_000);
});
