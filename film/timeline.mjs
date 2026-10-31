// Shared timing for the soundtrack and the film: 120 BPM, 64 bars (2 s each).
export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const BARS = 64;
export const DURATION = BARS * BAR; // 128 s

export const at = (bar, beat = 0) => bar * BAR + beat * BEAT;

// Scene boundaries in bars.
export const SCENES = [
  { id: "hook", from: 0, to: 4 },
  { id: "problem", from: 4, to: 10 },
  { id: "flow", from: 10, to: 14 },
  { id: "order", from: 14, to: 20 },
  { id: "hire", from: 20, to: 28 },
  { id: "execute", from: 28, to: 36 },
  { id: "tamper", from: 36, to: 44 },
  { id: "proof", from: 44, to: 52 },
  { id: "sokosumi", from: 52, to: 56 },
  { id: "business", from: 56, to: 60 },
  { id: "outro", from: 60, to: 64 },
];

// Moments the music marks: a bright chime for good news, a glitch hit for a rejection.
export const CHIMES = [at(18, 0), at(25, 0), at(33, 0), at(46, 0), at(48, 2), at(52, 0)];
export const GLITCHES = [at(38), at(39), at(40), at(41)];
