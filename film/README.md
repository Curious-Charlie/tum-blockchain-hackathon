# The demo film

The PayOnProof demo video (2:08, 1080p) is made in code, so anyone can rebuild it:

- `film.html`: the film as one web page. `render(t)` draws the frame at second `t`; scenes, text and timing are all here.
- `synth.mjs`: the soundtrack, a 120 BPM techno track synthesized from scratch (kick, hats, clap, bass, an acid line, pads). No samples, no licensed music.
- `timeline.mjs`: bars, scenes and cue points shared by both, so every cut lands on the beat.
- `assets/`: explorer screenshots of the transactions shown in the film, and the signed Nodary responses (EUR/USD, BTC/USD) used in the tamper scene. Every transaction in the film is real; the EUR/USD chart in scene 2 is marked as illustrative.

```sh
cd film
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install   # uses your installed Google Chrome (or set CHROME_PATH)
npm run render                                   # out/music.wav, then out/payonproof-film.mp4 (about 5 minutes)
npm run stills -- 8.3,45.6,71.5                  # single frames → out/stills/
```

Needs Node 22+ and ffmpeg with libx264. `out/` is not committed (the film is about 160 MB).
