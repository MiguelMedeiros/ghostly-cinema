// Two sides of one chat, each in the runner's sandboxed frame under its real header: Miguel shares a folder, Ana
// browses his library and plays a film that streams over the relay, seeks into the part not sent yet, turns on
// subtitles, leaves it half-watched and finds it under Continue watching. Then Miguel's app reloads, and a film waits
// until he picks the folder again.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chat, closeSide, openSide, violations, type Chat, type Side } from "./harness.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures");

const SRT = `1
00:00:00,500 --> 00:00:59,000
Legenda em português

2
00:01:00,000 --> 00:01:30,000
Segunda legenda
`;

/** A folder like Miguel's: a film with a poster and subtitles, a show with two episodes, an MKV to convert. */
function makeFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "cinema-folder-"));
  const root = join(dir, "Cinema");
  const film = join(root, "Films", "Test Pattern (2026)");
  const season = join(root, "Series", "Tones", "Season 1");
  mkdirSync(film, { recursive: true });
  mkdirSync(season, { recursive: true });
  copyFileSync(join(FIXTURES, "long.mp4"), join(film, "Test.Pattern.2026.mp4"));
  writeFileSync(join(film, "Test.Pattern.2026.pt-BR.srt"), SRT);
  copyFileSync(join(FIXTURES, "film.mp4"), join(season, "Tones.S01E01.Low.mp4"));
  copyFileSync(join(FIXTURES, "camera.mov"), join(season, "Tones.S01E02.High.mov"));
  copyFileSync(join(FIXTURES, "episode.mkv"), join(root, "Films", "Old.Film.1999.mkv"));
  return root;
}

let folder: string;
test.beforeAll(() => {
  folder = makeFolder();
});
test.afterAll(() => rmSync(join(folder, ".."), { recursive: true, force: true }));

async function share(side: Side): Promise<void> {
  await side.frame.getByRole("button", { name: "My library" }).click();
  await side.frame.locator("[data-testid=pick-folder]").setInputFiles(folder);
  await expect(side.frame.getByTestId("my-card").first()).toBeVisible({ timeout: 20_000 });
  await expect(side.frame.getByTestId("reading")).toHaveCount(0, { timeout: 20_000 });
}

const video = (side: Side) => side.frame.getByTestId("video");

/** Some engine builds have no H.264 (Playwright's WebKit on Linux may not): the stream tests then say so and stop. */
async function skipWithoutH264(side: Side): Promise<void> {
  const ok = await side.frame.evaluate(() => {
    const ctor = (window as unknown as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource }).MediaSource ?? (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
    return !!ctor && ctor.isTypeSupported('video/mp4; codecs="avc1.4d400b, mp4a.40.2"');
  });
  test.skip(!ok, "this browser build plays no H.264 with AAC in Media Source");
}
const time = (side: Side) => video(side).evaluate((v: HTMLVideoElement) => v.currentTime);

