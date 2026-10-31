// Shared timing for the soundtrack and the film: 128 BPM, 56 bars.
export const BPM = 128;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const BARS = 56;
export const DURATION = BARS * BAR; // 105 s

export const at = (bar, beat = 0) => bar * BAR + beat * BEAT;

// Scene boundaries in bars.
export const SCENES = [
  { id: "hook", from: 0, to: 4 },
  { id: "problem", from: 4, to: 12 },
  { id: "order", from: 12, to: 20 },
  { id: "hire", from: 20, to: 28 },
  { id: "execute", from: 28, to: 36 },
  { id: "tamper", from: 36, to: 44 },
  { id: "proof", from: 44, to: 52 },
  { id: "outro", from: 52, to: 56 },
];

// Moments the music marks: a bright chime for good news, a glitch hit for a rejection.
export const CHIMES = [at(18, 0), at(25, 0), at(33, 2), at(46, 0), at(48, 2)];
export const GLITCHES = [at(38), at(39), at(40), at(41)];
