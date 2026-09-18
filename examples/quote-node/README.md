# quote-node

Reads only, no wallet. Two scripts.

```bash
pnpm --filter quote-node start    # what is deployed, a swap quote, a curve quote
pnpm --filter quote-node verify   # the SDK checked against the live chain
```

`start` is the first thing to run against a deployment you have not used before:
it answers the two questions that block everything else — is the RPC reachable,
and are the addresses this SDK ships still the live ones.

`verify` is the stronger claim. The unit tests prove the maths is
self-consistent; this proves it agrees with the deployed contracts, which is a
different thing. It checks every curve quote against the launchpad's own view to
the wei; reads back every `PoolCreated`, `LaunchCreated` and `Trade` since the
deployment began, and requires the trades to add up to each curve's state;
checks `computePoolAddress` against pools the factory actually created; walks
each pool's ticks, which must reproduce its liquidity; and runs real routing and
calldata on pools with real liquidity. It exits non-zero on any
disagreement, so it works as a post-deploy gate.

## Environment

`cp .env.example .env` in the repository root to override anything — the example
loads it automatically. Anything exported in the shell wins over the file.


| Variable | Default |
|---|---|
| `LUNYA_NETWORK` | `testnet` — or `mainnet`, or a chain id |
| `LUNYA_DEX_*`, `LUNYA_LAUNCH_FACTORY` | optional overrides of the shipped addresses |
| `LUNYA_RPC_URL` | the deployment's public endpoint |
| `LUNYA_TOKENS` | the tokens pools were announced for, plus the launched ones |
| `LUNYA_LOG_SPAN` | `2000` — blocks per `eth_getLogs`, what Arc's public endpoint allows |

Point `LUNYA_RPC_URL` at your own node before doing anything in a loop. The
shipped endpoint is public, and `verify` paces itself around its rate limit —
which is the same pacing any integration on a public endpoint will find it
needs.
