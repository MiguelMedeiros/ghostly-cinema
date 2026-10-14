// Draws Cinema's icon by code: the ghost behind a bucket of popcorn, under a film strip, on a square of 64 units, painted at 512 x 512 into assets/icon.png. The ghost is
// Ghostly's own (ghostly.tools/brand), as on Arena's and Boo Blocks's icons. No image library: shapes are filled here
// with anti-aliased edges and the PNG is written here (zlib from Node). Only + - * / and Math.sqrt touch the numbers,
// so every machine paints the same pixels; test/icon.test.ts checks the committed file is this script's picture.
//
//   npm run gen:icon            writes assets/icon.png
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** The drawing's units on a side, and the PNG's pixels on a side. */
export const UNITS = 64;
export const SIZE = 512;
const K = 0.5522847498307936; // a quarter circle as a cubic curve
const SUB = 16; // sub-rows sampled per row of pixels
const STEPS = 24; // segments per cubic curve

/** A colour from "#rrggbb". */
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// Ghostly's colours (ghostly.tools/brand, brand.json).
const BRAND = { night: hex("#060a10"), white: hex("#ffffff"), mist: hex("#e8edf5"), cyan: hex("#22d3ee"), amber: hex("#fbbf24"), rose: hex("#f472b6") };

/** Closed outlines made of points, in drawing units. Every shape here runs clockwise, so overlaps add up. */
class Path {
  constructor() {
    this.contours = [];
    this.cur = null;
  }
  move(x, y) {
    this.cur = [[x, y]];
    this.contours.push(this.cur);
    return this;
  }
  line(x, y) {
    this.cur.push([x, y]);
    return this;
  }
  cubic(x1, y1, x2, y2, x, y) {
    const [x0, y0] = this.cur[this.cur.length - 1];
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      this.cur.push([a * x0 + b * x1 + c * x2 + d * x, a * y0 + b * y1 + c * y2 + d * y]);
    }
    return this;
  }
  close() {
    this.cur = null;
    return this;
  }
  /** An ellipse; counter-clockwise (ccw) cuts a hole in what is drawn with it. */
  ellipse(cx, cy, rx, ry, ccw = false) {
    const kx = rx * K;
    const ky = ry * K;
    const s = ccw ? -1 : 1;
    this.move(cx + rx, cy);
    this.cubic(cx + rx, cy + s * ky, cx + kx, cy + s * ry, cx, cy + s * ry);
    this.cubic(cx - kx, cy + s * ry, cx - rx, cy + s * ky, cx - rx, cy);
    this.cubic(cx - rx, cy - s * ky, cx - kx, cy - s * ry, cx, cy - s * ry);
    this.cubic(cx + kx, cy - s * ry, cx + rx, cy - s * ky, cx + rx, cy);
    return this.close();
  }
  circle(cx, cy, r, ccw = false) {
    return this.ellipse(cx, cy, r, r, ccw);
  }
  /** A rectangle, its corners rounded by r. */
  rect(x, y, w, h, r = 0) {
    const k = r * (1 - K);
    this.move(x + r, y).line(x + w - r, y).cubic(x + w - k, y, x + w, y + k, x + w, y + r);
    this.line(x + w, y + h - r).cubic(x + w, y + h - k, x + w - k, y + h, x + w - r, y + h);
    this.line(x + r, y + h).cubic(x + k, y + h, x, y + h - k, x, y + h - r);
    this.line(x, y + r).cubic(x, y + k, x + k, y, x + r, y);
    return this.close();
  }
  poly(points) {
    this.move(...points[0]);
    for (const p of points.slice(1)) this.line(...p);
    return this.close();
  }
  /** A line from (x0, y0) to (x1, y1), `width` thick, with round ends. */
  stroke(x0, y0, x1, y1, width) {
    const len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    const r = width / 2;
    const [ux, uy] = [((x1 - x0) / len) * r, ((y1 - y0) / len) * r];
    const [nx, ny] = [-uy, ux];
    this.move(x0 - nx, y0 - ny).line(x1 - nx, y1 - ny);
    this.cubic(x1 - nx + ux * K, y1 - ny + uy * K, x1 + ux - nx * K, y1 + uy - ny * K, x1 + ux, y1 + uy);
    this.cubic(x1 + ux + nx * K, y1 + uy + ny * K, x1 + nx + ux * K, y1 + ny + uy * K, x1 + nx, y1 + ny);
    this.line(x0 + nx, y0 + ny);
    this.cubic(x0 + nx - ux * K, y0 + ny - uy * K, x0 - ux + nx * K, y0 - uy + ny * K, x0 - ux, y0 - uy);
    this.cubic(x0 - ux - nx * K, y0 - uy - ny * K, x0 - nx - ux * K, y0 - ny - uy * K, x0 - nx, y0 - ny);
    return this.close();
  }
  /** A copy scaled by s and moved by (dx, dy). */
  placed(s, dx, dy) {
    const out = new Path();
    out.contours = this.contours.map((c) => c.map(([x, y]) => [x * s + dx, y * s + dy]));
    return out;
  }
}

