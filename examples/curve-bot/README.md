# curve-bot

A trading bot on the bonding curve: price every live launch, buy the ones that
pass a rule, sell back out.

```bash
LUNYA_PRIVATE_KEY=0x… pnpm --filter curve-bot start        # dry run
LUNYA_PRIVATE_KEY=0x… LUNYA_DRY_RUN=false pnpm --filter curve-bot start
```

**Dry run by default.** Funded testnet key only.

The rule in there is a placeholder — buy anything under half-sold whose price it
moves less than a percent. Replace it. What is worth copying is the shape:

1. **One `getLaunches` multicall**, not a loop of `getLaunch`. Two hundred round
   trips is how a public endpoint rate-limits you before you have priced
   anything.
2. **Price off-chain first.** `curve.quoteBuy` is closed-form and agrees with the
   contract to the wei, given the chain's time — read once off a block, not off
   this machine's clock. Scanning two hundred launches costs nothing beyond the
   multicall that fetched them. Only survivors are worth an RPC call.
3. **Confirm on-chain immediately before signing**, with `quoteBuyFor` and the
   bot's own address, against state that is not a few blocks old.
4. **`explainLunyaError` on the way out**, so the log says `SlippageExceeded` and
   what it means rather than a revert selector.

## What the curve does that catches people

**A buy that overruns the curve is filled partially and refunded**, not reverted.
`quoteBuy` returns the `refund`, and sizing slippage against `tokensOut` already
accounts for it.

**The buy that fills the curve graduates it**, in the same transaction, and pays
the graduation reward to the sender. Budget the gas.

**A launch's first minutes surcharge buys**, on the recipient: the creator and
anyone they listed are exempt, nobody else is. `quoteBuy` answers for somebody
who is not exempt, `quoteBuyFor` for the address you name.

**Buying with the quote token needs an approval, and so does selling.** Buying
with the gas coin does not. The builders attach the approval to the request and
send nothing; `index.ts` sends it before the buy.

## Environment

`cp .env.example .env` in the repository root to override anything — the example
loads it automatically, and anything exported in the shell wins over the file.

**The key is not one of them.** Pass it on the command line for the run:

```bash
LUNYA_PRIVATE_KEY=0x… pnpm --filter curve-bot start
```

Not in `.env`. A file one character away from a committed one is how keys leak,
and nothing in `@lunya/sdk` ever needs a key — it builds unsigned calls, and this
example signs them itself.


| Variable | Default | |
|---|---|---|
| `LUNYA_PRIVATE_KEY` | — | required |
| `LUNYA_DRY_RUN` | `true` | `false` to actually send |
| `LUNYA_SPEND` | `1e16` | per buy, in base units of the launch's quote token |
| `LUNYA_SLIPPAGE_BPS` | `100` | 1% |
| `LUNYA_NETWORK` | `testnet` | or `mainnet`, or a chain id |
| `LUNYA_DEX_*`, `LUNYA_LAUNCH_FACTORY` | shipped | optional overrides |
| `LUNYA_RPC_URL` | the deployment's public endpoint | |
