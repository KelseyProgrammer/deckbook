// build-brand-assets — regenerates every shipping logo raster and derived SVG from the
// canonical vectors in assets/brand/. Run: `node scripts/build-brand-assets.mjs`
//
// Provenance: assets/brand/*.svg were traced with potrace 1.16 (3x Lanczos upscale, 55%
// threshold, svgo 3.3.2) from the client-supplied logo raster IMG_5361.png (2352x1760,
// received 2026-11-17). The vectors are the source of truth; nothing here is hand-drawn.
//
// Requires `rsvg-convert` (brew install librsvg).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = join(ROOT, "assets/brand");
const NAVY = "#0a1d30"; // navy-deep
const WHITE = "#f8fafb"; // white-crisp
const TMP = mkdtempSync(join(tmpdir(), "deckbook-brand-"));

function load(name) {
  const svg = readFileSync(join(BRAND, `${name}.svg`), "utf8");
  const [, w, h] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).map(Number);
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>[\s\S]*?<\/title>/, "");
  return { w, h, inner };
}

/** A square (or w x h) canvas with the artwork centered at `widthFrac` of the canvas width. */
function compose({ art, w, h = w, widthFrac, bg, radius = 0, color = WHITE, intrinsic = false }) {
  const aw = w * widthFrac;
  const ah = (aw * art.h) / art.w;
  const x = (w - aw) / 2;
  const y = (h - ah) / 2;
  const size = intrinsic ? ` width="${w}" height="${h}"` : "";
  const rect = bg ? `<rect width="${w}" height="${h}" rx="${radius}" fill="${bg}"/>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${size} viewBox="0 0 ${w} ${h}">${rect}` +
    `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${aw.toFixed(2)}" height="${ah.toFixed(2)}" ` +
    `viewBox="0 0 ${art.w} ${art.h}" fill="${color}">${art.inner}</svg></svg>\n`
  );
}

function out(rel, content) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  console.log("wrote", rel);
}

function png(rel, svg, width) {
  const src = join(TMP, rel.replace(/[\/\\]/g, "_") + ".svg");
  writeFileSync(src, svg);
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  execFileSync("rsvg-convert", ["-w", String(width), src, "-o", p]);
  console.log("wrote", rel);
}

const mark = load("deckbook-mark");
const lockup = load("deckbook-lockup");

// ---- web ----
for (const n of ["deckbook-mark", "deckbook-wordmark", "deckbook-lockup"]) {
  mkdirSync(join(ROOT, "apps/web/public/brand"), { recursive: true });
  copyFileSync(join(BRAND, `${n}.svg`), join(ROOT, `apps/web/public/brand/${n}.svg`));
  console.log("copied", `apps/web/public/brand/${n}.svg`);
}
out("apps/web/app/icon.svg", compose({ art: mark, w: 64, widthFrac: 0.84, bg: NAVY, radius: 12 }));
png("apps/web/app/apple-icon.png", compose({ art: mark, w: 180, widthFrac: 0.76, bg: NAVY }), 180);
png("apps/web/app/opengraph-image.png", compose({ art: lockup, w: 1200, h: 630, widthFrac: 0.4, bg: NAVY }), 1200);

// ---- mobile ----
const IMG = "apps/mobile/assets/images";
png(`${IMG}/icon.png`, compose({ art: mark, w: 1024, widthFrac: 0.74, bg: NAVY }), 1024);
// Android adaptive icon: artwork must sit inside the centered 66% safe zone.
png(`${IMG}/android-icon-foreground.png`, compose({ art: mark, w: 1024, widthFrac: 0.52 }), 1024);
png(`${IMG}/android-icon-monochrome.png`, compose({ art: mark, w: 1024, widthFrac: 0.52, color: "#ffffff" }), 1024);
png(`${IMG}/android-icon-background.png`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="${NAVY}"/></svg>`, 1024);
png(`${IMG}/splash-icon.png`, compose({ art: mark, w: mark.w, h: mark.h, widthFrac: 1 }), 720);
png(`${IMG}/favicon.png`, compose({ art: mark, w: 64, widthFrac: 0.84, bg: NAVY, radius: 12 }), 48);
// In-app header logo (apps/mobile/src/app/(tabs)/_layout.tsx) — white on the navy header, @3x.
const wordmark = load("deckbook-wordmark");
png(`${IMG}/logo-mark-white.png`, compose({ art: mark, w: mark.w, h: mark.h, widthFrac: 1 }), 108);
png(`${IMG}/logo-wordmark-white.png`, compose({ art: wordmark, w: wordmark.w, h: wordmark.h, widthFrac: 1 }), 303);
// iOS Icon Composer layer (apps/mobile/assets/expo.icon): white mark, navy fill set in icon.json.
out(
  "apps/mobile/assets/expo.icon/Assets/deckbook-mark.svg",
  compose({ art: mark, w: 700, h: Math.round((700 * mark.h) / mark.w), widthFrac: 1, color: "#ffffff", intrinsic: true }),
);