/** An SVG path's d, as far as the brand's ghost needs (M, L, H, V, C, Z, absolute and relative). */
function svgPath(d) {
  const path = new Path();
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)/g);
  let [i, x, y, sx, sy, cmd] = [0, 0, 0, 0, 0, ""];
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const [ox, oy] = rel ? [x, y] : [0, 0];
    switch (cmd.toUpperCase()) {
      case "M":
        [x, y] = [ox + num(), oy + num()];
        [sx, sy] = [x, y];
        path.move(x, y);
        cmd = rel ? "l" : "L";
        break;
      case "L":
        [x, y] = [ox + num(), oy + num()];
        path.line(x, y);
        break;
      case "H":
        x = ox + num();
        path.line(x, y);
        break;
      case "V":
        y = oy + num();
        path.line(x, y);
        break;
      case "C": {
        const [x1, y1, x2, y2] = [ox + num(), oy + num(), ox + num(), oy + num()];
        [x, y] = [ox + num(), oy + num()];
        path.cubic(x1, y1, x2, y2, x, y);
        break;
      }
      case "Z":
        path.close();
        [x, y] = [sx, sy];
        break;
      default:
        throw new Error(`path command ${cmd} is not drawn here`);
    }
  }
  return path;
}

/** SIZE x SIZE pixels of RGB, painted shape over shape with anti-aliased edges. */
class Canvas {
  constructor(background) {
    this.px = new Float64Array(SIZE * SIZE * 3);
    for (let i = 0; i < SIZE * SIZE; i++) this.px.set(background, i * 3);
  }

  /** Paints a path in a colour (inside: a nonzero winding), at an opacity. */
  fill(path, color, opacity = 1) {
    const s = SIZE / UNITS;
    const edges = [];
    let [top, bottom] = [SIZE, 0];
    for (const c of path.contours) {
      for (let k = 0; k < c.length; k++) {
        const [ax, ay] = c[k];
        const [bx, by] = c[(k + 1) % c.length];
        if (ay === by) continue;
        const e = ay < by ? { x0: ax * s, y0: ay * s, x1: bx * s, y1: by * s, w: 1 } : { x0: bx * s, y0: by * s, x1: ax * s, y1: ay * s, w: -1 };
        edges.push(e);
        top = Math.min(top, e.y0);
        bottom = Math.max(bottom, e.y1);
      }
    }
    // Each row of pixels: how much of each pixel the path covers, from SUB lines across it, the spans on each line
    // measured exactly.
    const cover = new Float64Array(SIZE + 1);
    for (let py = Math.max(0, Math.floor(top)); py <= Math.min(SIZE - 1, Math.ceil(bottom)); py++) {
      cover.fill(0);
      for (let k = 0; k < SUB; k++) {
        const sy = py + (k + 0.5) / SUB;
        const hits = [];
        for (const e of edges) if (sy >= e.y0 && sy < e.y1) hits.push([e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), e.w]);
        hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        let wind = 0;
        for (let h = 0; h < hits.length - 1; h++) {
          wind += hits[h][1];
          if (wind === 0) continue;
          const a = Math.max(0, hits[h][0]);
          const b = Math.min(SIZE, hits[h + 1][0]);
          if (b <= a) continue;
          const [ia, ib] = [Math.floor(a), Math.floor(b)];
          if (ia === ib) cover[ia] += (b - a) / SUB;
          else {
            cover[ia] += (ia + 1 - a) / SUB;
            for (let x = ia + 1; x < ib; x++) cover[x] += 1 / SUB;
            cover[ib] += (b - ib) / SUB;
          }
        }
      }
      for (let x = 0; x < SIZE; x++) {
        const alpha = Math.min(1, cover[x]) * opacity;
        if (alpha <= 0) continue;
        const i = (py * SIZE + x) * 3;
        for (let ch = 0; ch < 3; ch++) this.px[i + ch] += (color[ch] - this.px[i + ch]) * alpha;
      }
    }
    return this;
  }
}

// The brand's ghost (brand.json logo.iconPath and eyes, the tile's shine in the eyes), in its own 40-unit box.
const GHOST_D =
  "M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z";

