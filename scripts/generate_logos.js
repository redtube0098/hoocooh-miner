const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

// HSL helper functions
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;

  if (max === min) {
    h = s = 0; // achromatic
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  let r, g, b;

  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

const TIERS = [
  { level: 1, name: "Starter", hue: 180, metalTint: [0.95, 1.0, 1.05], boostSat: 1.0, glowColor: [0, 220, 240] },
  { level: 2, name: "Developed", hue: 145, metalTint: [0.85, 1.1, 0.95], boostSat: 1.25, glowColor: [16, 220, 130] },
  { level: 3, name: "Refined", hue: 215, metalTint: [0.88, 0.96, 1.2], boostSat: 1.2, glowColor: [20, 140, 255] },
  { level: 4, name: "Vanguard", hue: 275, metalTint: [1.1, 0.85, 1.25], boostSat: 1.3, glowColor: [170, 70, 255] },
  { level: 5, name: "Apex", hue: 350, metalTint: [1.25, 0.8, 0.85], boostSat: 1.35, glowColor: [255, 50, 70] },
  { level: 6, name: "Celestial", hue: 24, metalTint: [1.38, 0.78, 0.52], boostSat: 1.5, glowColor: [255, 95, 0] },
  { level: 7, name: "Quantum", hue: 315, metalTint: [1.2, 0.85, 1.15], boostSat: 1.4, glowColor: [240, 40, 180] },
  { level: 8, name: "Mythic", hue: 250, metalTint: [0.9, 0.85, 1.3], boostSat: 1.35, glowColor: [100, 90, 255] },
  { level: 9, name: "Sovereign", hue: 52, metalTint: [1.42, 1.25, 0.6], boostSat: 1.5, glowColor: [255, 215, 0], goldMetal: true },
  { level: 10, name: "Transcendent", hue: -1, metalTint: [1.1, 1.1, 1.2], boostSat: 1.5, glowColor: [255, 255, 255], rainbow: true }
];

async function generateAll() {
  const inputPath = path.join(__dirname, "../public/assets/logo.png");
  const outputDir = path.join(__dirname, "../public/assets");

  const image = sharp(inputPath);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const channels = info.channels;

  for (const tier of TIERS) {
    const outBuffer = Buffer.alloc(data.length);

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a < 10) {
        outBuffer[i] = 0;
        outBuffer[i + 1] = 0;
        outBuffer[i + 2] = 0;
        outBuffer[i + 3] = 0;
        continue;
      }

      const [origH, origS, origL] = rgbToHsl(r, g, b);

      // Check if this pixel is part of the glowing neon seams (original seam is cyan ~175-195 with high brightness)
      const isNeonSeam = (origH >= 160 && origH <= 210 && origS > 0.25) || (origL > 0.85 && g > 180 && b > 180);

      let targetHue = tier.hue;
      if (tier.rainbow) {
        // Chromatic dispersion across pixel coordinates
        const px = (i / channels) % width;
        const py = Math.floor((i / channels) / width);
        targetHue = ((px / width * 360) + (py / height * 180)) % 360;
      }

      if (isNeonSeam) {
        // Remap neon seam color
        let newS = Math.min(1.0, origS * tier.boostSat);
        let newL = Math.min(0.96, origL * 1.05);
        if (tier.level === 10) {
          // Blinding diamond core
          newL = Math.min(1.0, origL * 1.2);
          newS = 0.85;
        }
        const [nr, ng, nb] = hslToRgb(targetHue, newS, newL);
        outBuffer[i] = nr;
        outBuffer[i + 1] = ng;
        outBuffer[i + 2] = nb;
        outBuffer[i + 3] = a;
      } else {
        // Metallic facets
        let [mr, mg, mb] = [r, g, b];
        if (tier.goldMetal) {
          mr = Math.min(255, Math.round(mr * 1.35));
          mg = Math.min(255, Math.round(mg * 1.15));
          mb = Math.min(255, Math.round(mb * 0.7));
        } else {
          mr = Math.min(255, Math.round(mr * tier.metalTint[0]));
          mg = Math.min(255, Math.round(mg * tier.metalTint[1]));
          mb = Math.min(255, Math.round(mb * tier.metalTint[2]));
        }

        // Slight ambient energy reflection
        const reflectRatio = 0.15;
        const [gr, gg, gb] = tier.glowColor;
        mr = Math.min(255, Math.round(mr * (1 - reflectRatio) + gr * reflectRatio));
        mg = Math.min(255, Math.round(mg * (1 - reflectRatio) + gg * reflectRatio));
        mb = Math.min(255, Math.round(mb * (1 - reflectRatio) + gb * reflectRatio));

        outBuffer[i] = mr;
        outBuffer[i + 1] = mg;
        outBuffer[i + 2] = mb;
        outBuffer[i + 3] = a;
      }
    }

    // Save as WebP
    const filename = `miner_lvl${tier.level}.webp`;
    const destPath = path.join(outputDir, filename);

    await sharp(outBuffer, { raw: { width, height, channels } })
      .webp({ quality: 95, lossless: false, effort: 6 })
      .toFile(destPath);

    console.log(`✓ Generated ${filename} (${tier.name})`);
  }

  // Also ensure default logo.webp is high quality
  await sharp(path.join(outputDir, "miner_lvl1.webp"))
    .toFile(path.join(outputDir, "logo.webp"));
  console.log("✓ Updated logo.webp");
}

generateAll().catch(console.error);
