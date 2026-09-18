import { encodeFunctionData, type Address } from "viem";

import { launchAbi } from "../generated/abis.js";
import type { LunyaClient } from "../client.js";
import { InvalidArgumentError } from "../errors.js";
import { defaultDeadline, minusSlippage } from "../internal/math.js";
import type { TransactionRequest } from "../types.js";

/**
 * Trading on the curve.
 *
 * BUY AND SELL, AND NOTHING ELSE. Creating a launch and graduating one are both
 * out of scope: this package is for trading bots and aggregators, and neither of
 * those is trading. The contracts are permissionless and the ABI ships whole, so
 * this is not a barrier and does not pretend to be one — it is a statement about
 * what this package supports.
 *
 * CALLS GO TO THE LAUNCH, NOT TO A CENTRAL CONTRACT. Each launch is its own
 * contract, so `buy` takes no token argument: the contract you are calling is
 * the launch. Use `getLaunchByToken` if all you have is the token address.
 *
 * TWO WAYS IN, AND THEY ARE NOT INTERCHANGEABLE. The curve is priced and paid in
 * its QUOTE TOKEN; paying with the gas coin is a separate entry point that
 * exists only where the launch was set up for it. `buy` needs an ERC-20
 * approval and sends no value; `buyWithNative` sends value and needs no
 * approval. Picking the wrong one reverts.
 *
 * BOTH TAKE A RECIPIENT. Tokens can be delivered to somebody other than whoever
 * paid, and proceeds paid to somebody other than whoever sold — which is what
 * an aggregator routing on a user's behalf needs.
 */

/*
 * ANTI-SNIPE. For its first `snipeWindow` seconds a launch surcharges buys,
 * keyed on the RECIPIENT: the creator and anyone the creator listed are exempt.
 * Size a buy's minimum from `quoteBuyFor(recipient)`, not `quoteBuy`, which
 * assumes a recipient that is not exempt. Past the window the two agree, and
 * sells are never surcharged.
 */

export type TradeOptions = {
  /** Tolerance in basis points, applied to the quote. No default — you choose. */
  slippageBps: number;
  /** Unix seconds. Defaults to 20 minutes out. */
  deadline?: bigint;
  /** Who receives. Defaults to the wallet client's account. */
  recipient?: Address;
};

/*//////////////////////////////////////////////////////////////
                            Buying
//////////////////////////////////////////////////////////////*/

/**
 * Buy with the quote token.
 *
 * `expectedTokensOut` comes from a quote for THIS recipient — `quoteBuyFor`, or
 * the off-chain `curve.quoteBuy` with the recipient's exemption and the chain's
 * time — and the minimum is derived from it here, so what you were shown and
 * what you sign cannot drift apart. `quoteBuy` without a recipient is the
 * cautious figure while a launch's anti-snipe window is open; sized from it, an
 * exempt buyer's minimum is lower than it needs to be.
 *
 * A buy that would take more than the curve has left is FILLED PARTIALLY and the
 * overshoot refunded, rather than reverting. Size your minimum against the
 * quote's `tokensOut`, which already accounts for that.
 *
 * THE BUY THAT FILLS THE CURVE GRADUATES IT, in the same transaction: it opens
 * the pool, mints and locks the position, and pays the graduation reward to the
 * SENDER — the router, if a router sends it. Budget the gas for it.
 */
export function buildBuy(
  client: LunyaClient,
  params: TradeOptions & {
    /** The launch contract, not the token. */
    launch: Address;
    /** In quote-token units. */
    amountIn: bigint;
    expectedTokensOut: bigint;
    /** The launch's `quoteToken`, for the approval it needs. */
    quoteToken: Address;
  }
): TransactionRequest {
  if (params.amountIn <= 0n) throw new InvalidArgumentError("amountIn must be positive");

  return {
    to: params.launch,
    data: encodeFunctionData({
      abi: launchAbi,
      functionName: "buy",
      args: [
        params.amountIn,
        minusSlippage(params.expectedTokensOut, params.slippageBps),
        params.deadline ?? defaultDeadline(),
        requireRecipient(client, params),
      ],
    }),
    value: 0n,
    approvals: [
      { token: params.quoteToken, spender: params.launch, amount: params.amountIn },
    ],
    description: `buy from ${params.launch} with ${params.amountIn} of ${params.quoteToken}`,
  };
}

