/** Small helpers for reading and writing ISO BMFF boxes. */

/** Reads a file in ranges: a picked `File`, or bytes in a test. Nothing reads a whole film into memory. */
export interface RangeReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A picked file (any `Blob`), read in ranges with `slice`. */
export function blobReader(blob: Blob): RangeReader {
  return {
    size: blob.size,
    async read(offset, length) {
      const end = Math.min(blob.size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    },
  };
}

/** Bytes already in memory, read in ranges (tests, small files). */
export function bytesReader(bytes: Uint8Array): RangeReader {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(bytes.length, offset + length));
    },
  };
}

export const fourcc = (b: Uint8Array, at: number): string =>
  String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);

export const u16 = (b: Uint8Array, at: number): number => ((b[at] << 8) | b[at + 1]) >>> 0;
export const u32 = (b: Uint8Array, at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
export const i32 = (b: Uint8Array, at: number): number => u32(b, at) | 0;
export const u64 = (b: Uint8Array, at: number): number => u32(b, at) * 2 ** 32 + u32(b, at + 4);

/** A box inside a buffer: its type and where its payload is. */
export interface Box {
  type: string;
  /** Start of the box (its size field). */
  start: number;
  /** Start of the payload, after size, type and any 64-bit size. */
  body: number;
  /** End of the box. */
  end: number;
}

/** The boxes directly inside `[from, to)` of `b`. Stops at a malformed one. */
export function children(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at);
    const type = fourcc(b, at + 4);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = u64(b, at + 8);
      body = at + 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < body - at || at + size > to) break;
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

/** The first child box of `type`, or undefined. */
export function child(b: Uint8Array, box: Pick<Box, "body" | "end">, type: string, skip = 0): Box | undefined {
  return children(b, box.body + skip, box.end).find((c) => c.type === type);
}

/** Follows a path of box types from `box`, each the first child of that type. */
export function path(b: Uint8Array, box: Pick<Box, "body" | "end">, ...types: string[]): Box | undefined {
  let at: Pick<Box, "body" | "end"> | undefined = box;
  for (const type of types) {
    at = at && child(b, at, type);
    if (!at) return undefined;
  }
  return at as Box;
}

/** Writes boxes: a growing byte buffer with box nesting. */
export class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;
  private open: number[] = [];

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  get length(): number {
    return this.len;
  }

  u8(v: number): this {
    this.room(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    return this.u8(v >>> 8).u8(v);
  }
  u24(v: number): this {
    return this.u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  u32(v: number): this {
    this.room(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  i32(v: number): this {
    return this.u32(v >>> 0);
  }
  u64(v: number): this {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v % 2 ** 32);
  }
  bytes(b: Uint8Array): this {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }
  zeros(n: number): this {
    this.room(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }
  type(t: string): this {
    for (let i = 0; i < 4; i++) this.u8(t.charCodeAt(i));
    return this;
  }

  /** Opens a box; `full` adds a version and flags. */
  box(type: string, full?: { version: number; flags: number }): this {
    this.open.push(this.len);
    this.u32(0).type(type);
    if (full) this.u8(full.version).u24(full.flags);
    return this;
  }
  /** Closes the last box opened, writing its size. */
  end(): this {
    const start = this.open.pop();
    if (start === undefined) throw new Error("no open box");
    const size = this.len - start;
    this.buf[start] = (size >>> 24) & 0xff;
    this.buf[start + 1] = (size >>> 16) & 0xff;
    this.buf[start + 2] = (size >>> 8) & 0xff;
    this.buf[start + 3] = size & 0xff;
    return this;
  }
  /** Overwrites a 32-bit value written earlier. */
  patch32(at: number, v: number): void {
    this.buf[at] = (v >>> 24) & 0xff;
    this.buf[at + 1] = (v >>> 16) & 0xff;
    this.buf[at + 2] = (v >>> 8) & 0xff;
    this.buf[at + 3] = v & 0xff;
  }

  done(): Uint8Array {
    if (this.open.length) throw new Error("a box is still open");
    return this.buf.slice(0, this.len);
  }
}
