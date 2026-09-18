"use client";

import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Address } from "viem";
import { launchpad, type Launch, type TransactionRequest } from "@lunya/sdk";
import { useWatchContractEvent, type UseWatchContractEventParameters } from "wagmi";

import { useLunya } from "./provider.js";

/**
 * Launchpad hooks.
 *
 * The one worth reading before using: `useCurveQuote` prices with the OFF-CHAIN
 * curve, synchronously, from a `Launch` you already hold. There is no query, no
 * loading state and no round trip, because there does not need to be — the
 * curve is closed-form and this SDK's implementation agrees with the contract's
 * to the wei. That is what makes a slider feel like a slider.
 *
 * Use `useContractQuote` when you are about to sign against state you have not
 * read this render.
 */

type QueryTuning = { enabled?: boolean; refetchInterval?: number | false; staleTime?: number };

/**
 * A launch, by its OWN address — not by the token it sells.
 *
 * The two are different contracts now: a launch is cloned per launch, and the
 * address you call is not the address you hold. `useLaunchByToken` is the hop
 * for a caller who only has the token.
 */
export function useLaunch(
  launch: Address | undefined,
  options: QueryTuning = {}
): UseQueryResult<Launch> {
  const client = useLunya();
  return useQuery({
    queryKey: ["lunya", "launch", client.deployment.chainId, launch],
    enabled: Boolean(launch && client.has("launchpad")) && options.enabled !== false,
    // A live curve moves on every trade; a couple of blocks is the right cadence
    // for a detail page and far too fast for a hundred-row board.
    refetchInterval: options.refetchInterval ?? 12_000,
    queryFn: () => launchpad.getLaunch(client, launch!),
  });
}

/**
 * Resolve a launch from the token it sells.
 *
 * One extra read against the factory. The mapping is permanent — a launch's
 * token never changes — so it is worth caching hard.
 */
export function useLaunchByToken(
  token: Address | undefined,
  options: QueryTuning = {}
): UseQueryResult<Launch | null> {
  const client = useLunya();
  return useQuery({
    queryKey: ["lunya", "launchByToken", client.deployment.chainId, token],
    enabled: Boolean(token && client.has("launchpad")) && options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 12_000,
    queryFn: () => launchpad.getLaunchByToken(client, token!),
  });
}

/** Several launches in one multicall. For a board, use this, not a loop of `useLaunch`. */
export function useLaunches(
  launches: Address[] | undefined,
  options: QueryTuning = {}
): UseQueryResult<Launch[]> {
  const client = useLunya();
  return useQuery({
    queryKey: ["lunya", "launches", client.deployment.chainId, launches?.join(",")],
    enabled: Boolean(launches?.length && client.has("launchpad")) && options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 30_000,
    queryFn: () => launchpad.getLaunches(client, launches!),
  });
}

/*//////////////////////////////////////////////////////////////
                          Quoting
//////////////////////////////////////////////////////////////*/

export type CurveQuote =
  /** `snipeFee` is the part of `fee` that is the anti-snipe surcharge. */
  | { side: "buy"; tokensOut: bigint; fee: bigint; refund: bigint; snipeFee: bigint }
  /** `amountOut` is in the launch's QUOTE TOKEN, not the gas coin. */
  | { side: "sell"; amountOut: bigint; fee: bigint };

/**
 * Price a trade against a launch you already have, without touching the network.
 *
 * Synchronous and memoised. The curve is exact arithmetic on state you are
 * already holding, so making this a query would add a spinner to a calculation
 * that takes a microsecond — and would put the answer a render behind the
 * input, which is exactly what makes an amount field feel broken.
 *
 * A BUY DEPENDS ON WHEN AND FOR WHOM while a launch's anti-snipe window is open.
 * `exempt` defaults to false, the figure anybody would pay. `now` defaults to
 * THIS DEVICE'S clock, which is close enough to show a number and not close
 * enough to sign against: a clock ahead of the chain previews a smaller
 * surcharge than the contract charges. Size a minimum from `useContractQuote`
 * with the `recipient`.
 */
export function useCurveQuote(
  launch: Launch | undefined,
  side: "buy" | "sell",
  amount: bigint | undefined,
  options: { exempt?: boolean; now?: bigint } = {}
): CurveQuote | null {
  const { exempt, now } = options;
  return useMemo(() => {
    if (!launch || !amount || amount <= 0n) return null;
    if (side === "buy") {
      const ctx = { now: now ?? BigInt(Math.floor(Date.now() / 1000)), exempt };
      const { tokensOut, fee, refund, snipeFee } = launchpad.curve.quoteBuy(launch, amount, ctx);
      return { side: "buy", tokensOut, fee, refund, snipeFee };
    }
    const { amountOut, fee } = launchpad.curve.quoteSell(launch, amount);
    return { side: "sell", amountOut, fee };
  }, [launch, side, amount, exempt, now]);
}

/**
 * The contract's own answer, for the moment before signing.
 *
 * Discriminated on `side` so the two shapes stay apart at the type level: a
 * buy has a refund and a sell does not, and collapsing them into one optional
 * field is how a caller ends up reading `refund` off a sell and getting
 * `undefined` where they expected zero.
 */
export type ContractQuote =
  | { side: "buy"; tokensOut: bigint; fee: bigint; refund: bigint }
  | { side: "sell"; amountOut: bigint; fee: bigint };

