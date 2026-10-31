// Bundles the /api/run function for the creator-escrow page into one file with every dependency inlined, so Vercel
// needs no install. Usage: pnpm creator:web:build
import { build } from 'esbuild';

await build({
  entryPoints: [new URL('./handler.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: new URL('../../web/creator-escrow/api/run.mjs', import.meta.url).pathname,
  // Some dependencies are CommonJS and call require.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
console.log('wrote web/creator-escrow/api/run.mjs');
