// Minimal / acid techno, 128 BPM, 56 bars, beat-matched to the film (timeline.mjs).
// No samples: every sound is synthesized here. Writes out/music.wav (44.1 kHz, 16-bit stereo).
import { mkdirSync, writeFileSync } from "node:fs";
import { BAR, BARS, BEAT, CHIMES, GLITCHES, at } from "./timeline.mjs";

const SR = 44100;
const TAIL = 3;
const N = Math.ceil((BARS * BAR + TAIL) * SR);
const STEP = BEAT / 4;

// ---------------------------------------------------------------- helpers
let seed = 0x9e3779b9;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
};
const bus = () => [new Float32Array(N), new Float32Array(N)];
const drums = bus(), music = bus(), space = bus(), fx = bus();
const add = (b, i, l, r = l) => {
  if (i >= 0 && i < N) { b[0][i] += l; b[1][i] += r; }
};
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

/** Zavalishin TPT state-variable filter. */
class SVF {
  constructor() { this.a = 0; this.b = 0; }
  run(x, fc, q) {
    const g = Math.tan(Math.PI * Math.min(fc, SR * 0.45) / SR), k = 1 / q;
    const v1 = (this.a + g * (x - this.b)) / (1 + g * (g + k));
    const v2 = this.b + g * v1;
    this.a = 2 * v1 - this.a; this.b = 2 * v2 - this.b;
    return { lp: v2, bp: v1, hp: x - k * v1 - v2 };
  }
}

/** Band-limited saw (polyBLEP). */
class Saw {
  constructor(phase = 0) { this.p = phase; }
  next(f) {
    const dt = f / SR;
    this.p += dt; if (this.p >= 1) this.p -= 1;
    let v = 2 * this.p - 1;
    const t = this.p;
    if (t < dt) { const x = t / dt; v -= x + x - x * x - 1; }
    else if (t > 1 - dt) { const x = (t - 1) / dt; v -= x * x + x + x + 1; }
    return v;
  }
}

// ---------------------------------------------------------------- arrangement
const inBars = (bar, ...ranges) => ranges.some(([a, b]) => bar >= a && bar < b);
const has = {
  kick: (bar, beat) => inBars(bar, [4, 36], [38, 52]) && !(bar === 43 && beat >= 2) && !(bar === 19 && beat === 3),
  hat: (bar) => inBars(bar, [2, 52]),
  hat16: (bar) => inBars(bar, [20, 36], [44, 52]),
  openHat: (bar) => inBars(bar, [28, 36], [44, 52]),
  clap: (bar) => inBars(bar, [8, 36], [40, 52]),
  bass: (bar) => inBars(bar, [12, 36], [38, 52]),
  acid: (bar) => inBars(bar, [20, 52]),
  pad: (bar) => inBars(bar, [0, 8], [36, 44], [50, 56]),
};
// Bass / pad roots per bar: A A F G.
const ROOTS = [33, 33, 29, 31]; // MIDI: A1, A1, F1, G1
const CHORDS = { 33: [57, 60, 64, 67, 71], 29: [53, 57, 60, 64, 67], 31: [55, 59, 62, 64, 69] };

