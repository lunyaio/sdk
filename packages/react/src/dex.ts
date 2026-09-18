"use client";

import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import type { Address } from "viem";
import { dex, type PoolType, type Quote, type TransactionRequest } from "@lunya/sdk";

import { useLunya } from "./provider.js";

/**
 * DEX hooks.
 *
 * All reads, all through TanStack Query, and none of them write. A hook that
 * sent a transaction would own the confirmation UI, the pending state and the
 * error surface — three things every app already has opinions about. So the
 * write hooks return a `TransactionRequest` and the app passes it to
 * `useSendTransaction`.
 *
 * Quoting, swapping, pool data and limit orders. Liquidity provision and
 * farming are out of the SDK's scope, so there are no hooks for them.
 */

type QueryTuning = {
  enabled?: boolean;
  refetchInterval?: number | false;
  staleTime?: number;
};

/** Which curves exist for a pair, and where. */
export function usePairPools(
  tokenA: Address | undefined,
  tokenB: Address | undefined,
  options: QueryTuning = {}
): UseQueryResult<dex.PairPool[]> {
  const client = useLunya();
  return useQuery({
    queryKey: ["lunya", "pairPools", client.deployment.chainId, tokenA, tokenB],
    enabled: Boolean(tokenA && tokenB && client.has("dex")) && options.enabled !== false,
    // Pools are created rarely; refetching this per keystroke is pure noise.
    staleTime: options.staleTime ?? 60_000,
    queryFn: () => dex.getPairPools(client, tokenA!, tokenB!),
  });
}

/**
 * Every pool among a token universe, found on your own RPC.
 *
 * `dex.findPools` behind a query: addresses derived offline, existence confirmed
 * in batched multicalls, no indexer. Kept fresh for a minute by default — pools
 * are created rarely, and the call grows with the square of the token count.
 * Memoise `tokens`, or every render is a new key.
 */
export function useFindPools(
  tokens: readonly Address[] | undefined,
  options: QueryTuning & dex.FindPoolsOptions = {}
): UseQueryResult<dex.FoundPool[]> {
  const client = useLunya();
  return useQuery({
    queryKey: ["lunya", "findPools", client.deployment.chainId, tokens?.join(",")],
    enabled: Boolean(tokens && tokens.length > 1 && client.has("dex")) && options.enabled !== false,
    staleTime: options.staleTime ?? 60_000,
    queryFn: () => dex.findPools(client, [...tokens!], options),
  });
}

/**
 * Every initialized tick on a CL or CP pool, for pricing it yourself.
 *
 * Stale for thirty seconds by default: the distribution moves when positions
 * do, not on every trade — though a swap that fills limit orders takes their
 * ticks with it. Tune it to how closely you track the pool.
 */
