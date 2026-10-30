# Cardano track: Agentic Commerce on Cardano

npm workspaces:

- `packages/core` (`@agentic/core`): role wallets, x402 seller kit (settle only on success), AgentGuard spend policies, CIP-20 publishing, Claude helpers, live dashboard.
- `apps/reprobounty`: ReproBounty, the submitted design. See its README.

```sh
npm install
npm run dashboard          # http://127.0.0.1:4000
npm run demo -w apps/reprobounty
npm test                   # AgentGuard policy tests
```

Setup from scratch: the repository [README](../README.md#setup-and-run).