// ---------------------------------------------------------------- drums
const kicks = [];
function kick(t0) {
  kicks.push(t0);
  const s = Math.round(t0 * SR);
  let ph = 0;
  for (let i = 0; i < 0.45 * SR; i++) {
    const t = i / SR;
    const f = 44 + 120 * Math.exp(-t / 0.028) + 60 * Math.exp(-t / 0.004);
    ph += 2 * Math.PI * f / SR;
    const env = Math.exp(-t / 0.2) * Math.min(1, t / 0.0015);
    let v = Math.sin(ph) * env + (t < 0.004 ? rand() * 0.25 * (1 - t / 0.004) : 0);
    v = Math.tanh(v * 1.8) / Math.tanh(1.8);
    add(drums, s + i, v * 0.62);
  }
}
function hat(t0, decay, gain, pan = 0.15) {
  const s = Math.round(t0 * SR), f = new SVF(), f2 = new SVF();
  for (let i = 0; i < decay * 6 * SR; i++) {
    const t = i / SR;
    const v = f2.run(f.run(rand(), 7500, 0.7).hp, 11000, 0.8).hp * Math.exp(-t / decay) * gain;
    add(drums, s + i, v * (1 - pan), v * (1 + pan));
  }
}
function clap(t0, gain = 0.85) {
  const s = Math.round(t0 * SR), f = new SVF();
  for (let i = 0; i < 0.5 * SR; i++) {
    const t = i / SR;
    let env = Math.exp(-t / 0.11) * 0.6;
    for (const d of [0, 0.011, 0.023]) if (t >= d) env += Math.exp(-(t - d) / 0.005);
    const v = f.run(rand(), 1300, 1.6).bp * env * gain;
    add(drums, s + i, v);
    add(space, s + i, v * 0.5);
  }
}
function crash(t0, gain = 0.32) {
  const s = Math.round(t0 * SR), f = new SVF();
  for (let i = 0; i < 2.2 * SR; i++) {
    const t = i / SR;
    const v = f.run(rand(), 5000, 0.6).hp * Math.exp(-t / 0.7) * gain;
    add(fx, s + i, v * 0.9, v * 1.1);
  }
}
function riser(t0, t1, gain = 0.28) {
  const s = Math.round(t0 * SR), n = Math.round((t1 - t0) * SR), f = new SVF();
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const v = f.run(rand(), 300 * 30 ** x, 3).bp * x * x * gain;
    add(fx, s + i, v * (1 - 0.3 * x), v * (1 + 0.3 * x));
  }
}

// ---------------------------------------------------------------- bass, acid, pad
function bassNote(t0, midi, len) {
  const s = Math.round(t0 * SR), osc = new Saw(), f = new SVF();
  const freq = mtof(midi);
  let sub = 0;
  for (let i = 0; i < (len + 0.03) * SR; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.12) * (t > len ? Math.exp(-(t - len) / 0.008) : 1);
    sub += 2 * Math.PI * freq / SR;
    const cut = 160 + 1000 * Math.exp(-t / 0.05);
    const v = (f.run(osc.next(freq), cut, 1.1).lp * 0.8 + Math.sin(sub) * 0.25) * env;
    add(music, s + i, v * 0.55);
  }
}
// 16 steps: semitone offset from A2 (null = rest), accent, slide into next.
const ACID = [
  [0, 1, 0], [0, 0, 0], [12, 1, 1], [0, 0, 0], [3, 0, 0], [null], [7, 1, 0], [0, 0, 1],
  [0, 0, 0], [10, 1, 0], [null], [3, 0, 1], [12, 1, 0], [0, 0, 0], [5, 0, 1], [7, 1, 0],
];
function acidCutoff(bar, x) {
  // x: 0..1 within the bar. Opens over each section, dark in the breakdown.
  const pos = bar + x;
  if (pos < 36) return 280 + 2300 * ((pos - 20) / 16) ** 1.6;
  if (pos < 38) return 420;
  if (pos < 44) return 700 + 2600 * ((pos - 38) / 6) ** 1.3;
  return 1500 + 1100 * Math.sin(2 * Math.PI * (pos - 44) / 4) ** 2;
}
function acidBar(bar) {
  const t0 = at(bar), f = new SVF(), osc = new Saw();
  const root = ROOTS[bar % 4] + 12; // A2 / F2 / G2
  const n = Math.round(BAR * SR);
  const s = Math.round(t0 * SR);
  let freq = mtof(root), target = freq;
  for (let i = 0; i < n; i++) {
    const t = i / SR, step = Math.min(15, Math.floor(t / STEP)), tin = t - step * STEP;
    const [note, accent, slide] = ACID[step];
    if (note === null) { f.run(0, 400, 2); continue; }
    target = mtof(root + note);
    freq += (target - freq) * (ACID[(step + 15) % 16][2] ? 0.0025 : 1);
    const gate = slide ? 1 : tin < STEP * 0.62 ? 1 : Math.exp(-(tin - STEP * 0.62) / 0.004);
    const env = Math.exp(-tin / (accent ? 0.09 : 0.16));
    const cut = acidCutoff(bar, t / BAR) * (1 + (accent ? 3.2 : 1.6) * env);
    const v = Math.tanh(f.run(osc.next(freq), cut, accent ? 7 : 4.5).lp * 2.2) * gate * (accent ? 0.5 : 0.38);
    add(music, s + i, v * 0.92, v * 1.0);
    add(space, s + i, v * 0.25);
  }
}
function padBar(bar, gain) {
  // Each bar overlaps the next by XF and crossfades, so chord changes don't click.
  const XF = 0.12, t0 = at(bar), s = Math.round(t0 * SR), n = Math.round((BAR + XF) * SR);
  const notes = CHORDS[ROOTS[bar % 4]];
  const voices = notes.flatMap((m, j) => [-7, 7].map((cents) => ({ osc: new Saw(rand() * 0.5 + 0.5), f: mtof(m) * 2 ** (cents / 1200), pan: ((j / (notes.length - 1)) * 2 - 1) * 0.6 })));
  const flt = [new SVF(), new SVF()];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / XF) * (t > BAR ? Math.max(0, 1 - (t - BAR) / XF) : 1);
    let l = 0, r = 0;
    for (const v of voices) { const x = v.osc.next(v.f); l += x * (1 - v.pan); r += x * (1 + v.pan); }
    const cut = 900 + 500 * Math.sin(2 * Math.PI * (bar * BAR + t) / 8);
    l = flt[0].run(l, cut, 0.8).lp; r = flt[1].run(r, cut, 0.8).lp;
    add(music, s + i, l * gain * 0.05 * env, r * gain * 0.05 * env);
    add(space, s + i, l * gain * 0.04, r * gain * 0.04);
  }
}

