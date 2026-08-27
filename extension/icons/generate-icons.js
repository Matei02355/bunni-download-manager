/* Run with `node icons/generate-icons.js` from the extension directory. */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const outputDirectory = __dirname;
const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  fs.writeFileSync(path.join(outputDirectory, `icon${size}.png`), renderIcon(size));
}

function renderIcon(size) {
  const scale = 4;
  const width = size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);

  ellipse(pixels, width, 64, 64, 60, 60, [103, 78, 190, 255]);
  ellipse(pixels, width, 42, 34, 14, 28, [255, 249, 242, 255]);
  ellipse(pixels, width, 86, 34, 14, 28, [255, 249, 242, 255]);
  ellipse(pixels, width, 42, 34, 6, 19, [255, 182, 179, 255]);
  ellipse(pixels, width, 86, 34, 6, 19, [255, 182, 179, 255]);
  ellipse(pixels, width, 64, 75, 39, 35, [255, 249, 242, 255]);
  ellipse(pixels, width, 49, 70, 4.5, 4.5, [52, 45, 69, 255]);
  ellipse(pixels, width, 79, 70, 4.5, 4.5, [52, 45, 69, 255]);
  ellipse(pixels, width, 64, 81, 7, 4.5, [240, 128, 139, 255]);
  line(pixels, width, 64, 85, 64, 92, 2.7, [106, 90, 109, 255]);
  line(pixels, width, 64, 92, 56, 88, 2.7, [106, 90, 109, 255]);
  line(pixels, width, 64, 92, 72, 88, 2.7, [106, 90, 109, 255]);
  line(pixels, width, 92, 87, 99, 94, 7, [255, 191, 142, 255]);
  line(pixels, width, 99, 94, 113, 75, 7, [255, 191, 142, 255]);

  const downsampled = downsample(pixels, width, scale);
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.from([0]));
    rows.push(Buffer.from(downsampled.buffer, y * size * 4, size * 4));
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ellipse(pixels, width, cx, cy, rx, ry, color) {
  const factor = width / 128;
  const minX = Math.max(0, Math.floor((cx - rx) * factor));
  const maxX = Math.min(width - 1, Math.ceil((cx + rx) * factor));
  const minY = Math.max(0, Math.floor((cy - ry) * factor));
  const maxY = Math.min(width - 1, Math.ceil((cy + ry) * factor));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = (x + 0.5) / factor - cx;
      const dy = (y + 0.5) / factor - cy;
      if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1) setPixel(pixels, width, x, y, color);
    }
  }
}

function line(pixels, width, x1, y1, x2, y2, thickness, color) {
  const factor = width / 128;
  const ax = x1 * factor;
  const ay = y1 * factor;
  const bx = x2 * factor;
  const by = y2 * factor;
  const radius = (thickness * factor) / 2;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + radius));
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius));
  const maxY = Math.min(width - 1, Math.ceil(Math.max(ay, by) + radius));
  const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSquared));
      if (Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))) <= radius) {
        setPixel(pixels, width, x, y, color);
      }
    }
  }
}

function setPixel(pixels, width, x, y, color) {
  const offset = (y * width + x) * 4;
  pixels.set(color, offset);
}

function downsample(source, width, scale) {
  const size = width / scale;
  const result = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sums = [0, 0, 0, 0];
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const offset = (((y * scale + sy) * width) + x * scale + sx) * 4;
          for (let channel = 0; channel < 4; channel += 1) sums[channel] += source[offset + channel];
        }
      }
      const target = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) result[target + channel] = Math.round(sums[channel] / (scale * scale));
    }
  }
  return result;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
