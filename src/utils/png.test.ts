import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { decodePng, encodePng, cropPng, RgbImage } from "./png.js";

/** A gradient with a distinctive pixel at (x,y) so a crop's origin is provable. */
function makeImage(width: number, height: number, mark?: { x: number; y: number }): RgbImage {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x + y) % 256;
    }
  }
  if (mark) {
    const i = (mark.y * width + mark.x) * 3;
    data[i] = 254;
    data[i + 1] = 1;
    data[i + 2] = 128;
  }
  return { width, height, data };
}

function pixel(img: RgbImage, x: number, y: number): number[] {
  const i = (y * img.width + x) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

describe("encodePng / decodePng", () => {
  it("round-trips pixels exactly", () => {
    const src = makeImage(17, 9);
    const back = decodePng(encodePng(src));
    expect(back.width).toBe(17);
    expect(back.height).toBe(9);
    expect(back.data.equals(src.data)).toBe(true);
  });

  it("reads RGBA as well as RGB", () => {
    // stb writes RGB, but a capture path that grows an alpha channel should
    // not silently produce a colour-shifted image.
    const rgba = Buffer.alloc(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
      rgba[i * 4] = 10 + i;
      rgba[i * 4 + 1] = 20 + i;
      rgba[i * 4 + 2] = 30 + i;
      rgba[i * 4 + 3] = 255;
    }
    const png = rawPng(2, 2, 4, rgba);
    const img = decodePng(png);
    expect(pixel(img, 1, 1)).toEqual([13, 23, 33]);
  });

  it("undoes every filter type", () => {
    // stb picks a filter per row; a decoder that only handles None returns a
    // smeared image rather than an error, so each type gets encoded for real
    // and has to come back byte-identical.
    const src = makeImage(9, 6);
    for (const filter of [0, 1, 2, 3, 4]) {
      const back = decodePng(rawPngDeflated(9, 6, 3, filterRows(src, filter)));
      expect(back.data.equals(src.data), `filter ${filter}`).toBe(true);
    }
  });

  it("refuses a file that is not a PNG", () => {
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(/signature/);
  });

  it("refuses a bit depth it cannot read rather than returning noise", () => {
    const png = encodePng(makeImage(2, 2));
    // IHDR body starts 8 (signature) + 8 (chunk header) bytes in; bit depth
    // is its 9th byte.
    png[8 + 8 + 8] = 16;
    expect(() => decodePng(png)).toThrow(/bit depth/);
  });
});

describe("cropPng", () => {
  it("takes the rectangle asked for, at the offset asked for", () => {
    const src = makeImage(40, 30, { x: 12, y: 7 });
    const out = decodePng(cropPng(encodePng(src), 12, 7, 10, 5));
    expect(out.width).toBe(10);
    expect(out.height).toBe(5);
    // The marked pixel was the crop's top-left corner.
    expect(pixel(out, 0, 0)).toEqual([254, 1, 128]);
    expect(pixel(out, 3, 2)).toEqual(pixel(src, 15, 9));
  });

  it("crops the LCD rectangle out of a full emulator window", () => {
    // The real geometry: a 490x714 window with the 320x240 panel at (85, 58).
    const src = makeImage(490, 714, { x: 85, y: 58 });
    const out = decodePng(cropPng(encodePng(src), 85, 58, 320, 240));
    expect([out.width, out.height]).toEqual([320, 240]);
    expect(pixel(out, 0, 0)).toEqual([254, 1, 128]);
    // The bottom row of the panel — the 18 rows the simulator's own crop lost.
    expect(pixel(out, 0, 239)).toEqual(pixel(src, 85, 297));
  });

  it("refuses a rectangle that runs off the image", () => {
    const png = encodePng(makeImage(100, 100));
    expect(() => cropPng(png, 85, 58, 320, 240)).toThrow(/does not fit/);
  });
});

// ── helpers that build PNGs this module does not itself write ───────────────

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
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

/** Assemble a PNG from unfiltered pixel rows with `channels` bytes per pixel. */
function rawPng(width: number, height: number, channels: number, pixels: Buffer): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return rawPngDeflated(width, height, channels, raw);
}

/** Same, but `raw` already carries its own per-row filter bytes. */
function rawPngDeflated(width: number, height: number, channels: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Encode every row of `img` with one PNG filter type, producing IDAT input. */
function filterRows(img: RgbImage, filter: number): Buffer {
  const bpp = 3;
  const stride = img.width * bpp;
  const out = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    out[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const cur = img.data[y * stride + i];
      const a = i >= bpp ? img.data[y * stride + i - bpp] : 0;
      const b = y > 0 ? img.data[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= bpp ? img.data[(y - 1) * stride + i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 1: v = cur - a; break;
        case 2: v = cur - b; break;
        case 3: v = cur - ((a + b) >> 1); break;
        case 4: v = cur - paeth(a, b, c); break;
        default: v = cur;
      }
      out[y * (stride + 1) + 1 + i] = v & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