export function useTicks(
  pool: Address | undefined,
  options: QueryTuning = {}
): UseQueryResult<dex.PopulatedTick[]> {
  const client = useLunya();
  return useQuery({
    queryKey: ["lunya", "ticks", client.deployment.chainId, pool],
    enabled: Boolean(pool) && options.enabled !== false,
    staleTime: options.staleTime ?? 30_000,
    ...(options.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
    queryFn: () => dex.getTicks(client, pool!),
  });
}

/** The fee the next swap would pay, and where that figure came from. See `dex.getCurrentFee`. */
export function useCurrentFee(
  pool: Address | undefined,
  options: QueryTuning = {}
): UseQueryResult<Awaited<ReturnType<typeof dex.getCurrentFee>>> {
  const client = useLunya();
  return useQuery({
    queryKey: ["lunya", "currentFee", client.deployment.chainId, pool],
    enabled: Boolean(pool) && options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 12_000,
    staleTime: options.staleTime ?? 0,
    queryFn: () => dex.getCurrentFee(client, pool!),
  });
}

/**
 * One owner's limit order in one batch: resting, filled with what claiming
 * pays, or none. The builders need no hook — call `dex.buildPlaceOrder` and the
 * rest from the click handler.
 */
export function useOrder(
  params: {
    plugin: Address | undefined;
    owner: Address | undefined;
    fillTick: number | undefined;
    sellingToken0: boolean | undefined;
    epoch: number | undefined;
  },
  options: QueryTuning = {}
): UseQueryResult<dex.Order> {
  const client = useLunya();
  const { plugin, owner, fillTick, sellingToken0, epoch } = params;
  const ready =
    plugin !== undefined &&
    owner !== undefined &&
    fillTick !== undefined &&
    sellingToken0 !== undefined &&
    epoch !== undefined;

  return useQuery({
    queryKey: ["lunya", "order", client.deployment.chainId, plugin, owner, fillTick, sellingToken0, epoch],
    enabled: ready && options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 12_000,
    queryFn: () =>
      dex.getOrder(client, {
        plugin: plugin!,
        owner: owner!,
        fillTick: fillTick!,
        sellingToken0: sellingToken0!,
        epoch: epoch!,
      }),
  });
}

/** A pool's state. Pass `poolType` if you know it, so a STABLE pool costs one round trip. */
export function usePoolState(
  pool: Address | undefined,
  options: QueryTuning & { poolType?: PoolType } = {}
): UseQueryResult<dex.PoolState> {
  const client = useLunya();
  return useQuery({
    queryKey: ["lunya", "poolState", client.deployment.chainId, pool],
    enabled: Boolean(pool) && options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 12_000,
    queryFn: () =>
      dex.getPoolState(client, pool!, options.poolType !== undefined ? { poolType: options.poolType } : {}),
  });
}

/**
 * The best exact-in quote.
 *
 * Refetched on an interval because a quote goes stale as soon as anyone else
 * trades, and a swap built from a stale one is a swap that reverts on its
 * minimum-out. Twelve seconds is roughly a block on most chains; tune it to
 * yours.
 *
 * `amountIn` is a bigint in the query key, and bigints do not serialise — the
 * key stringifies it. That is fine, and worth knowing if you build keys of your
 * own alongside these.
 */
export function useQuote(
  params: {
    tokenIn: Address | undefined;
    tokenOut: Address | undefined;
    amountIn: bigint | undefined;
  },
  options: QueryTuning & dex.QuoteOptions = {}
): UseQueryResult<Quote> {
  const client = useLunya();
  const { tokenIn, tokenOut, amountIn } = params;

  return useQuery({
    queryKey: [
      "lunya",
      "quote",
      client.deployment.chainId,
      tokenIn,
      tokenOut,
      amountIn?.toString(),
      options.directOnly ?? false,
    ],
    enabled:
      Boolean(tokenIn && tokenOut && amountIn && amountIn > 0n && client.has("dex")) &&
      options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 12_000,
    // Zero, deliberately: a quote is never "fresh enough" to reuse across a
    // remount, because the pool may have moved since.
    staleTime: options.staleTime ?? 0,
    // A quote that fails is usually a route with no liquidity, and retrying
    // three times just makes the empty state take four seconds to appear.
    retry: 0,
    queryFn: () => dex.getBestQuote(client, tokenIn!, tokenOut!, amountIn!, options),
  });
}

/** The cheapest exact-out quote: "what does it cost me to get exactly this much". */
export function useQuoteExactOut(
  params: {
    tokenIn: Address | undefined;
    tokenOut: Address | undefined;
    amountOut: bigint | undefined;
  },
  options: QueryTuning & dex.QuoteOptions = {}
): UseQueryResult<Quote> {
  const client = useLunya();
  const { tokenIn, tokenOut, amountOut } = params;

  return useQuery({
    queryKey: [
      "lunya",
      "quoteExactOut",
      client.deployment.chainId,
      tokenIn,
      tokenOut,
      amountOut?.toString(),
    ],
    enabled:
      Boolean(tokenIn && tokenOut && amountOut && amountOut > 0n && client.has("dex")) &&
      options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 12_000,
    staleTime: options.staleTime ?? 0,
    retry: 0,
    queryFn: () => dex.getBestQuoteExactOut(client, tokenIn!, tokenOut!, amountOut!, options),
  });
}

/*//////////////////////////////////////////////////////////////
                          Builders
//////////////////////////////////////////////////////////////*/

/**
 * Turn a quote into an unsigned swap.
 *
 * Not a hook and not async — it is a pure function of a quote you already have,
 * and making it a hook would only add a render cycle between "the user pressed
 * the button" and "the wallet opened". Call it in the click handler.
 */
export function useSwapBuilder() {
  const client = useLunya();
  return {
    exactIn: (quote: Quote, options: dex.SwapOptions): TransactionRequest =>
      dex.buildSwapFromQuote(client, quote, options),
    exactOut: (quote: Quote, options: dex.SwapOptions): TransactionRequest =>
      dex.buildSwapExactOutFromQuote(client, quote, options),
  };
}

export type { PoolType, Quote };
export type { UseQueryOptions };
