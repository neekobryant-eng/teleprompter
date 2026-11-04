// Draws the app icons as PNGs with no dependencies:  node tools/make-icons.mjs
// The picture is the prompter itself: lines of text, the reading line, and its two yellow carets.
// "any" icons have rounded corners; the maskable icon is full-bleed with the art inside the
// safe circle, so Android can crop it to any shape.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x16, 0x18, 0x1f];
const BAND = [0x2b, 0x2e, 0x38];
const BRIGHT = [0xf4, 0xf4, 0xf2];
const TEXT = [0xc4, 0xc7, 0xcf];
const DIM = [0x5b, 0x60, 0x6e];
const ACCENT = [0xf5, 0xb8, 0x3d];

// Shapes in unit coordinates (0..1) for the art box.
const ART = [
  { kind: 'rect', x0: 0.0, x1: 1.0, y0: 0.40, y1: 0.60, r: 0.03, color: BAND },
  { kind: 'rect', x0: 0.17, x1: 0.68, y0: 0.16, y1: 0.24, r: 0.04, color: DIM },
  { kind: 'rect', x0: 0.17, x1: 0.58, y0: 0.29, y1: 0.37, r: 0.04, color: DIM },
  { kind: 'rect', x0: 0.17, x1: 0.83, y0: 0.46, y1: 0.54, r: 0.04, color: BRIGHT },
  { kind: 'rect', x0: 0.17, x1: 0.76, y0: 0.63, y1: 0.71, r: 0.04, color: TEXT },
  { kind: 'rect', x0: 0.17, x1: 0.50, y0: 0.76, y1: 0.84, r: 0.04, color: TEXT },
  { kind: 'tri', pts: [[0.02, 0.44], [0.10, 0.5], [0.02, 0.56]], color: ACCENT },
  { kind: 'tri', pts: [[0.98, 0.44], [0.90, 0.5], [0.98, 0.56]], color: ACCENT },
];

function insideRoundRect(x, y, { x0, x1, y0, y1, r }) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insideTri(x, y, [[ax, ay], [bx, by], [cx, cy]]) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** size: pixels; maskable: full-bleed tile; art box is where the unit art is drawn (fractions of the tile). */
function draw(size, { maskable }) {
  const tile = maskable ? { x0: 0, x1: 1, y0: 0, y1: 1, r: 0 } : { x0: 0, x1: 1, y0: 0, y1: 1, r: 0.22 };
  const pad = maskable ? 0.22 : 0.15;          // maskable art box corners stay inside the 80% safe circle
  const box = { x0: pad, y0: pad, s: 1 - 2 * pad };
  const SS = 4;                                // 4x4 supersampling for smooth edges
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = (i + (si + 0.5) / SS) / size, y = (j + (sj + 0.5) / SS) / size;
          if (!insideRoundRect(x, y, tile)) continue;
          let c = BG;
          const ux = (x - box.x0) / box.s, uy = (y - box.y0) / box.s;
          for (const sh of ART) {
            const hit = sh.kind === 'rect' ? insideRoundRect(ux, uy, sh) : insideTri(ux, uy, sh.pts);
            if (hit) c = sh.color;
          }
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS, o = (j * size + i) * 4;
      // Colours are averaged only over covered samples; alpha carries the edge coverage.
      const cov = a / 255;
      px[o] = cov ? Math.round(r / cov) : 0;
      px[o + 1] = cov ? Math.round(g / cov) : 0;
      px[o + 2] = cov ? Math.round(b / cov) : 0;
      px[o + 3] = Math.round(a / n);
    }
  }
  return png(size, size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = buf => { let c = -1; for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const files = {
  'icon-192.png': draw(192, { maskable: false }),
  'icon-512.png': draw(512, { maskable: false }),
  'icon-maskable-512.png': draw(512, { maskable: true }),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(new URL(name, out), data);
  console.log(`icons/${name}  ${data.length} bytes`);
}
