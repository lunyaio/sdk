# @lunya/sdk-react

React bindings for [`@lunya/sdk`](../sdk): wagmi for the chain, TanStack Query
for the reads.

Same scope as the core: quoting, swapping, and buying and selling on the curve.

```bash
pnpm add @lunya/sdk-react @lunya/sdk wagmi viem @tanstack/react-query
```

```tsx
<WagmiProvider config={wagmi}>
  <QueryClientProvider client={queryClient}>
    <LunyaProvider deployment="testnet">
      <App />
    </LunyaProvider>
  </QueryClientProvider>
</WagmiProvider>
```

`LunyaProvider` builds its client from **wagmi's** public client, so it has to
sit inside both. That is the point: one transport, one chain, one place the RPC
configuration lives. A second client built here would have its own idea of which
chain it was on, and the two would disagree the moment somebody switched
networks.

---

## No hook here sends a transaction

The builders return an unsigned `{ to, data, value }` and your app passes it to
wagmi's `useSendTransaction`. That keeps the confirmation modal, the pending
state and the error toast where you already have opinions about all three.

```tsx
const swap = useSwapBuilder();
const { sendTransaction } = useSendTransaction();

const tx = swap.exactIn(quote, { slippageBps: 50, recipient: address });
sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
```

See `examples/next-widget/SwapWidget.tsx` for the whole flow including the
approval step.

---

## DEX

```tsx
const { data: quote, isFetching, error } = useQuote({ tokenIn, tokenOut, amountIn });
const { data: pools } = usePairPools(tokenA, tokenB);
const { data: found } = useFindPools(tokens);            // memoise `tokens`
const { data: state } = usePoolState(pool, { poolType });
const { data: ticks } = useTicks(pool);
const { data: fee } = useCurrentFee(pool);               // { fee, source }
const { data: order } = useOrder({ plugin, owner, fillTick, sellingToken0, epoch });

const swap = useSwapBuilder();       // .exactIn(quote, opts) / .exactOut(...)
```

`useQuote` refetches every 12s and has `staleTime: 0` — a quote goes stale the
moment anyone else trades, and a swap built from a stale one reverts on its
minimum-out. It also does not retry: a failed quote is usually a route with no
liquidity, and three retries only make the empty state take four seconds to
appear.

The builders are **not** hooks and **not** async where they do not need to be —
call them in the click handler. Making a synchronous function into a hook only
adds a render between the button press and the wallet opening.

---

## Launchpad

A launch is its own contract, cloned per launch — so the address you pass is the
**launch**, not the token it sells.

```tsx
const { data: launch } = useLaunch(launchAddress);
const { data: byToken } = useLaunchByToken(token);   // one hop via the factory
const { data: many } = useLaunches(addresses);       // one batch, for a board

const preview = useCurveQuote(launch, "buy", amount);              // synchronous
const { data: exact } = useContractQuote({ launch: launchAddress, side: "buy", amount, recipient });

const { data: snipe } = useSnipeStatus({ launch: launchAddress, recipient });   // { taxBps, exempt }
useWatchLaunches(onLaunches);           // new launches, from the factory
useWatchTrades(launches, onTrades);     // buys and sells, from each launch

const lp = useLaunchpadBuilder();   // .buy / .buyWithNative / .sell / .sellForNative
```

**`useCurveQuote` is synchronous and memoised.** The curve is exact arithmetic on
state you are already holding, so there is nothing to await. Making it a query
would put a spinner on a microsecond of maths and leave the answer a render
behind the input — which is exactly what makes an amount field feel broken.

Use `useContractQuote` for the moment before signing, against state you have not
read this render.

**Pass it the `recipient`.** For a launch's first `snipeWindow` seconds buys pay a
surcharge, charged on who receives the tokens — the creator and anyone they
listed are exempt. Without a recipient the quote is for somebody who is not.
`useCurveQuote` takes `{ exempt, now }` for the same reason; `now` defaults to
this device's clock, which is fine for a preview and wrong for a minimum.

**Give the watch hooks a stable callback and a memoised address list.** wagmi
re-subscribes whenever either changes identity, and an inline one changes every
render.

**Amounts are in the launch's quote token**, not the gas coin. Paying with the
gas coin is a separate builder and only works where `launch.nativeDivisor` is
non-zero — and a native quote cannot be derived by scaling a quote-token one, so
reach for `curve.quoteBuyWithNative`.

Buy and sell, and nothing else — no `create`, no `graduate`. See
[`@lunya/sdk`](../sdk#launchpad) for the reasoning.

---

## Escape hatches

```tsx
const client = useLunya();          // the full LunyaClient
const ready = useLunyaReady();      // false until wagmi has a public client
```

`useLunya` throws outside the provider rather than returning null: every hook
needs it, and an optional chain through twelve hooks turns one missing provider
into twelve silent no-ops.
