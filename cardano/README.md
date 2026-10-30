# Cardano track: Agentic Commerce on Cardano

npm workspaces:

- `packages/core` (`@agentic/core`): role wallets, x402 seller kit (settle only on success), AgentGuard spend policies, CIP-20 publishing, Claude helpers, live dashboard.
- `apps/payonproof` (D1), `apps/checkedfacts` (D2), `apps/reprobounty` (D5): one design each, see their READMEs.

```sh
npm install
npm run dashboard          # http://127.0.0.1:4000
npm run smoke              # 1 tADA x402 payment through AgentGuard on preprod
npm test                   # AgentGuard policy tests
```
