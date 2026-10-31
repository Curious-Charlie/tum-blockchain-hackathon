// Renders film.html frame by frame (deterministic time) and muxes out/music.wav.
//   node render.mjs --stills 3,10,25      # PNG stills at these seconds → out/stills/
//   node render.mjs                        # full film → out/payonproof-film.mp4
// Uses the installed Google Chrome; set CHROME_PATH to use another Chromium.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { DURATION } from "./timeline.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const FPS = 30;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`file://${here}film.html`);
await page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
});

const stills = arg("--stills");
if (stills) {
  mkdirSync(`${out}stills`, { recursive: true });
  for (const s of stills.split(",").map(Number)) {
    await page.evaluate((t) => window.render(t), s);
    await page.screenshot({ path: `${out}stills/t${s.toFixed(2).padStart(6, "0")}.png` });
  }
  console.log(`stills: ${stills}`);
} else {
  const file = arg("--out") ?? `${out}payonproof-film.mp4`;
  const frames = Math.round(DURATION * FPS);
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-i", `${out}music.wav`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-t", String(DURATION), "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    const buf = await page.screenshot({ type: "jpeg", quality: 93 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 300 === 0) console.log(`frame ${i}/${frames} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log(`wrote ${file}`);
}
await browser.close();
