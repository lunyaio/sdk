import { getAddress, type Address } from "viem";

import { poolAbi, quoterAbi } from "../generated/abis.js";
import type { LunyaClient } from "../client.js";
import { NoRouteError, InvalidArgumentError } from "../errors.js";
import { encodePath, reversePath } from "../internal/path.js";
import { NO_PRICE_LIMIT } from "../internal/math.js";
import { getPairPools } from "./pools.js";
import type { Hop, Quote, PoolType } from "../types.js";

/**
 * Pricing.
 *
 * THE QUOTER'S FUNCTIONS ARE NOT VIEWS, and that surprises everyone once. Each
 * hop is priced by starting a real swap and reverting out of the callback,
 * which is what makes a quote free of side effects — but it means `readContract`
 * will refuse them. Everything here goes through `simulateContract`, and an
 * integrator calling the quoter directly must do the same.
 *
 * ROUTING IS DELIBERATELY SMALL: a pool per pair, or one hop through the hub
 * (the pair token). An SDK that shipped a half-hearted path-finder would quietly
 * return worse prices than the caller could get from a real aggregator while
 * looking like it had solved the problem — so the shape of the search is stated
 * plainly and left where a caller can replace it: `quoteRoute` prices any route
 * you hand it.
 */

export type QuoteOptions = {
  /** Cap the price move. Zero — the default — is the periphery's "unbounded". */
  sqrtPriceLimitX96?: bigint;
  /**
   * Consider routes through these tokens as well as the direct pair.
   *
   * Defaults to the client's `routeThrough`, which is the pair token.
   */
  routeThrough?: Address[];
  /** Skip the hub search and price only the direct pair. */
  directOnly?: boolean;
};

/*//////////////////////////////////////////////////////////////
                        Route discovery
//////////////////////////////////////////////////////////////*/

/**
 * Every route worth pricing for a pair: one per curve that exists directly,
 * plus one per curve-pair through each hub.
 *
 * A route that visits the same pool twice is not generated, and would be
 * refused by the quoter if it were: each hop is simulated and rolled back, so a
 * second visit would price against the original reserves while the router's
 * second visit sees the move the first one made. Refusing is what keeps
 * "a route that quotes is a route that executes" true.
 */
export async function findRoutes(
  client: LunyaClient,
  tokenIn: Address,
  tokenOut: Address,
  options: QuoteOptions = {}
): Promise<Hop[][]> {
  const from = getAddress(tokenIn);
  const to = getAddress(tokenOut);
  if (from === to) throw new InvalidArgumentError("tokenIn and tokenOut are the same token");

  const direct = await getPairPools(client, from, to);
  const routes: Hop[][] = direct.map((p) => [
    { tokenIn: from, tokenOut: to, poolType: p.poolType, pool: p.pool },
  ]);

  if (options.directOnly) return routes;

  const hubs = (options.routeThrough ?? client.routeThrough)
    .map(getAddress)
    .filter((h) => h !== from && h !== to);

  for (const hub of hubs) {
    const [legA, legB] = await Promise.all([
      getPairPools(client, from, hub),
      getPairPools(client, hub, to),
    ]);
    for (const a of legA) {
      for (const b of legB) {
        // Impossible for distinct pairs, but cheap to assert, and the quoter
        // would revert rather than mislead if it ever happened.
        if (a.pool === b.pool) continue;
        routes.push([
          { tokenIn: from, tokenOut: hub, poolType: a.poolType, pool: a.pool },
          { tokenIn: hub, tokenOut: to, poolType: b.poolType, pool: b.pool },
        ]);
      }
    }
  }

  return routes;
}

/*//////////////////////////////////////////////////////////////
                          Quoting
//////////////////////////////////////////////////////////////*/

/** Price one route you already have, exact-in. */
export async function quoteRoute(
  client: LunyaClient,
  hops: Hop[],
  amountIn: bigint,
  options: QuoteOptions = {}
): Promise<Quote> {
  const quoter = client.dexAddress("quoter");
  const first = hops[0];
  if (!first) throw new InvalidArgumentError("a route needs at least one hop");

  if (hops.length === 1) {
    const { result } = await client.publicClient.simulateContract({
      address: quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        first.tokenIn,
        first.tokenOut,
        first.poolType,
        amountIn,
        options.sqrtPriceLimitX96 ?? NO_PRICE_LIMIT,
      ],
    });
    return {
      hops,
      amountIn,
      amountOut: result as bigint,
      feeAmount: await poolFee(client, first),
    };
  }

  const path = encodePath(hops);
  const { result } = await client.publicClient.simulateContract({
    address: quoter,
    abi: quoterAbi,
    functionName: "quoteExactInput",
    args: [path, amountIn],
  });

  return {
    hops,
    path,
    amountIn,
    amountOut: result as bigint,
    feeAmount: await poolFee(client, first),
  };
}

