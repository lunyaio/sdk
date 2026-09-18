import { encodeFunctionData, getAddress, maxUint256, parseSignature, type Address, type Hex } from "viem";

import { swapRouterAbi } from "../generated/abis.js";
import type { LunyaClient } from "../client.js";
import { InvalidArgumentError } from "../errors.js";
import { encodePath, reversePath } from "../internal/path.js";
import { NO_PRICE_LIMIT, defaultDeadline, minusSlippage, plusSlippage } from "../internal/math.js";
import { getBestQuote, getBestQuoteExactOut } from "./quote.js";
import type { Quote, SlippageOptions, TransactionRequest } from "../types.js";

/**
 * Execution.
 *
 * Every builder returns an unsigned `{ to, data, value }` plus the approvals it
 * needs, and sends nothing. See `TransactionRequest` for why.
 *
 * NEVER POINT A UNISWAP V3 ROUTER AT THESE POOLS. The callbacks are
 * `lunyaSwapCallback`, not `uniswapV3SwapCallback`, and the path encoding puts
 * a one-byte pool type where V3 puts a three-byte fee. The pools will not talk
 * to foreign periphery, which is the good outcome; a path built to the wrong
 * shape is the bad one, because it can decode into a different pool.
 */

export type SwapOptions = SlippageOptions & {
  sqrtPriceLimitX96?: bigint;
  /**
   * Pay with the native coin, wrapping on the way in.
   *
   * Only possible where the chain HAS a wrapper. Where it does not, the gas coin
   * and its ERC-20 are one balance seen at two decimal scales, and paying by
   * value would send the coin to a `receive` with nothing to convert it with.
   * Asking for it there is refused here rather than reverting on-chain.
   */
  fromNative?: boolean;
  /** Receive the native coin, unwrapping on the way out. Same constraint. */
  toNative?: boolean;
  /**
   * How much to approve, when the spend is an ERC-20.
   *
   * Defaults to exactly what the swap spends. Pass `maxUint256` for the
   * familiar infinite approval — it is not the default on purpose: it is the
   * standard convenience and also the standard way a later router bug drains a
   * wallet, and that is the caller's call to make, not ours.
   */
  approveAmount?: bigint;
  /**
   * A signed EIP-2612 permit for the spend, in place of an approval.
   *
   * Sign `buildPermitTypedData` with the ROUTER as spender and pass it here: the
   * swap then leads its batch with `selfPermitIfNecessary` and asks for no
   * approval — one transaction instead of two. Only for a token that supports
   * permits, and never with `fromNative`, which spends no ERC-20.
   *
   * `value` must cover what the swap can spend: `amountIn` exact-in, the
   * slippage-padded `amountInMaximum` exact-out.
   */
  permit?: { value: bigint; deadline: bigint; signature: Hex };
};

/*//////////////////////////////////////////////////////////////
                          Exact in
//////////////////////////////////////////////////////////////*/

/**
 * Build a swap from a quote you already have.
 *
 * Taking the quote rather than re-quoting is deliberate: the minimum-out is
 * derived from the number the caller SAW, so what they were shown and what they
 * signed cannot drift apart between the two calls.
 */
