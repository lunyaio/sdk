# @lunya/sdk

TypeScript SDK for the Lunya exchange and launchpad, for **trading bots and
aggregators**. Framework-agnostic; viem for transport. React bindings live in
[`@lunya/sdk-react`](../react).

**Scope: trading.** Quoting and swapping, limit orders, and buying and selling
on the bonding curve — plus what doing those well takes: discovery, pool and
launch state, the tick distribution and live fees for pricing a pool yourself,
permits, and the events to follow it all live. No liquidity provision, no
farming, no pool creation, no launching — none of those is trading, and an SDK
that shipped them would be documenting and promising a surface nobody in the
audience uses.

```bash
pnpm add @lunya/sdk viem
```

```ts
import { createLunyaClient, dex } from "@lunya/sdk";

const client = createLunyaClient({ deployment: "testnet" });

const { quote, transaction } = await dex.buildSwap(client, {
  tokenIn,
  tokenOut,
  amountIn: 1_000000n,
  slippageBps: 50,
  recipient,
});

// `transaction` is an unsigned { to, data, value }. Hand it to any signer.
```

---

## Three things that surprise people

Each of these costs an afternoon if you find it the hard way.

### 1. Writes return unsigned calls; they do not send

Every builder gives back a `TransactionRequest`:

```ts
{ to, data, value, approvals?, description? }
```

Your signer is a wagmi hook, an ethers `Wallet`, a KMS, a Safe proposal or a
queue — and an SDK that owned `sendTransaction` would serve exactly one of them.
`client.send()` exists for when a viem `WalletClient` really is what you have;
`client.sendAll()` sends the approvals first.

`approvals` says what the call *needs*. It does not say what is *outstanding* —
building is offline and cannot know. `pendingApprovals(publicClient, owner, tx.approvals)`
asks the chain, so you do not put a redundant approval in front of a user.

Nothing here approves `maxUint256` by default. That is the standard convenience
and also the standard way a later router bug drains a wallet; pass
`approveAmount: maxUint256` if you want it.

### 2. The DEX is Uniswap-V3-shaped, not Uniswap-V3-compatible

**Identical, on purpose:** `swap`, `mint`, `burn`, `collect`, `flash`,
`initialize` signatures, and the `Initialize` / `Mint` / `Burn` / `Collect` /
`Swap` / `Flash` events. **Your existing indexing works unchanged.**

**Different:**

| Surface | Here |
|---|---|
| Callbacks | `lunyaSwapCallback`, `lunyaMintCallback`, `lunyaFlashCallback` |
| `fee()` | Absent. `feeInfo()` returns `(fee, isDynamic)` |
| `slot0()` | Five fields, not seven, and the same five on every pool type |
| Fee tiers | None. `createPool(tokenA, tokenB, poolType)` |
| Path encoding | `token \| poolType(**1 byte**) \| token` — not a 3-byte fee |
| Pool addresses | CREATE2 from the **deployer**, not the factory |
| Oracle | A plugin, not part of the pool |

An unmodified V3 router **cannot** trade against these pools. The path encoding
is the one to watch: a V3-shaped path is so nearly right that it can decode into
a different pool. `decodePath` rejects one explicitly and says why.

### 3. A launch stops being a launch

| Phase | | |
|---|---|---|
| `Trading` | 1 | the curve is open |
| `Graduated` | 3 | liquidity is in a locked CP pool |

Nothing in between. **The buy that fills the curve graduates it, in the same
transaction**: it opens the pool, mints and locks the position, and pays the
graduation reward to whoever sent it. That buy costs more gas than an ordinary
one, and the trade after it is a DEX trade.

Once graduated, price it with `dex`, not `launchpad` — `quoteBuy` answers
**zero** rather than erroring, so a screen that does not check the phase shows a
number nobody can trade at.

---

## The client

### Addresses ship; you can override them

The registry carries every listed network's chain metadata and contract
addresses, so `createLunyaClient({ deployment: "mainnet" })` is all it takes to
trade. Override any of them — a fork, your own deployment, contracts newer than
this version:

```ts
import { createLunyaClient, deploymentFromEnv } from "@lunya/sdk";

// from the environment, in Node
const client = createLunyaClient({ deployment: deploymentFromEnv() });

// or from wherever you keep configuration
const client = createLunyaClient({
  deployment: "testnet",
  addresses: {
    dex: { factory, poolDeployer, swapRouter, quoter },
    launchFactory: { address: launchFactory },
  },
});
```