// ---------------------------------------------------------------- cues
function chime(t0) {
  const s = Math.round(t0 * SR);
  for (let i = 0; i < 1.4 * SR; i++) {
    const t = i / SR;
    let v = 0;
    for (const [m, g] of [[88, 0.5], [93, 0.35], [100, 0.18]]) v += Math.sin(2 * Math.PI * mtof(m) * t) * g;
    v *= Math.exp(-t / 0.35) * Math.min(1, t / 0.002) * 0.16;
    add(fx, s + i, v * 0.8, v * 1.2);
    add(space, s + i, v * 0.9);
  }
}
function glitch(t0) {
  const s = Math.round(t0 * SR), f = new SVF();
  let held = 0;
  for (let i = 0; i < 0.6 * SR; i++) {
    const t = i / SR;
    const freq = 110 * 2 ** (-t * 3);
    const sq = Math.sign(Math.sin(2 * Math.PI * freq * t)) * 0.6 + Math.sign(Math.sin(2 * Math.PI * freq * 2.01 * t)) * 0.3;
    if (i % 9 === 0) held = sq + rand() * 0.5; // bit-crush
    const env = Math.exp(-t / 0.16) * Math.min(1, t / 0.001);
    const v = Math.tanh(f.run(held, 2400, 2).lp * 3) * env * 0.38;
    const stutter = Math.floor(t / 0.045) % 2 === 0 || t < 0.12 ? 1 : 0.35;
    add(fx, s + i, v * stutter, -v * stutter * 0.9);
  }
}

