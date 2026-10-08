const zlib = require("zlib");

// 5x7 high-contrast font matrices for digits 0-9
const DIGIT_FONT = {
  "0": [
    0b01110,
    0b10001,
    0b10011,
    0b10101,
    0b11001,
    0b10001,
    0b01110
  ],
  "1": [
    0b00100,
    0b01100,
    0b00100,
    0b00100,
    0b00100,
    0b00100,
    0b01110
  ],
  "2": [
    0b01110,
    0b10001,
    0b00001,
    0b00010,
    0b00100,
    0b01000,
    0b11111
  ],
  "3": [
    0b11110,
    0b00001,
    0b00001,
    0b01110,
    0b00001,
    0b00001,
    0b11110
  ],
  "4": [
    0b00010,
    0b00110,
    0b01010,
    0b10010,
    0b11111,
    0b00010,
    0b00010
  ],
  "5": [
    0b11111,
    0b10000,
    0b11110,
    0b00001,
    0b00001,
    0b10001,
    0b01110
  ],
  "6": [
    0b00110,
    0b01000,
    0b10000,
    0b11110,
    0b10001,
    0b10001,
    0b01110
  ],
  "7": [
    0b11111,
    0b00001,
    0b00010,
    0b00100,
    0b01000,
    0b01000,
    0b01000
  ],
  "8": [
    0b01110,
    0b10001,
    0b10001,
    0b01110,
    0b10001,
    0b10001,
    0b01110
  ],
  "9": [
    0b01110,
    0b10001,
    0b10001,
    0b01111,
    0b00001,
    0b00010,
    0b01100
  ]
};

// Generates a PNG image Buffer containing the 4-digit code in a cyber security verification card
function generateVerificationImage(codeStr) {
  const code = String(codeStr || "0000").padStart(4, "0").slice(0, 4);

  const width = 460;
  const height = 210;
  const scale = 11; // 11px per font pixel -> 55px wide, 77px high per digit
  const digitW = 5 * scale;
  const digitH = 7 * scale;
  const gap = 20;
  const totalDigitsW = 4 * digitW + 3 * gap;
  const startX = Math.floor((width - totalDigitsW) / 2);
  const startY = 66;

  // Pixel grid map:
  // 0: background
  // 1: digit pixel (pure bright white)
  // 2: box border (cyan glow)
  // 3: box interior (deep cyber teal)
  // 4: grid line / accent dots
  const grid = new Uint8Array(width * height);

  // Mark digit boxes & glyphs
  const boxPadX = 9;
  const boxPadY = 9;

  for (let i = 0; i < 4; i++) {
    const ch = code[i];
    const matrix = DIGIT_FONT[ch] || DIGIT_FONT["0"];
    const dx = startX + i * (digitW + gap);

    // Box fill & border
    for (let by = startY - boxPadY; by < startY + digitH + boxPadY; by++) {
      for (let bx = dx - boxPadX; bx < dx + digitW + boxPadX; bx++) {
        if (bx >= 0 && bx < width && by >= 0 && by < height) {
          const isBorder = (
            by === startY - boxPadY ||
            by === startY + digitH + boxPadY - 1 ||
            bx === dx - boxPadX ||
            bx === dx + digitW + boxPadX - 1
          );
          grid[by * width + bx] = isBorder ? 2 : 3;
        }
      }
    }

    // Digit pixels
    for (let row = 0; row < 7; row++) {
      const rowBits = matrix[row];
      for (let col = 0; col < 5; col++) {
        if ((rowBits >> (4 - col)) & 1) {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = dx + col * scale + sx;
              const py = startY + row * scale + sy;
              if (px >= 0 && px < width && py >= 0 && py < height) {
                grid[py * width + px] = 1;
              }
            }
          }
        }
      }
    }
  }

  // Color lookup per pixel
  function getRgb(x, y) {
    const v = grid[y * width + x];
    if (v === 1) return [255, 255, 255]; // Digit: clean white
    if (v === 2) return [0, 224, 255];   // Neon cyan box outline
    if (v === 3) return [11, 35, 56];    // Deep cyber card fill

    // Card border
    if (x < 3 || x >= width - 3 || y < 3 || y >= height - 3) {
      return [0, 180, 216];
    }

    // Header top bar accent
    if (y >= 8 && y <= 11 && x >= 30 && x <= width - 30) {
      return [0, 220, 255];
    }

    // Subtle background cyber grid lines
    if (x % 32 === 0 || y % 32 === 0) {
      return [16, 28, 48];
    }

    // Tech gradient background (Dark Obsidian / Cyber Navy)
    const factor = y / height;
    const r = Math.floor(7 + factor * 8);
    const g = Math.floor(13 + factor * 14);
    const b = Math.floor(25 + factor * 25);
    return [r, g, b];
  }

  // Encode to standard PNG using built-in zlib
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(computeCrc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  function computeCrc32(buf) {
    let crc = 0 ^ -1;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawBytes = [];
  for (let y = 0; y < height; y++) {
    rawBytes.push(0); // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = getRgb(x, y);
      rawBytes.push(r, g, b);
    }
  }

  const idat = zlib.deflateSync(Buffer.from(rawBytes));

  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idat),
    makeChunk("IEND", Buffer.alloc(0))
  ]);
}

// Pre-computed CRC32 table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

module.exports = {
  generateVerificationImage
};