```
LUNYA_CHAIN_ID           5042002        or omit, and pass { network: "testnet" }
LUNYA_RPC_URL            https://…      optional; overrides the shipped endpoint

LUNYA_DEX_FACTORY        0x…            \
LUNYA_DEX_POOL_DEPLOYER  0x…             |  optional; override the DEX
LUNYA_DEX_SWAP_ROUTER    0x…             |
LUNYA_DEX_QUOTER         0x…            /

LUNYA_LAUNCH_FACTORY     0x…            optional; overrides the launch factory
LUNYA_PAIR_TOKEN         0x…            optional; the default routing hub
```

The repository root has a `.env.example` listing every variable; the examples
load `.env` from there through Node's own `process.loadEnvFile`. In your own
project, load it however you already do — this package only reads what is in the
environment by the time you call it.

**`deploymentFromEnv` is the only thing here that reads `process.env`**, and it
does it because you called it. A library that picked configuration out of the
environment on its own behaves differently in a test than in production for
reasons nothing at the call site explains, and does not work in a browser at
all.

A `Deployment` you build yourself without some of them answers
`client.has("dex")` false, and every accessor throws by name saying what is
missing — never a call encoded to `undefined`.

### Choosing a network

```ts
createLunyaClient({ deployment: "mainnet" });   // production
createLunyaClient({ deployment: "testnet" });   // the public test network
createLunyaClient({ deployment: 5042002 });     // a chain id
createLunyaClient({ deployment: myDeployment }); // one this SDK never heard of
```

The two words exist because a chain id is something you have to already know:
`"mainnet"` is Arc mainnet (5042), `"testnet"` Arc's public test network
(5042002).

No local chain is shipped. A development node's addresses come out of one run on
one machine — same script, same order, same nonces — so they match nobody else's
node. Working against one means passing a `Deployment` of your own, which is the
same escape hatch you use for a network newer than the SDK you installed.

Nothing here guesses. Two networks matching one selector is refused, not
resolved: picking silently is how an integration ends up on contracts it did not
choose.

```ts
deploymentByChainId(5042002)   // what an aggregator actually thinks in
deploymentsByChainId(id)       // all of them, if a chain ever hosts several
mainnetDeployments()           // Arc mainnet
testnetDeployments()
client.deployment.testnet      // what you actually got
```

```ts
const client = createLunyaClient({
  deployment: "testnet",          // or "mainnet", a chain id, or a Deployment
  transport: http(MY_RPC),        // the shipped rpcUrl is public — bring your own
  publicClient,                   // or reuse one you already have
  walletClient,                   // only for client.send()
  addresses: { dex: { swapRouter: "0x…" } },   // merged over the registry's
  routeThrough: [HUB],            // extra hops, beyond the pair token
});
```

`client.has("dex" | "launchpad")` feature-gates without a try/catch.
`chainOf(deployment)` gives you a viem `Chain`, so you do not hand-write one for
a chain your wallet library has never heard of.

A listed deployment is a claim about what these addresses were when this version
was cut, not about what is live this minute — a test network's contracts get
replaced. Pin the version, or pass your own `addresses`.

## DEX

```ts
import { dex } from "@lunya/sdk";

await dex.getPairPools(client, tokenA, tokenB);       // which curves exist
await dex.getPoolState(client, pool);                 // price, fee, liquidity, plugin, STABLE state
await dex.getTicks(client, pool);                     // the liquidity distribution
await dex.getCurrentFee(client, pool);                // what the next swap pays

await dex.getBestQuote(client, tokenIn, tokenOut, amountIn);
await dex.getBestQuoteExactOut(client, tokenIn, tokenOut, amountOut);

dex.buildSwapFromQuote(client, quote, { slippageBps: 50, recipient });
```

### Discovery is yours

The factory has **no enumeration** — `getPool(tokenA, tokenB, poolType)` and
nothing else. So the SDK gives you the two things that replace it, and **neither
touches the Lunya indexer**. An aggregator indexes for a living and should not
have our uptime in its critical path; if our indexer lags, your prices go stale
and we are the ones who look broken.

**Derive, offline.** A pool is CREATE2 from the deployer, salted by
`(token0, token1, poolType)`. Read the three init code hashes once, and every
address after that is local arithmetic — no RPC, no rate limit, no bound:

```ts
const at = await dex.poolAddressFn(client);   // one read, then offline forever
at(tokenA, tokenB, PoolType.CL);              // pure, zero network
```

The hashes are read from the chain, never hardcoded: the hash is a property of
the deployment, and a constant would compute confident, wrong addresses on a
chain that shipped a different blueprint.

