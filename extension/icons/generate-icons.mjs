// Zero-dependency icon generator: a Brave-orange rounded tile with a white lightning
// bolt, rendered at 16/32/48/128 and encoded as PNG with Node's built-in zlib.
// Run:  node extension/icons/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = dirname(fileURLToPath(import.meta.url));

// ---- PNG (RGBA, 8-bit) ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};
function png(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- geometry (normalized 0..1) ----
const inRoundRect = (x, y, m, r) => {
  const lo = m;
  const hi = 1 - m;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
};
const inPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const ORANGE = [0xfb, 0x54, 0x2b];
const WHITE = [0xff, 0xff, 0xff];
const BOLT = [
  [0.6, 0.09],
  [0.35, 0.52],
  [0.5, 0.52],
  [0.4, 0.91],
  [0.69, 0.44],
  [0.52, 0.44],
];

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // supersample for smooth edges
  const m = 0.055;
  const r = 0.2;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundRect(x, y, m, r)) continue;
          const col = inPoly(x, y, BOLT) ? WHITE : ORANGE;
          rs += col[0];
          gs += col[1];
          bs += col[2];
          covered++;
        }
      }
      const idx = (py * size + px) * 4;
      if (covered) {
        rgba[idx] = Math.round(rs / covered);
        rgba[idx + 1] = Math.round(gs / covered);
        rgba[idx + 2] = Math.round(bs / covered);
      }
      rgba[idx + 3] = Math.round((covered / (SS * SS)) * 255);
    }
  }
  return rgba;
}

for (const size of [16, 32, 48, 128]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log('wrote', file);
}