/** The ghost, scaled by s and moved by (dx, dy): white, its eyes with their shine, rose cheeks. */
function ghost(canvas, s, dx, dy) {
  canvas.fill(svgPath(GHOST_D).placed(s, dx, dy), BRAND.white);
  canvas.fill(new Path().circle(13, 20, 3).circle(27, 20, 3).placed(s, dx, dy), BRAND.night);
  canvas.fill(new Path().circle(14, 18.5, 1.2).circle(28, 18.5, 1.2).placed(s, dx, dy), BRAND.white);
  canvas.fill(new Path().ellipse(9.5, 25, 2.2, 1.3).ellipse(30.5, 25, 2.2, 1.3).placed(s, dx, dy), BRAND.rose, 0.55);
}

/** Cinema's picture: the ghost behind a bucket of popcorn, a film strip running behind it, on violet. */
export function drawIcon() {
  const C = { bg: hex("#2a1650"), strip: hex("#120a24"), red: hex("#ef4444"), paper: hex("#fff7ed"), corn: hex("#fcd34d"), butter: hex("#f59e0b"), puff: hex("#fffbeb") };
  const canvas = new Canvas(C.bg);
  const holes = new Path();
  for (let x = 1.5; x < 64; x += 5) holes.rect(x, 7.5, 2.6, 2.4, 0.5).rect(x, 15.1, 2.6, 2.4, 0.5);
  canvas.fill(new Path().rect(0, 6, 64, 13), C.strip).fill(holes, C.bg);
  ghost(canvas, 1.08, 10.4, 2.7);
  // The popcorn and its bucket are drawn in a 64-unit box, then made a little larger about the bucket's foot.
  const z = (p) => p.placed(1.12, 32 - 32 * 1.12, 60 - 60 * 1.12);
  const corn = new Path();
  for (const [x, y, r] of [[22, 38, 3.6], [27, 36, 4], [32, 35, 4.2], [37, 36, 4], [42, 38, 3.6], [25, 39.5, 3.4], [32, 39, 3.6], [39, 39.5, 3.4]]) corn.circle(x, y, r);
  canvas.fill(z(corn), C.corn);
  const butter = new Path();
  for (const [x, y, r] of [[22.4, 39.6, 1.3], [27.6, 37.2, 1.4], [33, 36.6, 1.5], [38, 37.6, 1.4], [42.2, 39.8, 1.2], [30.4, 40.4, 1.2], [35.8, 40.6, 1.2]]) butter.circle(x, y, r);
  canvas.fill(z(butter), C.butter, 0.6);
  const puffs = new Path();
  for (const [x, y, r] of [[26, 34.6, 1.1], [31.2, 33.4, 1.2], [36.4, 34.4, 1.1], [21.2, 36.8, 0.9], [41.6, 36.8, 0.9]]) puffs.circle(x, y, r);
  canvas.fill(z(puffs), C.puff);
  // The bucket: wider at the top, five stripes, red and paper, and a paper rim.
  const [top, bottom, xl0, xr0, xl1, xr1, n] = [40, 59, 19, 45, 22.5, 41.5, 5];
  canvas.fill(z(new Path().poly([[xl0, top], [xr0, top], [xr1, bottom], [xl1, bottom]])), C.paper);
  const red = new Path();
  for (let i = 0; i < n; i += 2) {
    const at = (a, b, j) => a + ((b - a) * j) / n;
    red.poly([[at(xl0, xr0, i), top], [at(xl0, xr0, i + 1), top], [at(xl1, xr1, i + 1), bottom], [at(xl1, xr1, i), bottom]]);
  }
  canvas.fill(z(red), C.red);
  canvas.fill(z(new Path().rect(xl0 - 1, top - 1, xr0 - xl0 + 2, 3, 1)), C.paper);
  return canvas;
}

/** The picture as PNG scanlines: each row a filter byte (0, none) and SIZE pixels of RGB, 8 bits each. */
export function pixels() {
  const { px } = drawIcon();
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
  for (let y = 0; y < SIZE; y++) {
    const at = y * (1 + SIZE * 3);
    for (let x = 0; x < SIZE * 3; x++) raw[at + 1 + x] = Math.max(0, Math.min(255, Math.round(px[y * SIZE * 3 + x])));
  }
  return raw;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

/** The icon as PNG bytes: RGB, 8 bits, SIZE on a side. */
export function iconPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels(), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export const ICON = resolve(fileURLToPath(new URL("..", import.meta.url)), "assets/icon.png");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const png = iconPng();
  writeFileSync(ICON, png);
  console.log(`assets/icon.png ${png.length} bytes, ${SIZE} x ${SIZE}`);
}