export function useContractQuote(
  params: {
    launch: Address | undefined;
    side: "buy" | "sell";
    amount: bigint | undefined;
    /**
     * Who receives a buy. Pass it: the anti-snipe surcharge is charged on the
     * recipient, and without one a buy is quoted for somebody who is not exempt —
     * the cautious figure, not this buyer's. A sell is never surcharged and
     * ignores it.
     */
    recipient?: Address;
  },
  options: QueryTuning = {}
): UseQueryResult<ContractQuote> {
  const client = useLunya();
  const { launch, side, amount } = params;
  const recipient = side === "buy" ? params.recipient : undefined;

  return useQuery({
    queryKey: [
      "lunya", "curveQuote", client.deployment.chainId, launch, side, amount?.toString(), recipient,
    ],
    enabled:
      Boolean(launch && amount && amount > 0n && client.has("launchpad")) &&
      options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 12_000,
    staleTime: 0,
    queryFn: async (): Promise<ContractQuote> =>
      side === "buy"
        ? {
            side: "buy",
            ...(await (recipient
              ? launchpad.quoteBuyFor(client, launch!, amount!, recipient)
              : launchpad.quoteBuy(client, launch!, amount!))),
          }
        : { side: "sell", ...(await launchpad.quoteSell(client, launch!, amount!)) },
  });
}

/**
 * The anti-snipe surcharge a buy for `recipient` pays right now, and whether the
 * recipient is exempt.
 *
 * Refetched every four seconds by default: a window lasts at most ten minutes
 * and the surcharge falls every second inside it, so the usual twelve would
 * show a figure a step behind for much of a short window. Once it reads zero it
 * stays zero — turn `refetchInterval` off then.
 */
export function useSnipeStatus(
  params: { launch: Address | undefined; recipient: Address | undefined },
  options: QueryTuning = {}
): UseQueryResult<{ taxBps: number; exempt: boolean }> {
  const client = useLunya();
  const { launch, recipient } = params;

  return useQuery({
    queryKey: ["lunya", "snipeStatus", client.deployment.chainId, launch, recipient],
    enabled: Boolean(launch && recipient && client.has("launchpad")) && options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 4_000,
    staleTime: 0,
    queryFn: async () => {
      const [taxBps, exempt] = await Promise.all([
        launchpad.currentSnipeTaxBps(client, launch!, recipient!),
        launchpad.isExempt(client, launch!, recipient!),
      ]);
      return { taxBps, exempt };
    },
  });
}

/*//////////////////////////////////////////////////////////////
                          Events
//////////////////////////////////////////////////////////////*/

// Hoisted, not written inline: wagmi re-subscribes whenever the ABI it is given
// is a new array, and an inline one is a new array every render.
const LAUNCH_CREATED = [launchpad.launchCreatedEvent] as const;
const TRADE = [launchpad.tradeEvent] as const;

type OnLaunches = UseWatchContractEventParameters<typeof LAUNCH_CREATED, "LaunchCreated">["onLogs"];
type OnTrades = UseWatchContractEventParameters<typeof TRADE, "Trade">["onLogs"];

/**
 * New launches, as the factory announces them.
 *
 * wagmi's `useWatchContractEvent` pointed at the factory, so it polls or
 * subscribes however your wagmi transport does. Each log's `args.launch` is
 * what you call and `args.token` what you hold.
 *
 * Pass a STABLE callback (`useCallback`): a new function every render is a new
 * subscription every render.
 */
export function useWatchLaunches(onLaunches: OnLaunches, options: { enabled?: boolean } = {}): void {
  const client = useLunya();
  const ready = client.has("launchpad");
  useWatchContractEvent({
    address: ready ? client.launchFactoryAddress() : undefined,
    abi: LAUNCH_CREATED,
    eventName: "LaunchCreated",
    enabled: ready && options.enabled !== false,
    onLogs: onLaunches,
  });
}

/**
 * Every buy and sell on the launches you name, as they land.
 *
 * `trader` is whose balance in the launched token moved — the recipient of a
 * buy, the seller of a sell — and `quoteAmount` the curve's reserve change in
 * quote-token units, whichever entry point paid. `reserve` and `sold` are the
 * curve after the trade, so a board can follow a launch without refetching it.
 *
 * Same caution as `useWatchLaunches`, and for `launches` too: memoise the array.
 */
export function useWatchTrades(
  launches: Address | readonly Address[] | undefined,
  onTrades: OnTrades,
  options: { enabled?: boolean } = {}
): void {
  const any = Array.isArray(launches) ? launches.length > 0 : Boolean(launches);
  useWatchContractEvent({
    address: launches as Address | Address[] | undefined,
    abi: TRADE,
    eventName: "Trade",
    enabled: any && options.enabled !== false,
    onLogs: onTrades,
  });
}

/*//////////////////////////////////////////////////////////////
                          Builders
//////////////////////////////////////////////////////////////*/

/**
 * The write builders, bound to the client. All synchronous; neither sends.
 *
 * Buy and sell, and nothing else. Launching and graduating are both out of the
 * SDK's scope — see `@lunya/sdk`'s launchpad module for the reasoning.
 */
export function useLaunchpadBuilder() {
  const client = useLunya();
  return {
    buy: (params: Parameters<typeof launchpad.buildBuy>[1]): TransactionRequest =>
      launchpad.buildBuy(client, params),
    buyWithNative: (params: Parameters<typeof launchpad.buildBuyWithNative>[1]): TransactionRequest =>
      launchpad.buildBuyWithNative(client, params),
    sell: (params: Parameters<typeof launchpad.buildSell>[1]): TransactionRequest =>
      launchpad.buildSell(client, params),
    sellForNative: (params: Parameters<typeof launchpad.buildSellForNative>[1]): TransactionRequest =>
      launchpad.buildSellForNative(client, params),
  };
}

export type { Launch };