// ---------------------------------------------------------------- sequence
for (let bar = 0; bar < BARS; bar++) {
  for (let beat = 0; beat < 4; beat++) {
    const t = at(bar, beat);
    if (has.kick(bar, beat)) kick(t);
    if (has.hat(bar)) {
      const quiet = bar < 4 ? 0.35 : 1;
      hat(t + BEAT / 2, has.openHat(bar) ? 0.11 : 0.035, 0.55 * quiet);
      if (has.hat16(bar)) { hat(t + STEP, 0.02, 0.18, -0.3); hat(t + 3 * STEP, 0.02, 0.22, 0.3); }
    }
    if (has.clap(bar) && beat % 2 === 1) clap(t);
    if (has.bass(bar)) for (const k of [1, 2, 3]) bassNote(t + k * STEP, ROOTS[bar % 4], STEP * 0.7);
  }
  if (has.acid(bar)) acidBar(bar);
  if (has.pad(bar)) padBar(bar, bar < 8 ? 1 - Math.max(0, bar - 4) / 4 : bar >= 52 ? 1 - (bar - 52) / 5 : 1);
}
for (const bar of [4, 12, 20, 28, 44]) crash(at(bar));
riser(at(2), at(4));
riser(at(18), at(20));
riser(at(42), at(44), 0.36);
for (const t of CHIMES) chime(t);
for (const t of GLITCHES) glitch(t);

// ---------------------------------------------------------------- mix
// Sidechain: duck the music under every kick.
const duck = new Float32Array(N).fill(1);
for (const t0 of kicks) {
  const s = Math.round(t0 * SR);
  for (let i = 0; i < 0.3 * SR && s + i < N; i++) duck[s + i] = Math.min(duck[s + i], 1 - 0.75 * Math.exp(-i / SR / 0.09));
}
// Ping-pong delay (dotted eighth) + small Schroeder reverb on the space bus.
const out = [new Float32Array(N), new Float32Array(N)];
const dly = Math.round(0.75 * BEAT * SR);
const dl = [new Float32Array(N), new Float32Array(N)];
const lpD = [new SVF(), new SVF()];
for (let i = 0; i < N; i++) {
  const inL = space[0][i] + (i >= dly ? dl[1][i - dly] * 0.42 : 0);
  const inR = space[1][i] + (i >= dly ? dl[0][i - dly] * 0.42 : 0);
  dl[0][i] = lpD[0].run(inL, 3500, 0.7).lp;
  dl[1][i] = lpD[1].run(inR, 3500, 0.7).lp;
}
const COMBS = [1557, 1617, 1491, 1422], ALLP = [225, 556];
const verb = [0, 1].map((ch) => {
  const x = space[ch], y = new Float32Array(N);
  for (const d0 of COMBS) {
    const d = d0 + ch * 23, buf = new Float32Array(N);
    for (let i = 0; i < N; i++) { buf[i] = x[i] + (i >= d ? buf[i - d] * 0.8 : 0); y[i] += buf[i] * 0.12; }
  }
  for (const d of ALLP) {
    const src = Float32Array.from(y);
    for (let i = 0; i < N; i++) y[i] = -0.5 * src[i] + (i >= d ? src[i - d] + 0.5 * y[i - d] : 0);
  }
  return y;
});
for (let ch = 0; ch < 2; ch++) {
  for (let i = 0; i < N; i++) {
    out[ch][i] = drums[ch][i] + music[ch][i] * duck[i] + fx[ch][i] + dl[ch][i] * 0.5 * duck[i] + verb[ch][i] * 0.35;
  }
}
let peak = 0;
for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) { out[ch][i] = Math.tanh(out[ch][i] * 1.15); peak = Math.max(peak, Math.abs(out[ch][i])); }
const gain = 0.92 / peak;
const fadeFrom = Math.round((BARS * BAR) * SR);

// ---------------------------------------------------------------- WAV
const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  const fade = i > fadeFrom ? Math.max(0, 1 - (i - fadeFrom) / (TAIL * SR)) : 1;
  for (let ch = 0; ch < 2; ch++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[ch][i] * gain * fade)) * 32767), i * 4 + ch * 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(data.length, 40);
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL("./out/music.wav", import.meta.url), Buffer.concat([header, data]));
console.log(`out/music.wav: ${(N / SR).toFixed(1)} s, peak gain ${gain.toFixed(2)}`);
