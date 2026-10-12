// Cinema inside real Ghostly, two web clients paired over the e2e suite's local relay (not run by this repository's
// CI: it runs from a checkout of Ghostly, see test/ghostly/README.md). Miguel installs Cinema from a store signed in
// the test with throwaway test keys, opens it in his chat with Ana and picks a folder; Ana installs it from his card,
// sees his library, plays a film that streams over the chat's `apps/1` link, and seeks into the part not sent yet.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Frame, Page } from "@playwright/test";
import { buildAppBundle, seedSigner, signAppStore, toZ32, utf8Encode, type AppStoreIndex } from "@ghostly/core";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { serveStore } from "../support/appStore";

/** The Cinema checkout whose dist/index.html is tested (`npm run build` there first). */
const CINEMA = process.env.CINEMA_DIR ?? join(process.env.HOME ?? "", "code/ghostly-cinema");
const STORE_URL = "https://raw.githubusercontent.com/ghostly-e2e/store/HEAD/ghostly-store.json";
const APP_URL = "https://raw.githubusercontent.com/ghostly-e2e/cinema/HEAD/app.ghostlyapp";
/** Throwaway test keys: the SHA-256 of a fixed label, never a real key. */
const signer = (label: string) => seedSigner(sha256(utf8Encode(`ghostly cinema e2e: ${label}`)));

async function cinemaStore(): Promise<Map<string, Uint8Array>> {
  const manifest = JSON.parse(readFileSync(join(CINEMA, "ghostly-app.json"), "utf8"));
  const page = new Uint8Array(readFileSync(join(CINEMA, "dist/index.html")));
  const publisher = signer("publisher"), store = signer("store");
  const made = await buildAppBundle({ ...manifest, sequence: 1, sources: [APP_URL] }, [{ path: "index.html", bytes: page }], publisher);
  const index: AppStoreIndex = {
    ghostlyStore: 1, key: toZ32(store.publicKey), name: "E2E store", description: "Apps for the end-to-end tests.", kind: "curated", sequence: 1,
    expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600, removed: [], revoked: [],
    apps: [{ ref: `${toZ32(publisher.publicKey)}/cinema`, sequence: 1, digest: made.digest, urls: [APP_URL], title: manifest.title, tagline: manifest.tagline, category: "Video" }],
  };
  const signed = await signAppStore(index, store);
  return new Map([[APP_URL, made.bytes], [STORE_URL, signed.indexBytes], [new URL("ghostly-store.sig", STORE_URL).href, signed.sigBytes]]);
}

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "cinema-e2e-"));
  const film = join(dir, "Cinema", "Films", "Test Pattern (2026)");
  mkdirSync(film, { recursive: true });
  copyFileSync(join(CINEMA, "test/fixtures/long.mp4"), join(film, "Test.Pattern.2026.mp4"));
  writeFileSync(join(film, "Test.Pattern.2026.pt-BR.srt"), "1\n00:00:00,500 --> 00:01:30,000\nOlá, Ana!\n");
  return join(dir, "Cinema");
}

async function nickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** Cinema's frame: the runner's page, with Cinema written into it. */
async function cinemaFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes("app-frame"))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes("app-frame"))!;
  await expect(frame.locator(".brand")).toBeVisible();
  return frame;
}

test("Miguel shares a folder in Cinema, Ana streams a film from it and seeks", { tag: ["@feature:apps.cinema"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const files = await cinemaStore();
  const dir = folder();
  try {
    const [miguel, ana] = await Promise.all([peer("miguel"), peer("ana")]);
    await Promise.all([serveStore(miguel.context, { files }), serveStore(ana.context, { files })]);
    await nickname(miguel, "Miguel");
    await nickname(ana, "Ana");
    for (const p of [miguel, ana]) await p.page.setViewportSize({ width: 1280, height: 800 });

    // Miguel installs Cinema from the store; the install screen asks for his name in the chat.
    await miguel.page.getByTestId("account-apps").click();
    await miguel.page.getByTestId("apps-add").click();
    await miguel.page.getByTestId("apps-add-url").fill(STORE_URL);
    await miguel.page.getByTestId("apps-add-check").click();
    await miguel.page.getByTestId("apps-add-store-confirm").click();
    await miguel.page.getByTestId("app-store").filter({ hasText: "E2E store" }).getByTestId("app-listing-install").click();
    const screen = miguel.page.getByTestId("app-install");
    await expect(screen.getByTestId("app-permission-name")).toBeVisible();
    await expect(screen).not.toContainText(/internet/i);
    await screen.getByTestId("app-install-confirm").click();
    await expect(miguel.page.getByTestId("installed-app")).toContainText("Cinema");
    await miguel.page.goto("/#/");
    await pair(miguel, ana);

    // He opens it in the chat (full screen) and picks his folder.
    await (await composerRow(miguel.page, "composer-apps")).click();
    await miguel.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
    await expect(miguel.page.getByTestId("mini-app")).toHaveAttribute("data-view", "full");
    const m = await cinemaFrame(miguel.page);
    await m.getByRole("button", { name: "My library" }).click();
    await m.locator("[data-testid=pick-folder]").setInputFiles(dir);
    await expect(m.getByTestId("my-card").first()).toBeVisible();
    await expect(m.getByTestId("reading")).toHaveCount(0, { timeout: 60_000 });

    // Ana installs it from his card and opens it.
    const card = chat(ana).getByTestId("app-card");
    await expect(card).toContainText("Cinema");
    await card.getByTestId("app-card-install").click();
    await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
    const a = await cinemaFrame(ana.page);
    await expect(a.getByRole("button", { name: "Miguel's library" })).toBeVisible();
    await expect(a.getByTestId("row-films")).toContainText("Test Pattern");

    // She plays the film: it streams from Miguel over the chat.
    await a.getByTestId("row-films").getByTestId("card").first().click();
    await a.getByTestId("play").click();
    const time = () => a.getByTestId("video").evaluate((v: HTMLVideoElement) => v.currentTime);
    await expect.poll(time, { timeout: 120_000 }).toBeGreaterThan(2);
    // And seeks to 70 s, which was never sent.
    await a.getByTestId("video").evaluate((v: HTMLVideoElement) => (v.currentTime = 70));
    await expect.poll(time, { timeout: 120_000 }).toBeGreaterThan(71);
    await test.info().attach("ana", { body: await ana.page.screenshot(), contentType: "image/png" });
    await test.info().attach("miguel", { body: await miguel.page.screenshot(), contentType: "image/png" });
    if (process.env.CINEMA_SHOTS) {
      await ana.page.screenshot({ path: join(process.env.CINEMA_SHOTS, "ghostly-ana-player.png") });
      await a.getByRole("button", { name: /Back/ }).click();
      await ana.page.screenshot({ path: join(process.env.CINEMA_SHOTS, "ghostly-ana-library.png") });
      await miguel.page.screenshot({ path: join(process.env.CINEMA_SHOTS, "ghostly-miguel-library.png") });
    }
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});
