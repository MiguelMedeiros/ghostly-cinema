/**
 * The app's storage (`ghostly.storage`: per app and per chat, 5 MiB, 64 KiB a value) for values bigger than one
 * value: kept as pieces under `<name>:0`, `<name>:1`… with `<name>` holding how many. A reader that finds a piece
 * missing (a write cut short) gets nothing rather than half a value.
 */
import type { MiniAppApi, MiniAppJson } from "./vendor/miniApp.ts";

/** Bytes of UTF-8 per piece: as a JSON string, escapes at most double it, under 64 KiB. */
const PIECE_BYTES = 28_000;

/** Splits text into pieces of at most `max` UTF-8 bytes, never inside a character. */
export function pieces(text: string, max = PIECE_BYTES): string[] {
  const out: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i)!;
    const len = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    const step = code >= 0x10000 ? 2 : 1;
    if (bytes + len > max) {
      out.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += len;
    i += step;
  }
  if (start < text.length || !out.length) out.push(text.slice(start));
  return out;
}

export async function putLarge(api: MiniAppApi, name: string, value: MiniAppJson): Promise<void> {
  const parts = pieces(JSON.stringify(value));
  const before = await api.storage.get(name);
  // A new generation's pieces first, then the head that names them, then the old pieces: a reader sees the old value
  // or the new one, never a mix.
  const gen = typeof before === "object" && before && !Array.isArray(before) && typeof before.g === "number" ? before.g + 1 : 1;
  for (let i = 0; i < parts.length; i++) await api.storage.set(`${name}:${gen}:${i}`, parts[i]);
  await api.storage.set(name, { g: gen, n: parts.length });
  if (typeof before === "object" && before && !Array.isArray(before) && typeof before.g === "number" && typeof before.n === "number") {
    for (let i = 0; i < before.n; i++) await api.storage.delete(`${name}:${before.g}:${i}`).catch(() => {});
  }
}

export async function getLarge(api: MiniAppApi, name: string): Promise<unknown> {
  const head = await api.storage.get(name);
  if (!head || typeof head !== "object" || Array.isArray(head) || typeof head.g !== "number" || typeof head.n !== "number" || head.n > 1000) return undefined;
  let text = "";
  for (let i = 0; i < head.n; i++) {
    const part = await api.storage.get(`${name}:${head.g}:${i}`);
    if (typeof part !== "string") return undefined;
    text += part;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function deleteLarge(api: MiniAppApi, name: string): Promise<void> {
  const head = await api.storage.get(name);
  if (head && typeof head === "object" && !Array.isArray(head) && typeof head.g === "number" && typeof head.n === "number") {
    for (let i = 0; i < head.n; i++) await api.storage.delete(`${name}:${head.g}:${i}`).catch(() => {});
  }
  await api.storage.delete(name);
}
