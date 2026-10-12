// Bytes between two sides over apps/1: chunked, under the frame limits, through a channel that pushes back, and
// safe against what a hostile contact sends.
import { describe, expect, it } from "vitest";
import { CHUNK_BYTES, Link, LinkError, type Ask, type Reply } from "../src/link.ts";
import { MINI_APP_LIMITS } from "../src/vendor/miniApp.ts";
import { chatPair, peakPerSecond, type MockBroker } from "./mockBroker.ts";

const random = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 2654435761) >>> 24;
  return b;
};

function pair(serve: (ask: Ask) => Promise<Reply>) {
  const [owner, guest] = chatPair();
  owner.launch();
  guest.launch();
  const server = new Link(owner, { serve });
  const client = new Link(guest);
  server.setPeer(true);
  client.setPeer(true);
  return { owner, guest, server, client };
}

const frameSizes = (b: MockBroker) => b.sent.map((s) => new TextEncoder().encode(JSON.stringify(s.value)).length);

describe("a transfer", () => {
  it("carries bytes whole, in frames under 32 KiB, and never more than 48 a second", async () => {
    const data = random(CHUNK_BYTES * 60 + 123);
    const { owner, guest, client } = pair(async (ask) => ({ meta: { kind: ask.k, id: ask.id ?? null }, bytes: data }));
    const seen: number[] = [];
    const reply = await client.request({ k: "seg", id: "film", from: 0 }, { onProgress: (n) => seen.push(n) });
    expect(reply.bytes).toEqual(data);
    expect(reply.meta).toEqual({ kind: "seg", id: "film" });
    expect(Math.max(...frameSizes(owner))).toBeLessThanOrEqual(MINI_APP_LIMITS.chatDataBytes);
    expect(peakPerSecond(owner.sent)).toBeLessThanOrEqual(48);
    expect(peakPerSecond(guest.sent)).toBeLessThanOrEqual(48);
    expect(owner.refused.get("too-fast") ?? 0).toBe(0);
    expect(seen.at(-1)).toBe(data.length);
  }, 15_000);

  it("gets through a channel with a small send budget, sending refused frames again", async () => {
    const data = random(CHUNK_BYTES * 20);
    const { owner, client, server } = pair(async () => ({ bytes: data }));
    owner.channel = { budgetBytes: 100 * 1024, latencyMs: 30 };
    const reply = await client.request({ k: "pic", id: "x" });
    expect(reply.bytes).toEqual(data);
    expect(owner.refused.get("offline")).toBeGreaterThan(0);
    expect(server.stats().retries).toBeGreaterThan(0);
  }, 15_000);

  it("sends nothing but a header for no bytes", async () => {
    const { client } = pair(async () => ({ meta: { empty: true }, bytes: new Uint8Array(0) }));
    const reply = await client.request({ k: "cat" });
    expect(reply.bytes.length).toBe(0);
    expect(reply.meta).toEqual({ empty: true });
  });

  it("passes the other side's refusal", async () => {
    const { client } = pair(async () => {
      throw new LinkError("not-found");
    });
    await expect(client.request({ k: "seg", id: "gone" })).rejects.toThrow("not-found");
  });

  it("says no-library when this side shares nothing", async () => {
    const [a, b] = chatPair();
    a.launch();
    b.launch();
    new Link(a);
    const client = new Link(b);
    client.setPeer(true);
    await expect(client.request({ k: "cat" })).rejects.toThrow("no-library");
  });

  it("serves several requests at once", async () => {
    const { client } = pair(async (ask) => ({ bytes: random(ask.k === "pic" ? 5000 : CHUNK_BYTES * 5) }));
    const [a, b, c] = await Promise.all([client.request({ k: "seg", from: 0 }), client.request({ k: "pic", id: "1" }), client.request({ k: "pic", id: "2" })]);
    expect([a.bytes.length, b.bytes.length, c.bytes.length]).toEqual([CHUNK_BYTES * 5, 5000, 5000]);
  }, 15_000);

  it("stops when the contact closes the app, and when cancelled", async () => {
    const data = random(CHUNK_BYTES * 200);
    const { owner, guest, client } = pair(async () => ({ bytes: data }));
    const going = client.request({ k: "seg", from: 0 });
    await new Promise((r) => setTimeout(r, 300));
    owner.shutdown();
    await expect(going).rejects.toThrow("peer-closed");
    expect(guest.isOpen).toBe(true);

    const second = pair(async () => ({ bytes: data }));
    const abort = new AbortController();
    const cancelled = second.client.request({ k: "seg", from: 0 }, { signal: abort.signal });
    await new Promise((r) => setTimeout(r, 300));
    abort.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    await new Promise((r) => setTimeout(r, 400));
    const sentAfter = second.owner.sent.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(second.owner.sent.length).toBe(sentAfter);
  }, 15_000);
});

describe("what a hostile contact sends", () => {
  it("drops frames that are not ours, and bad chunks, without failing", async () => {
    const data = random(CHUNK_BYTES * 3);
    const { guest, client } = pair(async () => ({ bytes: data }));
    const going = client.request({ k: "pic", id: "p" });
    for (const junk of [null, 1, "x", [], { t: "dat", r: 1, i: 0, b: "!!!" }, { t: "dat", r: 1, i: 99, b: "AAAA" }, { t: "dat", r: 1, i: 0, b: "AAAA" },
      { t: "hdr", r: 1, n: -5 }, { t: "hdr", r: 99, n: 10 }, { t: "err", r: 99, e: "x" }, { t: "ack", r: "1", i: 1 }, { t: "get", r: 0 }]) {
      guest.inject(junk);
    }
    expect((await going).bytes).toEqual(data);
  });

  it("refuses a request it cannot read", async () => {
    const asked: Ask[] = [];
    const { owner } = pair(async (ask) => {
      asked.push(ask);
      return { bytes: new Uint8Array(1) };
    });
    owner.inject({ t: "get", r: 7, k: "rm -rf" });
    owner.inject({ t: "get", r: 8, k: "seg", from: -1 });
    owner.inject({ t: "get", r: 9, k: "seg", at: 1e12 });
    owner.inject({ t: "get", r: 10, k: "sub", s: "x".repeat(500) });
    await new Promise((r) => setTimeout(r, 100));
    expect(asked).toEqual([]);
    const errors = owner.sent.map((s) => s.value as { t: string; e?: string }).filter((v) => v.t === "err");
    expect(errors.map((e) => e.e)).toEqual(["bad-request", "bad-request", "bad-request", "bad-request"]);
  });
});