This also verifies. Given a pool address from an untrusted source, derive it from
the pair — one that does not derive is not a Lunya pool for that pair, whatever
it claims.

**Confirm, in batches.** Derivation says where a pool *would* be, not whether it
exists:

```ts
await dex.findPools(client, myTokenUniverse);   // every pair x every curve
```

Batched multicalls against the factory. No `eth_getLogs`, so no range cap, no
archive node, and nothing that degrades as the chain ages. Quadratic in the token
count — run it once over your universe, then keep it current from `PoolCreated`.

**Stream it yourself.** `dex.poolCreatedEvent` is the ABI item for your own
`watchEvent` / `getLogs` filter. It is exported rather than wrapped because how
you index — websocket, polled logs, archive backfill, a queue — is your
infrastructure decision. The event carries the pool's type, tick spacing and
birth fee, so you can build a row from the log without reading the pool. And the
pool events themselves are V3-identical, so your existing pipeline already
understands them.

`PoolCreated` is declared twice on the factory, under two different topics: the
native event, with the pool type as a `uint8` and the birth fee, and a V3-shaped
one that stays silent unless a deployment switches it on. `poolCreatedEvent` is
the native one. Pick the event out of the ABI by name and you may get the other —
and a filter on the wrong topic does not fail, it matches nothing.

**Quoting is a simulation, not a read.** The quoter's functions are non-`view`
by design — each hop is priced by starting a real swap and reverting out of the
callback, which is what makes a quote free of side effects. `readContract` will
refuse them; everything here uses `simulateContract`.

**Routing is deliberately small:** one pool per pair, or one hop through the
pair token. That is what the app itself does. An SDK shipping a half-hearted
path-finder would quietly return worse prices than you could get from a real
aggregator while looking like it had solved the problem — so the shape is stated
plainly and `quoteRoute` prices any route you hand it.

**On a STABLE pool, `slot0().tick` is a measurement, not a place.** Nothing is
held at it — `PoolState.tickIsReal` says so. It matters for reading a price, and
it is why generic code should never assume a tick names a position boundary.

**A STABLE pool is its own contract.** CL and CP share one implementation and
`abis.pool`; STABLE has `abis.stablePool`, with the shared reads above plus its
curve's own state — amplification, reserves, rates. A swap that reverts inside
one decodes by name either way: `explainLunyaError` knows every pool type's
errors.

### Pricing a pool yourself

The quoter is exact and costs a round trip per quote. An aggregator that prices
locally needs each pool's inputs, and the SDK reads all of them; the simulator
is yours.

```ts
const state = await dex.getPoolState(client, pool, { poolType }); // STABLE state included
const ticks = await dex.getTicks(client, pool);                    // CL and CP
const { fee, source } = await dex.getCurrentFee(client, pool);
```

Four things differ from Uniswap V3, and each silently breaks a V3 simulator:

- **The tick index is not divided by the spacing.** A bitmap word is
  `tick >> 8`. `getTicks` walks the tree with public views, pinned to one block.
  Do not filter ticks by spacing: it can change on a live pool, and positions
  from before stay where they were and are still crossed.
- **A swap steps from initialized tick to initialized tick,** never stopping at
  a bitmap word's edge. A simulator that does rounds differently.
- **The fee can come off the output.** `state.feeToken` says which coin a pool
  charges in; on the output side the curve runs fee-free and the fee is taken
  from what each step delivers.
- **The default plugin prices the fee dynamically.** `feeInfo()` on such a pool
  is what the LAST swap paid. `getCurrentFee` asks the plugin for the fee right
  now and labels its `source`; it moves with time, so a swap mined later can pay
  a little differently.

A CP pool trades at constant `liquidity`: its only ticks are the ends of the
full range, which no swap reaches. A STABLE pool has no ticks at all and prices
from `state.stable` — reserves, rates, and an amplification that can be
mid-ramp.

### Paying by permit

A token that supports EIP-2612 can skip the approval transaction:

```ts
const typedData = await buildPermitTypedData(client.publicClient, {
  token: tokenIn,
  owner,
  spender: client.dexAddress("swapRouter"),
  value: amountIn,
  deadline,
});
// null for a token without permits: approve instead.
const signature = await walletClient.signTypedData({ account, ...typedData });

dex.buildSwapFromQuote(client, quote, {
  slippageBps: 50,
  recipient,
  permit: { value: amountIn, deadline, signature },   // no approvals attached
});
```

The domain is read from the token, never assumed — USDC signs under version
"2", most tokens under "1", and a signature under the wrong one is rejected. The
permit rides in the swap's batch as `selfPermitIfNecessary`, so a permit
somebody front-runs costs nothing: the allowance is already there and the swap
goes through.

