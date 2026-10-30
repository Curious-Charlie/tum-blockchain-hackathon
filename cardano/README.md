# Cardano side of PayOnProof

npm workspaces:

- `packages/core` (`@agentic/core`): role wallets, x402 seller kit (settle only on success, Masumi escrow routes), Masumi escrow transactions (`@agentic/core/escrow`), AgentGuard spend policies, quotes and seller choice (`@agentic/core/market`), CIP-20 publishing, Claude helpers, live dashboard.
- `apps/payonproof`: Lena's finance agent and three Keepers; see its README.

```sh
npm install
npm run dashboard          # http://127.0.0.1:4000
npm run smoke              # 1 tADA x402 payment through AgentGuard on preprod
npm test                   # AgentGuard and escrow tests
npm run demo -w apps/payonproof
```
