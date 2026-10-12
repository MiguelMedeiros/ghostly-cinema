// Subtitles: SRT and WebVTT, UTF-8 and Windows-1252, markup taken out, bad blocks skipped.
import { describe, expect, it } from "vitest";
import { decodeText, parseSubtitles, parseTimestamp, shiftCues } from "../src/subtitles.ts";

const SRT = `1
00:00:01,000 --> 00:00:02,500
<i>Olá,</i> mundo!

2
00:00:03,000 --> 00:00:04,000
{\\an8}Segunda linha
com quebra

3
00:00:05,000 --> 00:00:04,000
fim antes do começo

4
bad --> time
x
`;

describe("subtitles", () => {
  it("reads SRT, with its markup taken out", () => {
    expect(parseSubtitles(SRT)).toEqual([
      { start: 1, end: 2.5, text: "Olá, mundo!" },
      { start: 3, end: 4, text: "Segunda linha\ncom quebra" },
    ]);
  });

  it("reads WebVTT with settings and short times", () => {
    const vtt = "WEBVTT\n\nNOTE a note\n\nid-1\n01:02.500 --> 01:04.000 align:start position:10%\n<v Ana>Hi</v>\n";
    expect(parseSubtitles(vtt)).toEqual([{ start: 62.5, end: 64, text: "Hi" }]);
  });

  it("reads Windows-1252 when the bytes are not UTF-8", () => {
    const latin = new Uint8Array([0x63, 0x6f, 0x72, 0x61, 0xe7, 0xe3, 0x6f]); // "coração" in Windows-1252
    expect(decodeText(latin)).toBe("coração");
    expect(decodeText(new TextEncoder().encode("coração"))).toBe("coração");
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
  });

  it("reads times", () => {
    expect(parseTimestamp("01:02:03,004")).toBe(3723.004);
    expect(parseTimestamp("02:03.5")).toBe(123.5);
    expect(parseTimestamp("00:61:00,000")).toBeNaN();
    expect(parseTimestamp("x")).toBeNaN();
  });

  it("moves cues in time", () => {
    expect(shiftCues([{ start: 1, end: 2, text: "a" }, { start: 0, end: 0.5, text: "b" }], -0.75)).toEqual([{ start: 0.25, end: 1.25, text: "a" }]);
  });
});