/**
 * Buy with the gas coin.
 *
 * Only where the launch accepts it — `nativeDivisor === 0n` means it does not,
 * and this reverts on-chain. No approval: the value rides on the call.
 *
 * Size `expectedTokensOut` with `curve.quoteBuyWithNative` or the contract's
 * `quoteBuyWithNative`, not by converting a quote-token quote: the conversion
 * truncates, and the dust below one whole quote unit is refunded rather than
 * spent.
 *
 * The launch's own `quoteBuyWithNative` answers for a recipient that is not
 * exempt, like `quoteBuy`, and there is no native `quoteBuyFor` — so for an
 * exempt recipient it is the cautious figure, and the buy delivers at least it.
 */
export function buildBuyWithNative(
  client: LunyaClient,
  params: TradeOptions & {
    launch: Address;
    /** In native units. */
    nativeIn: bigint;
    expectedTokensOut: bigint;
  }
): TransactionRequest {
  if (params.nativeIn <= 0n) throw new InvalidArgumentError("nativeIn must be positive");

  return {
    to: params.launch,
    data: encodeFunctionData({
      abi: launchAbi,
      functionName: "buyWithNative",
      args: [
        minusSlippage(params.expectedTokensOut, params.slippageBps),
        params.deadline ?? defaultDeadline(),
        requireRecipient(client, params),
      ],
    }),
    value: params.nativeIn,
    description: `buy from ${params.launch} with ${params.nativeIn} native`,
  };
}

/*//////////////////////////////////////////////////////////////
                            Selling
//////////////////////////////////////////////////////////////*/

/**
 * Sell back into the curve, paid in the quote token.
 *
 * Needs an ERC-20 approval on the LAUNCH TOKEN — the launch pulls it by
 * `transferFrom`. It is attached to the request; `client.sendAll` will send it,
 * or check what is actually outstanding with `pendingApprovals`.
 */
export function buildSell(
  client: LunyaClient,
  params: TradeOptions & {
    launch: Address;
    /** The token being sold — the launch's own `token`. */
    token: Address;
    tokensIn: bigint;
    expectedAmountOut: bigint;
  }
): TransactionRequest {
  if (params.tokensIn <= 0n) throw new InvalidArgumentError("tokensIn must be positive");

  return {
    to: params.launch,
    data: encodeFunctionData({
      abi: launchAbi,
      functionName: "sell",
      args: [
        params.tokensIn,
        minusSlippage(params.expectedAmountOut, params.slippageBps),
        params.deadline ?? defaultDeadline(),
        requireRecipient(client, params),
      ],
    }),
    value: 0n,
    approvals: [{ token: params.token, spender: params.launch, amount: params.tokensIn }],
    description: `sell ${params.tokensIn} into ${params.launch}`,
  };
}

/** Sell back into the curve, paid in the gas coin. Same approval, different payout. */
export function buildSellForNative(
  client: LunyaClient,
  params: TradeOptions & {
    launch: Address;
    token: Address;
    tokensIn: bigint;
    /** In native units. */
    expectedNativeOut: bigint;
  }
): TransactionRequest {
  if (params.tokensIn <= 0n) throw new InvalidArgumentError("tokensIn must be positive");

  return {
    to: params.launch,
    data: encodeFunctionData({
      abi: launchAbi,
      functionName: "sellForNative",
      args: [
        params.tokensIn,
        minusSlippage(params.expectedNativeOut, params.slippageBps),
        params.deadline ?? defaultDeadline(),
        requireRecipient(client, params),
      ],
    }),
    value: 0n,
    approvals: [{ token: params.token, spender: params.launch, amount: params.tokensIn }],
    description: `sell ${params.tokensIn} into ${params.launch} for native`,
  };
}

/*//////////////////////////////////////////////////////////////
                        On-chain quotes
//////////////////////////////////////////////////////////////*/

/**
 * The launch's own answer.
 *
 * Plain views, unlike the DEX's quoter — the curve is closed-form, so there is
 * nothing to simulate. Agrees with `curve.*` to the wei; use those when you
 * already hold the launch state, and these when you are about to sign against a
 * state you have not read.
 *
 * `quoteBuy` DOES NOT KNOW WHO THE TOKENS ARE FOR, so while the anti-snipe
 * window is open it answers for a recipient that is not exempt — the highest fee
 * anyone would pay. `quoteBuyFor` is exact.
 */