### Limit orders

An order rests liquidity one tick-spacing wide beyond the price, on the pool's
plugin. A swap through it converts it; the owner claims.

```ts
const state = await dex.getPoolState(client, pool);
const at = { fillTick, sellingToken0: true };
const liquidity = dex.orderLiquidity({ ...at, tickSpacing: state.tickSpacing, amount });

const { epoch } = await dex.getOrderBatch(client, { ...at, plugin: state.plugin! });   // keep it
dex.buildPlaceOrder({ ...at, pool: state, liquidity });   // one approval, to the plugin

const order = await dex.getOrder(client, { ...at, plugin: state.plugin!, owner, epoch });
if (order.status === "filled") dex.buildClaimOrder({ ...at, plugin: state.plugin!, epoch });
```

- **Keep the epoch.** Orders at one tick and side batch together, a fill opens
  the next epoch, and a claim names the one it claims. No event carries it on
  placement — `getOrderBatch` just before you place does.
- **The owner is the sender.** There is no recipient: a contract that places an
  order is the one that cancels and claims it.
- **Settlement is bounded per swap.** What a swap crosses but cannot settle
  waits, and goes back to resting if the price retreats first.
  `settlementIncompleteEvent` says it happened; `buildPokeOrders` settles it,
  and anybody may send it.
- **No swap fees for the placer.** A claim pays the converted principal, pro
  rata, rounded down.
- **CL pools only**, and only where the pool calls its plugin after swaps.
  `buildPlaceOrder` checks that, the tick and the price before you sign.

The plugin's events — placed, cancelled, filled, claimed, settlement incomplete
— are exported for your own log filters, on `state.plugin`.

---

## Launchpad

**One contract per launch.** A factory clones them, the way the pool factory
clones pools — so a launch has an address of its own, distinct from the token it
sells, and *that* is what you call.

```ts
import { launchpad } from "@lunya/sdk";

const launch = await launchpad.getLaunch(client, launchAddress);
const same   = await launchpad.getLaunchByToken(client, token);   // one hop via the factory
const many   = await launchpad.getLaunches(client, addresses);    // one batch

await launchpad.listLaunches(client, { limit: 50 });
await launchpad.listTokens(client, { limit: 50 });                // [{ token, launch }]
await launchpad.isLaunch(client, address);
await launchpad.predictLaunch(client, { quoteToken, creator, creatorFeeRecipient, salt });
```

**The curve is priced in a quote token, not the gas coin.** Every amount below
is in `launch.quoteToken` unless the name says otherwise:

```ts
// Off-chain, exact, no round trip. A buy needs the chain's time — see below.
const { timestamp: now } = await client.publicClient.getBlock();

launchpad.curve.quoteBuy(launch, amountIn, { now });  // { tokensOut, fee, refund, snipeFee }
launchpad.curve.quoteSell(launch, tokensIn);          // { amountOut, fee }
launchpad.curve.costToComplete(launch, { now });      // the largest buy worth sizing
launchpad.curve.price(launch);                        // quote units per whole token

// The launch's own answer, for the moment before signing:
await launchpad.quoteBuyFor(client, launch.address, amountIn, recipient);
await launchpad.quoteSell(client, launch.address, tokensIn);
```

```ts
launchpad.buildBuy(client, {
  launch: launch.address,
  quoteToken: launch.quoteToken,     // for the approval it needs
  amountIn,
  expectedTokensOut,
  slippageBps: 100,
  recipient,                          // deliver to somebody other than the payer
});

launchpad.buildSell(client, {
  launch: launch.address,
  token: launch.token,                // for the approval it needs
  tokensIn,
  expectedAmountOut,
  slippageBps: 100,
  recipient,
});
```

### Following launches live

`launchCreatedEvent` comes from the factory — one address covers every launch.
`tradeEvent`, `curveCompletedEvent` and `graduatedEvent` come from each launch.

```ts
publicClient.watchEvent({ address: client.launchFactoryAddress(), event: launchpad.launchCreatedEvent, onLogs });
publicClient.watchEvent({ address: launches, event: launchpad.tradeEvent, onLogs });
```

A `Trade`'s `trader` is whose balance in the token moved — the recipient of a
buy, the seller of a sell — and `reserve` and `sold` are the curve after it, so
a launch can be followed from its logs alone. A log from an address the factory
did not give you is not a launch until `isLaunch` says so.

### The anti-snipe surcharge