test("Ana streams Miguel's film: plays, seeks ahead, subtitles, resume", async ({ browser, browserName }) => {
  test.setTimeout(120_000);
  const room: Chat = await chat();
  const errors: string[] = [];
  try {
    const miguel = await openSide(browser, room, { name: "miguel", displayName: "Miguel" });
    const ana = await openSide(browser, room, { name: "ana", displayName: "Ana", locale: "pt-BR" });
    for (const side of [miguel, ana]) side.page.on("pageerror", (e) => errors.push(`${side.name}: ${e.message}`));
    await skipWithoutH264(ana);

    // Before Miguel shares, Ana sees that he has not.
    await expect(ana.frame.getByTestId("empty")).toContainText("Miguel ainda não compartilhou");
    await share(miguel);
    await expect(miguel.frame.getByTestId("convert")).toContainText('ffmpeg -i "Old.Film.1999.mkv" -map 0:v:0 -map 0:a? -c:v copy -c:a aac -b:a 192k -movflags +faststart "Old.Film.1999.mp4"');

    // Ana's library: the film, the show, the MKV dimmed.
    await expect(ana.frame.getByTestId("row-films")).toContainText("Test Pattern");
    await expect(ana.frame.getByTestId("row-series")).toContainText("Tones");
    await ana.frame.getByTestId("row-films").getByTestId("card").filter({ hasText: "Old Film" }).click();
    await expect(ana.frame.getByTestId("problem")).toHaveText("Precisa converter para MP4");
    await ana.frame.getByRole("button", { name: "Fechar" }).click();

    // Play the film: it streams from Miguel.
    await ana.frame.getByTestId("row-films").getByTestId("card").filter({ hasText: "Test Pattern" }).click();
    await ana.frame.getByTestId("play").click();
    await expect(ana.frame.getByTestId("player")).toBeVisible();
    await expect.poll(() => time(ana), { timeout: 30_000 }).toBeGreaterThan(1.5);

    // The pt-BR subtitles were turned on by themselves (the film's audio is not Portuguese).
    await expect(ana.frame.getByTestId("subtitles")).toHaveValue(/.+/);
    const cue = () =>
      video(ana).evaluate((v: HTMLVideoElement) => {
        const t = Array.from(v.textTracks).find((x) => x.mode === "showing");
        return t?.cues?.[0] ? (t.cues[0] as VTTCue).text : null;
      });
    await expect.poll(cue).toBe("Legenda em português");

    // Seek to 70 s, into what was never sent: it plays from there.
    await video(ana).evaluate((v: HTMLVideoElement) => (v.currentTime = 70));
    await expect.poll(() => time(ana), { timeout: 30_000 }).toBeGreaterThan(71);
    expect(await video(ana).evaluate((v: HTMLVideoElement) => v.error)).toBeNull();

    // Back: the film waits under Continue watching, with how far she got.
    await video(ana).evaluate((v: HTMLVideoElement) => v.pause());
    await ana.frame.getByRole("button", { name: /Voltar/ }).click();
    await expect(ana.frame.getByTestId("row-continue")).toContainText("Test Pattern");
    const kept = [...ana.storage.keys()].filter((k) => k.startsWith("pos:"));
    expect(kept).toHaveLength(1);
    expect(JSON.parse(ana.storage.get(kept[0])!)[0]).toBeGreaterThan(70);

    // The relay never had to refuse a frame as too fast, and nothing broke the runner's policy.
    expect(miguel.tooFast + ana.tooFast).toBe(0);
    expect(await violations(miguel)).toEqual([]);
    expect(await violations(ana)).toEqual([]);

    // Miguel's app reloads: his library stays, Ana still browses, a film waits for the folder.
    await closeSide(room, miguel);
    const again = await openSide(browser, room, { name: "miguel", displayName: "Miguel" });
    await again.frame.getByRole("button", { name: "My library" }).click();
    await expect(again.frame.getByTestId("pick-again")).toBeVisible();
    await ana.frame.getByTestId("row-continue").getByTestId("card").click();
    await ana.frame.getByTestId("play").click();
    await expect(ana.frame.getByTestId("status")).toContainText("Miguel precisa escolher a pasta de novo");
    expect(errors, browserName).toEqual([]);
  } finally {
    await room.close();
  }
});

test("an episode, and the next one from the player", async ({ browser }) => {
  test.setTimeout(90_000);
  const room = await chat();
  try {
    const miguel = await openSide(browser, room, { name: "miguel", displayName: "Miguel" });
    const ana = await openSide(browser, room, { name: "ana", displayName: "Ana" });
    await skipWithoutH264(ana);
    await share(miguel);
    await ana.frame.getByTestId("row-series").getByTestId("card").click();
    await expect(ana.frame.getByTestId("episodes")).toContainText("Low");
    await ana.frame.getByTestId("episode").first().click();
    await expect.poll(() => time(ana), { timeout: 30_000 }).toBeGreaterThan(1);
    // Near the end, "Next episode".
    await video(ana).evaluate((v: HTMLVideoElement) => (v.currentTime = 5));
    await expect(ana.frame.getByTestId("next")).toBeVisible({ timeout: 20_000 });
    await ana.frame.getByTestId("next").click();
    await expect(ana.frame.locator(".now")).toContainText("S1 E2");
    await expect.poll(() => time(ana), { timeout: 30_000 }).toBeGreaterThan(1);
  } finally {
    await room.close();
  }
});

test("the layout fits a phone and Desktop's chat window without sideways scrolling", async ({ browser }) => {
  test.setTimeout(90_000);
  const room = await chat();
  try {
    for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 560, height: 640 }, { width: 1280, height: 800 }]) {
      const side = await openSide(browser, room, { name: `alone-${viewport.width}`, inChat: false, contextOptions: { viewport } });
      await side.frame.locator("[data-testid=pick-folder]").setInputFiles(folder);
      await expect(side.frame.getByTestId("my-card").first()).toBeVisible({ timeout: 20_000 });
      const overflow = await side.frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${viewport.width}px`).toBeLessThanOrEqual(0);
      await side.context.close();
      room.sides.delete(side.name);
    }
  } finally {
    await room.close();
  }
});