export function buildSwapFromQuote(
  client: LunyaClient,
  quote: Quote,
  options: SwapOptions
): TransactionRequest {
  const router = client.dexAddress("swapRouter");
  const first = quote.hops[0];
  const last = quote.hops[quote.hops.length - 1];
  if (!first || !last) throw new InvalidArgumentError("the quote carries no route");

  const { fromNative, toNative } = assertNativeSupported(client, options);
  const recipient = requireRecipient(client, options, toNative ? router : undefined);
  const deadline = options.deadline ?? defaultDeadline();
  const amountOutMinimum = minusSlippage(quote.amountOut, options.slippageBps);

  const calls: `0x${string}`[] = [];
  const permit = permitCall(first.tokenIn, quote.amountIn, fromNative, options);
  if (permit) calls.push(permit);

  if (quote.hops.length === 1) {
    calls.push(
      encodeFunctionData({
        abi: swapRouterAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: first.tokenIn,
            tokenOut: first.tokenOut,
            poolType: first.poolType,
            recipient,
            deadline,
            amountIn: quote.amountIn,
            amountOutMinimum,
            sqrtPriceLimitX96: options.sqrtPriceLimitX96 ?? NO_PRICE_LIMIT,
          },
        ],
      })
    );
  } else {
    calls.push(
      encodeFunctionData({
        abi: swapRouterAbi,
        functionName: "exactInput",
        args: [
          {
            path: quote.path ?? encodePath(quote.hops),
            recipient,
            deadline,
            amountIn: quote.amountIn,
            amountOutMinimum,
          },
        ],
      })
    );
  }

  // Unwrapping is a second call in the same multicall: the swap pays the ROUTER,
  // and the router then converts and forwards. Splitting it would leave wrapped
  // tokens sitting in the router for anyone to sweep.
  if (toNative) {
    calls.push(
      encodeFunctionData({
        abi: swapRouterAbi,
        functionName: "unwrapNative",
        args: [amountOutMinimum, options.recipient ?? recipient],
      })
    );
  }

  return {
    to: router,
    data: wrap(calls),
    value: fromNative ? quote.amountIn : 0n,
    approvals: fromNative || permit
      ? []
      : [
          {
            token: first.tokenIn,
            spender: router,
            amount: options.approveAmount ?? quote.amountIn,
          },
        ],
    description:
      `swap ${quote.amountIn} ${first.tokenIn} for at least ${amountOutMinimum} ${last.tokenOut} ` +
      `via ${quote.hops.length} hop(s)`,
  };
}

/** Quote and build in one go, for the common case. */
export async function buildSwap(
  client: LunyaClient,
  params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
  } & SwapOptions
): Promise<{ quote: Quote; transaction: TransactionRequest }> {
  const quote = await getBestQuote(client, params.tokenIn, params.tokenOut, params.amountIn, {
    ...(params.sqrtPriceLimitX96 !== undefined
      ? { sqrtPriceLimitX96: params.sqrtPriceLimitX96 }
      : {}),
  });
  return { quote, transaction: buildSwapFromQuote(client, quote, params) };
}

/*//////////////////////////////////////////////////////////////
                          Exact out
//////////////////////////////////////////////////////////////*/

export function buildSwapExactOutFromQuote(
  client: LunyaClient,
  quote: Quote,
  options: SwapOptions
): TransactionRequest {
  const router = client.dexAddress("swapRouter");
  const first = quote.hops[0];
  const last = quote.hops[quote.hops.length - 1];
  if (!first || !last) throw new InvalidArgumentError("the quote carries no route");

  const { fromNative, toNative } = assertNativeSupported(client, options);
  const recipient = requireRecipient(client, options, toNative ? router : undefined);
  const deadline = options.deadline ?? defaultDeadline();
  const amountInMaximum = plusSlippage(quote.amountIn, options.slippageBps);

  const calls: `0x${string}`[] = [];
  const permit = permitCall(first.tokenIn, amountInMaximum, fromNative, options);
  if (permit) calls.push(permit);

  if (quote.hops.length === 1) {
    calls.push(
      encodeFunctionData({
        abi: swapRouterAbi,
        functionName: "exactOutputSingle",
        args: [
          {
            tokenIn: first.tokenIn,
            tokenOut: first.tokenOut,
            poolType: first.poolType,
            recipient,
            deadline,
            amountOut: quote.amountOut,
            amountInMaximum,
            sqrtPriceLimitX96: options.sqrtPriceLimitX96 ?? NO_PRICE_LIMIT,
          },
        ],
      })
    );
  } else {
    calls.push(
      encodeFunctionData({
        abi: swapRouterAbi,
        functionName: "exactOutput",
        args: [
          {
            path: quote.path ?? encodePath(reversePath(quote.hops)),
            recipient,
            deadline,
            amountOut: quote.amountOut,
            amountInMaximum,
          },
        ],
      })
    );
  }

  if (toNative) {
    calls.push(
      encodeFunctionData({
        abi: swapRouterAbi,
        functionName: "unwrapNative",
        args: [quote.amountOut, options.recipient ?? recipient],
      })
    );
  }

  // An exact-output swap spends UP TO amountInMaximum and keeps the rest, so the
  // unspent native has to be asked back explicitly — otherwise it stays in the
  // router. Harmless on an ERC-20 spend, where nothing was sent by value.
  if (fromNative) {
    calls.push(encodeFunctionData({ abi: swapRouterAbi, functionName: "refundNative", args: [] }));
  }

  return {
    to: router,
    data: wrap(calls),
    value: fromNative ? amountInMaximum : 0n,
    approvals: fromNative || permit
      ? []
      : [
          {
            token: first.tokenIn,
            spender: router,
            amount: options.approveAmount ?? amountInMaximum,
          },
        ],
    description:
      `swap at most ${amountInMaximum} ${first.tokenIn} for exactly ${quote.amountOut} ${last.tokenOut}`,
  };
}