For its first `snipeWindow` seconds a launch adds a surcharge to every buy, on
top of the curve fee. It opens at `snipeTaxBps` and decays to zero:

```
snipeTaxBps · (snipeWindow − elapsed)^snipeDecay / snipeWindow^snipeDecay
```

**It is charged on the recipient, not the sender.** The creator, and any address
the creator listed at launch, is exempt — and a buy an aggregator routes for a
user is taxed on the user. So:

- **Quote for the recipient.** The launch's `quoteBuy` cannot know who the tokens
  are for, and answers for somebody who is not exempt. `quoteBuyFor` is exact;
  off-chain, pass `exempt` in the context. `isExempt` and `currentSnipeTaxBps`
  ask the chain.
- **Use the chain's clock.** `now` is `block.timestamp`. A clock ahead of the
  chain sees a smaller surcharge than the contract charges, quotes more tokens
  than the buy delivers, and sizes a minimum that reverts.

Sells are never surcharged. Past the window a buy pays `curveFeeBps` alone, and
`quoteBuy` and `quoteBuyFor` agree.

### Paying with the gas coin is a different entry point

It exists only where the launch was set up for it — `launch.nativeDivisor === 0n`
means it was not, and the contract reverts.

```ts
launchpad.curve.quoteBuyWithNative(launch, nativeIn, { now });   // null where not accepted
launchpad.buildBuyWithNative(client, { launch, nativeIn, expectedTokensOut, slippageBps });
launchpad.buildSellForNative(client, { launch, token, tokensIn, expectedNativeOut, slippageBps });
```

**Do not size a native buy from a quote-token quote.** The conversion truncates,
and what falls below one whole unit of the quote token is never spent — it comes
back, in the unit it arrived in, on top of whatever the curve itself refunds.
`quoteBuyWithNative` accounts for that dust; multiplying a quote-token refund by
the divisor loses it silently.

The launch's own `quoteBuyWithNative` has no per-recipient twin: it answers for
somebody who is not exempt, so for a recipient who is, it is the cautious figure.

### The rest of it

**`curve.*` agrees with the contract to the wei**, rounding included, given the
same block time and the same recipient. That is the whole point of having it: a
`minTokensOut` sized off-chain survives the
contract's own recomputation, so you can scan hundreds of launches from state you
already hold and only pay for an RPC call on the ones you will actually trade.

**A buy that overruns the curve is filled partially and refunded**, not reverted.
`quoteBuy` returns the `refund`, and sizing slippage against `tokensOut` already
accounts for it.

**Selling needs an approval; buying with the gas coin does not.** `buildSell`
attaches the approval to the request and sends nothing.

**Buy and sell, and nothing else.** Creating a launch and graduating one are both
out of scope: neither is trading. The contracts are permissionless and the ABIs
ship whole, so this is not a barrier and does not pretend to be one — it is a
statement about what this package supports.

---

## Errors

```ts
import { explainLunyaError, decodeLunyaRevert } from "@lunya/sdk";

catch (error) {
  console.log(explainLunyaError(error));
  // "SlippageExceeded: The curve moved between quoting and executing.
  //  Re-quote, or raise your minimum-out tolerance."
}
```

Decoded against every custom error in the protocol, not just the ABI you called
with — a pool's revert reaching you through the router is otherwise an
undecodable selector.

---

## Maths, exported

`minusSlippage`, `plusSlippage`, `defaultDeadline`, `sqrtRatioAtTick`,
`tickAtSqrtRatio`, `encodePath`, `decodePath`, `reversePath`.

Exact integers, not floats: these go into calldata, and a rounding error is real
tokens. The slippage rounding is deliberately asymmetric — a floor rounds down,
a ceiling rounds up — so both land in your favour rather than against the bound
you set. The tick pair is there for one job: turning a price you want to cap at
into the `sqrtPriceLimitX96` a swap takes.

`abis` carries those ABIs whole, for a read or an event filter this SDK does
not wrap.

---

## Generated code

`src/generated/` holds the ABIs and the network registry, committed so this
package builds from a clone with nothing else in it.

Generated from the contract build artifacts rather than transcribed, because a
hand-pasted ABI drifts in the expensive direction: a struct grows a field, the
encoder still compiles, and the calldata means something the contract never
agreed to. The generator is maintainer tooling and is not in this repository —
you never need it.

## Tests

```bash
pnpm test                          # unit: the maths, self-consistent
pnpm --filter quote-node verify    # integration: agrees with a live chain
```

The second finds what to check from the factories' events, on either network:
`LUNYA_NETWORK=mainnet pnpm --filter quote-node verify`.