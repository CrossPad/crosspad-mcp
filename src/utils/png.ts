/**
 * Just enough PNG to cut a rectangle out of a simulator screenshot.
 *
 * The simulator encodes with stb_image_write — 8-bit, non-interlaced, no
 * palette — so this handles that shape (RGB and RGBA in, RGB out) and refuses
 * anything else loudly rather than returning a scrambled image. A real image
 * library would be a dependency for one 320x240 crop.
 */

import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decoded pixels, three bytes per pixel, row-major. */
export interface RgbImage {
  width: number;
  height: number;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit non-interlaced RGB/RGBA PNG into packed RGB bytes. */
export function decodePng(png: Buffer): RgbImage {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("not a PNG (bad signature)");
  }

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (expected 8)`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported PNG color type ${colorType} (expected RGB or RGBA)`);
      if (interlace !== 0) throw new Error("interlaced PNG is not supported");
      channels = colorType === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      // stb splits the pixel stream across several IDATs; the zlib stream is
      // their concatenation, so inflating them one by one would fail.
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!width || !height || !channels) throw new Error("PNG has no IHDR");
  if (idat.length === 0) throw new Error("PNG has no IDAT");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG pixel data is truncated");

  const out = Buffer.alloc(width * height * 3);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: line[i] = (line[i] + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`unknown PNG filter type ${filter}`);
      }
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 3;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
    }
    line.copy(prev);
  }

  return { width, height, data: out };
}

/** Encode packed RGB bytes as an 8-bit RGB PNG (filter type 0 on every row). */
export function encodePng(img: RgbImage): Buffer {
  const { width, height, data } = img;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Cut `w`x`h` at (`x`,`y`) out of a PNG and re-encode it. */
export function cropPng(png: Buffer, x: number, y: number, w: number, h: number): Buffer {
  const img = decodePng(png);
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > img.width || y + h > img.height) {
    throw new Error(`crop ${w}x${h}+${x}+${y} does not fit in ${img.width}x${img.height}`);
  }
  const out = Buffer.alloc(w * h * 3);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 3;
    img.data.copy(out, row * w * 3, from, from + w * 3);
  }
  return encodePng({ width: w, height: h, data: out });
}