/** Price one route exact-out. The path it encodes is REVERSED, as the router wants. */
export async function quoteRouteExactOut(
  client: LunyaClient,
  hops: Hop[],
  amountOut: bigint,
  options: QuoteOptions = {}
): Promise<Quote> {
  const quoter = client.dexAddress("quoter");
  const first = hops[0];
  if (!first) throw new InvalidArgumentError("a route needs at least one hop");

  if (hops.length === 1) {
    const { result } = await client.publicClient.simulateContract({
      address: quoter,
      abi: quoterAbi,
      functionName: "quoteExactOutputSingle",
      args: [
        first.tokenIn,
        first.tokenOut,
        first.poolType,
        amountOut,
        options.sqrtPriceLimitX96 ?? NO_PRICE_LIMIT,
      ],
    });
    const [amountIn, received] = result as readonly [bigint, bigint];
    return {
      hops,
      amountIn,
      amountOut,
      amountOutReceived: received,
      feeAmount: await poolFee(client, first),
    };
  }

  // Reversed: a hop only learns what it must produce once the hop after it has
  // been priced, so the walk starts at the end of the trade. A forward path here
  // is not an error the contract can detect — it prices a route nobody asked for.
  const path = encodePath(reversePath(hops));
  const { result } = await client.publicClient.simulateContract({
    address: quoter,
    abi: quoterAbi,
    functionName: "quoteExactOutput",
    args: [path, amountOut],
  });
  const [amountIn, received] = result as readonly [bigint, bigint];

  return {
    hops,
    path,
    amountIn,
    amountOut,
    amountOutReceived: received,
    feeAmount: await poolFee(client, first),
  };
}

/**
 * The best exact-in quote across every route that exists.
 *
 * Routes are priced concurrently and the failures are dropped: a pool with no
 * liquidity reverts rather than quoting zero, and one dead curve should not
 * take the other two down with it. If every route fails, the reason from the
 * first one is raised — silently reporting "no route" for what is actually an
 * RPC outage is the failure mode this avoids.
 */
export async function getBestQuote(
  client: LunyaClient,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  options: QuoteOptions = {}
): Promise<Quote> {
  if (amountIn <= 0n) throw new InvalidArgumentError("amountIn must be positive");

  const routes = await findRoutes(client, tokenIn, tokenOut, options);
  if (routes.length === 0) throw new NoRouteError(tokenIn, tokenOut);

  const settled = await Promise.allSettled(
    routes.map((hops) => quoteRoute(client, hops, amountIn, options))
  );
  return best(settled, tokenIn, tokenOut, (q) => q.amountOut, "max");
}

/** The cheapest exact-out quote across every route that exists. */
export async function getBestQuoteExactOut(
  client: LunyaClient,
  tokenIn: Address,
  tokenOut: Address,
  amountOut: bigint,
  options: QuoteOptions = {}
): Promise<Quote> {
  if (amountOut <= 0n) throw new InvalidArgumentError("amountOut must be positive");

  const routes = await findRoutes(client, tokenIn, tokenOut, options);
  if (routes.length === 0) throw new NoRouteError(tokenIn, tokenOut);

  const settled = await Promise.allSettled(
    routes.map((hops) => quoteRouteExactOut(client, hops, amountOut, options))
  );
  // A route that cannot deliver the whole amount is not a cheaper route, it is a
  // route that fails — so those are dropped before comparing what they cost.
  const fillable = settled.map((r) =>
    r.status === "fulfilled" && r.value.amountOutReceived !== undefined &&
    r.value.amountOutReceived < amountOut
      ? ({ status: "rejected", reason: new Error("route cannot fill the requested amount") } as const)
      : r
  );
  return best(fillable, tokenIn, tokenOut, (q) => q.amountIn, "min");
}

/*//////////////////////////////////////////////////////////////
                          Internals
//////////////////////////////////////////////////////////////*/

function best(
  settled: readonly PromiseSettledResult<Quote>[],
  tokenIn: string,
  tokenOut: string,
  by: (q: Quote) => bigint,
  direction: "max" | "min"
): Quote {
  const ok = settled.filter((r): r is PromiseFulfilledResult<Quote> => r.status === "fulfilled");

  if (ok.length === 0) {
    const first = settled.find((r) => r.status === "rejected");
    const cause = first && first.status === "rejected" ? first.reason : undefined;
    const error = new NoRouteError(tokenIn, tokenOut);
    if (cause) error.cause = cause;
    throw error;
  }

  return ok.reduce((winner, candidate) => {
    const a = by(winner.value);
    const b = by(candidate.value);
    const better = direction === "max" ? b > a : b < a;
    return better ? candidate : winner;
  }).value;
}

/**
 * A hop's fee, in hundredths of a bip, read from the POOL.
 *
 * Not from a fee tier — there are none — and not from `fee()`, which does not
 * exist on these pools. `feeInfo()` returns `(fee, isDynamic)` and is always a
 * plain read. Zero when the pool address was not resolved; a fee is a label
 * here, not something a swap depends on.
 */
async function poolFee(client: LunyaClient, hop: Hop): Promise<number> {
  if (!hop.pool) return 0;
  try {
    const info = await client.publicClient.readContract({
      address: hop.pool,
      abi: poolAbi,
      functionName: "feeInfo",
    });
    return Number((info as readonly [number, boolean])[0]);
  } catch {
    return 0;
  }
}

export type { Quote, Hop, PoolType };
