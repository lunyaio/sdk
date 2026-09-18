# Lunya SDK

Integrate the Lunya exchange and launchpad, for **trading bots and aggregators**.

**Trading: quoting, swapping, limit orders, and buying and selling on the
bonding curve** — with the pool data to price locally and the events to follow
it live. No liquidity provision, no farming, no pool creation, no launching:
none of those is trading.

```
packages/
  sdk/      @lunya/sdk         framework-agnostic, viem for transport
  react/    @lunya/sdk-react   wagmi + TanStack Query hooks
examples/
  quote-node/    reads and a live-chain verification, no wallet
  curve-bot/     a bonding-curve trading bot — the whole write path, with a signer
  next-widget/   a swap widget as one component
```

## Addresses ship; overrides come from you

```bash
cp .env.example .env      # only to override something
```

The examples load `.env` from the repository root through Node's own
`process.loadEnvFile` — no dependency, nothing to install. **Anything exported in
the shell wins over the file**, which is what lets CI and a one-off run work
without editing anything.

`.env` is gitignored; `.env.example` is committed and documents every variable,
so it must never grow a real value.

The package ships the addresses of every network it lists — Arc mainnet and
Arc's public test network — as they were when the version was cut, so nothing
needs configuring to trade on them. `deploymentFromEnv()` overrides any of them
from the environment in Node, and `addresses` on the client from wherever else
you keep configuration: a fork, your own deployment, contracts newer than your
installed version.

## Choosing a network

```ts
createLunyaClient({ deployment: "mainnet" });      // production
createLunyaClient({ deployment: "testnet" });      // the public test network
createLunyaClient({ deployment: 5042002 });         // a chain id
createLunyaClient({ deployment: myDeployment });   // one this SDK never heard of
```

The two words exist because a chain id is something you have to already know.
`"mainnet"` is Arc mainnet (chain 5042), `"testnet"` Arc's public test network
(5042002).

`deploymentByChainId(id)` is there for anyone who thinks in chain ids, which is
most integrations. No local chain is shipped — a development node's addresses
belong to one run on one machine, so reaching one means passing a `Deployment`
yourself.

## Quick start

```bash
pnpm add @lunya/sdk viem
```

```ts
import { createLunyaClient, dex, launchpad } from "@lunya/sdk";

const client = createLunyaClient({ deployment: "testnet" });

// Price a swap and get an unsigned call back.
const { quote, transaction } = await dex.buildSwap(client, {
  tokenIn, tokenOut, amountIn: 1_000000n, slippageBps: 50, recipient,
});

// A launch is its own contract; `getLaunchByToken` is the hop if all you have
// is the token. Its curve prices off-chain, at the chain's time.
const launch = await launchpad.getLaunchByToken(client, token);
const { timestamp: now } = await client.publicClient.getBlock();
const preview = launchpad.curve.quoteBuy(launch, amountIn, { now });

// Size the minimum from a quote FOR THE RECIPIENT: a launch's first minutes
// surcharge buys, on whoever receives the tokens.
const { tokensOut } = await launchpad.quoteBuyFor(client, launch.address, amountIn, recipient);
const buy = launchpad.buildBuy(client, {
  launch: launch.address, quoteToken: launch.quoteToken,
  amountIn, expectedTokensOut: tokensOut, slippageBps: 100, recipient,
});
```

React:

```bash
pnpm add @lunya/sdk-react @lunya/sdk wagmi viem @tanstack/react-query
```

See [`packages/sdk`](packages/sdk) and [`packages/react`](packages/react) for the
full surface.

---

## The three things to know before you start

**Writes return unsigned calls; they do not send.** Every builder gives back
`{ to, data, value, approvals? }`. Your signer is a wagmi hook, an ethers
`Wallet`, a KMS or a Safe proposal, and an SDK that owned `sendTransaction`
would serve exactly one of them.

**The DEX is Uniswap-V3-shaped but not V3-compatible.** The events are identical
by design, so your indexing works unchanged. The periphery is not: the callbacks
are `lunya*`, a path's middle field is a **one-byte pool type** rather than a
three-byte fee, and pools are keyed on a curve rather than a fee tier. Route
through this SDK, never a V3 router.

**A launch is its own contract, priced in its own token.** One is cloned per
launch, so the address you call is not the address you hold — and the curve is
denominated in a quote token, with the gas coin as a separate entry point that
only some launches accept. Its first minutes surcharge buys, charged on the
recipient: quote with `quoteBuyFor`. The buy that fills the curve graduates it
on the spot, and from then its liquidity is in an ordinary pool: price it with
`dex`, not `launchpad`.

---

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test            # unit tests: the maths
```

Against a live chain:

```bash
pnpm --filter quote-node start     # what is deployed, and a quote from each product
pnpm --filter quote-node verify    # every claim, checked against the chain
```

### Generated code

`packages/sdk/src/generated/` holds the contract ABIs and the network registry,
and is **committed**. That is what makes this repository buildable on its own:
`pnpm install && pnpm build` needs nothing but what is here.

It is generated rather than transcribed, from the contract build artifacts. A
hand-pasted ABI drifts in the expensive direction — a struct grows a field, the
encoder still compiles, and the calldata means something the contract never
agreed to.

The generator is maintainer tooling and is not part of this repository. You never
need it.

### Two kinds of test

`pnpm test` proves the maths is self-consistent: the tick tables, the path
encoding, the bonding curve, the slippage bounds. No network.

`pnpm --filter quote-node verify` proves it agrees with the **live contracts**,
which is a different claim and the one that matters. An off-chain `quoteBuy`
that disagrees with the chain's by a wei produces a `minTokensOut` the contract
rejects — and that shows up as slippage on some fraction of trades rather than
as anything you could debug. It exits non-zero on disagreement.

It finds what to check on its own, from the factories' events: every pool and
every launch, the trades that must add up to each curve's state, and the tick
data that must reproduce each pool's liquidity. Run it on either network:

```bash
LUNYA_NETWORK=mainnet pnpm --filter quote-node verify
```

## Scope

**In:** quoting and swapping on the exchange, limit orders, and buying and
selling on the bonding curve. Plus what those need to work: pool discovery, pool
and launch state, tick data and live fees for pricing locally, permits, the
curve arithmetic off-chain, and the events.

**Out:** liquidity provision, farming, pool creation, launching and graduating.
None of them is trading. All of it is permissionless on-chain and none of it is
hard to call directly — leaving it out is a statement about what this package
supports and documents, not a barrier.

**Deliberately out:** path-finding beyond one hop through the hub. That is an
aggregator's job, and a half-hearted version would quietly return worse prices
than you could get elsewhere while looking like it had solved the problem.
`dex.quoteRoute` prices any route you hand it.

**Not yet:** a local swap simulator for the pools. `getTicks`, `getPoolState`
and `getCurrentFee` give one every input it needs, and the quoter stays the
exact answer — a simulator that disagreed with a pool by a wei would size
minimums that revert, so it ships only once it is proven against the contracts.

## Nothing here calls a hosted service

Pool discovery, quoting and every write run against whatever RPC you already
have — see **Discovery is yours** in the package README. That is deliberate: an
aggregator indexes for a living, and putting somebody else's uptime in its
critical path turns their lag into your stale prices, invisibly.