export async function quoteBuy(
  client: LunyaClient,
  launch: Address,
  amountIn: bigint
): Promise<{ tokensOut: bigint; fee: bigint; refund: bigint }> {
  const result = await client.publicClient.readContract({
    address: launch,
    abi: launchAbi,
    functionName: "quoteBuy",
    args: [amountIn],
  });
  const [tokensOut, fee, refund] = result as readonly [bigint, bigint, bigint];
  return { tokensOut, fee, refund };
}

/**
 * The exact quote for a buy delivered to `recipient`.
 *
 * The surcharge is on the recipient, so this is the quote to size a
 * `minTokensOut` from — and the one a router must use, since the recipient is not
 * the router. Past the anti-snipe window it agrees with `quoteBuy`.
 */
export async function quoteBuyFor(
  client: LunyaClient,
  launch: Address,
  amountIn: bigint,
  recipient: Address
): Promise<{ tokensOut: bigint; fee: bigint; refund: bigint }> {
  const result = await client.publicClient.readContract({
    address: launch,
    abi: launchAbi,
    functionName: "quoteBuyFor",
    args: [amountIn, recipient],
  });
  const [tokensOut, fee, refund] = result as readonly [bigint, bigint, bigint];
  return { tokensOut, fee, refund };
}

/**
 * The surcharge a buy for `recipient` would pay right now, in basis points.
 *
 * Zero past the window, and zero for the creator and anyone the creator listed.
 * "Right now" is the block the read lands in; from there the figure only falls.
 */
export async function currentSnipeTaxBps(
  client: LunyaClient,
  launch: Address,
  recipient: Address
): Promise<number> {
  const bps = await client.publicClient.readContract({
    address: launch,
    abi: launchAbi,
    functionName: "currentSnipeTaxBps",
    args: [recipient],
  });
  return Number(bps);
}

/** Whether `recipient` is exempt from this launch's anti-snipe surcharge. Fixed at creation. */
export async function isExempt(
  client: LunyaClient,
  launch: Address,
  recipient: Address
): Promise<boolean> {
  return client.publicClient.readContract({
    address: launch,
    abi: launchAbi,
    functionName: "isExempt",
    args: [recipient],
  });
}

export async function quoteBuyWithNative(
  client: LunyaClient,
  launch: Address,
  nativeIn: bigint
): Promise<{ tokensOut: bigint; fee: bigint; nativeRefund: bigint }> {
  const result = await client.publicClient.readContract({
    address: launch,
    abi: launchAbi,
    functionName: "quoteBuyWithNative",
    args: [nativeIn],
  });
  const [tokensOut, fee, nativeRefund] = result as readonly [bigint, bigint, bigint];
  return { tokensOut, fee, nativeRefund };
}

export async function quoteSell(
  client: LunyaClient,
  launch: Address,
  tokensIn: bigint
): Promise<{ amountOut: bigint; fee: bigint }> {
  const result = await client.publicClient.readContract({
    address: launch,
    abi: launchAbi,
    functionName: "quoteSell",
    args: [tokensIn],
  });
  const [amountOut, fee] = result as readonly [bigint, bigint];
  return { amountOut, fee };
}

export async function quoteSellForNative(
  client: LunyaClient,
  launch: Address,
  tokensIn: bigint
): Promise<{ nativeOut: bigint; fee: bigint }> {
  const result = await client.publicClient.readContract({
    address: launch,
    abi: launchAbi,
    functionName: "quoteSellForNative",
    args: [tokensIn],
  });
  const [nativeOut, fee] = result as readonly [bigint, bigint];
  return { nativeOut, fee };
}

/*//////////////////////////////////////////////////////////////
                          Internals
//////////////////////////////////////////////////////////////*/

function requireRecipient(client: LunyaClient, params: { recipient?: Address }): Address {
  const recipient = params.recipient ?? client.walletClient?.account?.address;
  if (!recipient) {
    throw new InvalidArgumentError(
      "no recipient: pass `recipient`, or attach an account to the walletClient. " +
        "There is no sensible default — tokens delivered somewhere the caller did not name is a bug."
    );
  }
  return recipient;
}
