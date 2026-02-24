/**
 * build-icons.mjs
 *
 * Generates all required icon assets from source files in the project root.
 * Outputs to assets/icons/.
 *
 * Source files expected in project root:
 *   full_icon.png             — main app icon (any size, ideally square)
 *   tray-icon.ico             — unified tray source (ICO); if present, used for the
 *                               tray base image and dynamic badge generation at runtime.
 *                               If absent, falls back to the two PNGs below.
 *   mail_tray_icon_default.png — tray icon when no unread mail (fallback)
 *   mail_tray_icon_new_mail.png — tray icon when unread mail exists (fallback)
 *
 * Usage: node scripts/build-icons.mjs
 * Requires: sharp, png2icons (dependencies), icojs (devDependency)
 */

import sharp from 'sharp';
import png2icons from 'png2icons';
import { parseICO } from 'icojs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Main app icon ─────────────────────────────────────────────────────────────
//
// macOS requires a 1024×1024 master with ~9% transparent padding on each side.
// 9% of 1024 = 92px → content area = 1024 − 2×92 = 840px (rounded to even).

const ICON_SIZE = 1024;
const PADDING = Math.round(ICON_SIZE * 0.09); // 92px
const CONTENT_SIZE = ICON_SIZE - PADDING * 2;  // 840px

console.log(`Building main app icon: ${CONTENT_SIZE}×${CONTENT_SIZE} content, ${PADDING}px padding → ${ICON_SIZE}×${ICON_SIZE} master`);

const masterBuffer = await sharp(path.join(ROOT, 'full_icon.png'))
  .resize(CONTENT_SIZE, CONTENT_SIZE, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .extend({
    top: PADDING,
    bottom: PADDING,
    left: PADDING,
    right: PADDING,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

// 512×512 PNG — used by Electron on Linux and as the dev main-window icon
const png512 = await sharp(masterBuffer).resize(512, 512).png().toBuffer();
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);
console.log('  ✓ icon.png (512×512)');

// Windows ICO — multi-size: 16, 24, 32, 48, 64, 128, 256 (forWinExe = true)
const icoData = png2icons.createICO(masterBuffer, png2icons.BICUBIC, 0, true, true);
if (!icoData) {
  throw new Error('png2icons.createICO returned null');
}
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), icoData);
console.log('  ✓ icon.ico (multi-size Windows)');

// macOS ICNS — 16 through 1024
const icnsData = png2icons.createICNS(masterBuffer, png2icons.BICUBIC, 0);
if (!icnsData) {
  throw new Error('png2icons.createICNS returned null');
}
fs.writeFileSync(path.join(OUT_DIR, 'icon.icns'), icnsData);
console.log('  ✓ icon.icns (macOS)');

// ── Tray icons ────────────────────────────────────────────────────────────────
//
// If tray-icon.ico exists in the project root, it is used as the unified tray
// source.  A 32×32 base PNG is generated from it; tray-service.ts then overlays
// a badge at runtime for non-zero unread counts.
//
// If tray-icon.ico is absent, fall back to the separate default/unread PNGs.

const trayIcoPath = path.join(ROOT, 'tray-icon.ico');

if (fs.existsSync(trayIcoPath)) {
  console.log('\nBuilding unified tray icon from tray-icon.ico (runtime badge mode)');

  // icojs parses the ICO and returns all embedded images as PNG buffers.
  // Pick the largest available variant for best quality when upscaling.
  const icoBuffer = fs.readFileSync(trayIcoPath);
  const icoArrayBuffer = icoBuffer.buffer.slice(icoBuffer.byteOffset, icoBuffer.byteOffset + icoBuffer.byteLength);
  const images = await parseICO(icoArrayBuffer, 'image/png');

  if (images.length === 0) {
    throw new Error('tray-icon.ico contains no images');
  }

  // Sort by area descending, pick the largest
  images.sort((first, second) => (second.width * second.height) - (first.width * first.height));
  const largest = images[0];
  console.log(`  source: ${largest.width}×${largest.height} from ICO`);

  // Save at the native resolution — no upscaling so the icon stays crisp.
  // tray-service uses this buffer as the canvas for runtime badge compositing.
  const baseNative = await sharp(Buffer.from(largest.buffer))
    .resize(largest.width, largest.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, 'tray-icon.png'), baseNative);
  console.log(`  ✓ tray-icon.png (${largest.width}×${largest.height} native, no upscaling)`);

} else {
  console.log('\nNo tray-icon.ico found — building separate default/unread tray icons');
  console.log('  (tip: place tray-icon.ico in the project root to enable dynamic number badges)');

  async function buildTrayIcon(sourcePath, baseName) {
    console.log(`\nBuilding tray icon "${baseName}" from ${path.basename(sourcePath)}`);
    for (const size of [16, 32]) {
      const buffer = await sharp(sourcePath)
        .resize(size, size, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      const suffix = size === 32 ? '@2x' : '';
      const fileName = `${baseName}${suffix}.png`;
      fs.writeFileSync(path.join(OUT_DIR, fileName), buffer);
      console.log(`  ✓ ${fileName} (${size}×${size})`);
    }
  }

  await buildTrayIcon(
    path.join(ROOT, 'mail_tray_icon_default.png'),
    'tray-default',
  );
  await buildTrayIcon(
    path.join(ROOT, 'mail_tray_icon_new_mail.png'),
    'tray-unread',
  );
}

console.log('\nAll icons built successfully → assets/icons/');
