// What the player asks for next: carry on, seek, wait, or end.
import { describe, expect, it } from "vitest";
import { AHEAD, nextAsk } from "../src/player.ts";

const seg = (start: number, end: number, to: number, last = false) => ({ start, end, to, last });

describe("the next fragment", () => {
  it("starts with the time asked, and carries on from the last fragment", () => {
    expect(nextAsk(0, [], [], 100)).toEqual({ at: 0 });
    expect(nextAsk(1, [{ start: 0, end: 4 }], [seg(0, 4, 100)], 100)).toEqual({ from: 100 });
  });

  it("waits with enough ahead, and ends after the last fragment", () => {
    expect(nextAsk(1, [{ start: 0, end: 1 + AHEAD }], [seg(0, 1 + AHEAD, 100)], 1000)).toBeNull();
    expect(nextAsk(95, [{ start: 0, end: 100 }], [seg(90, 100, 2500, true)], 100)).toBe("end");
  });

  it("asks for the new time on a seek outside what is held", () => {
    expect(nextAsk(250, [{ start: 0, end: 40 }], [seg(0, 40, 1000)], 300)).toEqual({ at: 250 });
  });

  it("carries on when a seek's fragment ends just before the time asked (a high bitrate)", () => {
    // Seek to 250: the keyframe before it is at 248, and 1 MiB of an 8 Mbit/s film ends at 249.07.
    expect(nextAsk(250, [{ start: 0, end: 40 }, { start: 247.98, end: 249.07 }], [seg(0, 40, 1000), seg(248, 249.07, 6225)], 300)).toEqual({ from: 6225 });
  });
});
