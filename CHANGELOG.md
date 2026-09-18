# Changelog

## v0.1.0-alpha.2

First public release of the TypeScript SDK, in two packages: `@lunya/sdk` and, on top of it,
`@lunya/sdk-react`. Alpha because the surface may still move; what is here works against the
deployments it ships.

### The DEX

- Quotes and swaps: exact input and exact output, single pools and multi-pool routes, with the pool
  type in the path rather than a fee tier.
- Pool state read for local pricing, so a quote can be computed without a round trip per keystroke.
- Liquidity: open, add, collect and close positions, with the amounts a range takes computed for you.
- Limit orders, and permits for approving by signature.

### The launchpad

- The bonding curve, priced locally: buys and sells quoted the way the contract quotes them, the
  anti-snipe surcharge included where it applies.
- Launch state, events, and the graduated pool a token ends up in.

### Addresses and ABIs

- `DEPLOYMENTS` carries Arc mainnet and its test network — and the same addresses on both, because the
  two chains were deployed under one salt. An address in a document no longer needs a network beside
  it; only the chain id, the RPC and the explorer differ.
- The ABIs are generated from the contract build and committed, so the package builds from a clone
  with nothing else beside it, and cannot drift from the contracts by hand.

### Using it

- `viem` is a peer dependency; nothing else is required at runtime.
- Three examples ship with the source: a quoting script for Node, a Next.js widget, and a bot that
  trades a curve.