export async function buildSwapExactOut(
  client: LunyaClient,
  params: {
    tokenIn: Address;
    tokenOut: Address;
    amountOut: bigint;
  } & SwapOptions
): Promise<{ quote: Quote; transaction: TransactionRequest }> {
  const quote = await getBestQuoteExactOut(
    client,
    params.tokenIn,
    params.tokenOut,
    params.amountOut,
    {
      ...(params.sqrtPriceLimitX96 !== undefined
        ? { sqrtPriceLimitX96: params.sqrtPriceLimitX96 }
        : {}),
    }
  );
  return { quote, transaction: buildSwapExactOutFromQuote(client, quote, params) };
}

/*//////////////////////////////////////////////////////////////
                          Internals
//////////////////////////////////////////////////////////////*/

/**
 * `selfPermitIfNecessary` to lead the batch, where the caller signed a permit.
 *
 * The IfNecessary form, never the plain one. A signed permit is a public
 * message: if somebody else submits it first the nonce is spent, a plain
 * `selfPermit` then reverts, and it takes the swap behind it down too. With the
 * allowance already in place, this one skips instead.
 */
function permitCall(token: Address, spend: bigint, fromNative: boolean, options: SwapOptions): Hex | null {
  const permit = options.permit;
  if (!permit) return null;
  if (fromNative) {
    throw new InvalidArgumentError("a permit authorises an ERC-20 spend, and this swap pays with the native coin");
  }
  if (permit.value < spend) {
    throw new InvalidArgumentError(`the permit covers ${permit.value}, but the swap can spend ${spend}`);
  }
  const { r, s, v, yParity } = parseSignature(permit.signature);
  return encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "selfPermitIfNecessary",
    args: [token, permit.value, permit.deadline, v !== undefined ? Number(v) : (yParity ?? 0) + 27, r, s],
  });
}

/** One call goes out as itself; several go through the router's `multicall`. */
function wrap(calls: `0x${string}`[]): `0x${string}` {
  if (calls.length === 1) return calls[0]!;
  return encodeFunctionData({ abi: swapRouterAbi, functionName: "multicall", args: [calls] });
}

function assertNativeSupported(client: LunyaClient, options: SwapOptions) {
  const fromNative = Boolean(options.fromNative);
  const toNative = Boolean(options.toNative);
  if ((fromNative || toNative) && !client.deployment.native.hasWrapper) {
    throw new InvalidArgumentError(
      `${client.deployment.name} has no wrapper for ${client.deployment.native.symbol}: ` +
        `the gas coin and the ERC-20 are one balance seen at two decimal scales, so there is ` +
        `nothing to wrap. Trade the ERC-20 (${client.deployment.pairToken}) directly.`
    );
  }
  return { fromNative, toNative };
}

function requireRecipient(
  client: LunyaClient,
  options: SlippageOptions,
  override?: Address
): Address {
  if (override) return override;
  const recipient = options.recipient ?? client.walletClient?.account?.address;
  if (!recipient) {
    throw new InvalidArgumentError(
      "no recipient: pass `recipient`, or attach an account to the walletClient. " +
        "There is no sensible default — a swap whose output went somewhere the caller did not name is a bug."
    );
  }
  return getAddress(recipient);
}

export { maxUint256 };
