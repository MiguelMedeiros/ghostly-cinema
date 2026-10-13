// The line that makes a file playable, and the quality a film is shown with.
import { describe, expect, it } from "vitest";
import { convertCommand, qualityLabel } from "../src/convert.ts";

describe("converting", () => {
  it("copies the video and makes the audio AAC", () => {
    expect(convertCommand("Old.Film.1999.mkv")).toBe('ffmpeg -i "Old.Film.1999.mkv" -map 0:v:0 -map 0:a? -c:v copy -c:a aac -b:a 192k -movflags +faststart "Old.Film.1999.mp4"');
    // MP3 inside a MOV: the video stays, the audio becomes AAC.
    expect(convertCommand("Tears.mov", 'video/mp4; codecs="avc1.4d401f, mp4a.6b"')).toContain('-c:v copy -c:a aac');
  });

  it("never writes over the file it reads", () => {
    expect(convertCommand("Film.mp4", 'video/mp4; codecs="avc1.64001f, ac-3"')).toMatch(/"Film\.cinema\.mp4"$/);
  });

  it("encodes the video again only when browsers cannot decode it", () => {
    expect(convertCommand("Film.mp4", 'video/mp4; codecs="hvc1.1.6.L93.90, mp4a.40.2"')).toContain("-c:v libx264 -crf 20");
  });
});

describe("quality", () => {
  it("reads a widescreen film by its width", () => {
    expect(qualityLabel(1280, 534)).toBe("720p");
    expect(qualityLabel(1920, 800)).toBe("1080p");
    expect(qualityLabel(3840, 1600)).toBe("4K");
    expect(qualityLabel(640, 360)).toBe("SD");
    expect(qualityLabel(undefined, undefined)).toBeNull();
  });
});
