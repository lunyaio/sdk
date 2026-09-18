import type { Launch } from "../types.js";

/**
 * The bonding curve, off-chain.
 *
 * A constant-product curve with virtual reserves: `x = virtualQuote + reserve`
 * against `y = virtualToken - sold`. The virtual halves are what give a launch a
 * sensible opening price with nothing in it yet.
 *
 * EVERY FUNCTION HERE MIRRORS THE CONTRACT EXACTLY, including the rounding —
 * `ceilDiv` where the contract ceils, truncation where it truncates. That is the
 * whole point: a quote computed here has to agree with the launch's own quote to
 * the wei, or a bot that sized its `minTokensOut` from this reverts against the
 * contract's answer.
 *
 * A BUY'S PRICE DEPENDS ON WHEN, AND FOR WHOM. For its first `snipeWindow`
 * seconds a launch adds a decaying surcharge to the fee, charged on the
 * recipient, and the creator and anyone the creator listed are exempt. So every
 * buy function here takes a `BuyContext`: the chain's time, and whether the
 * recipient is exempt. Sells are never surcharged and take neither.
 *
 * EVERYTHING HERE COUNTS IN THE QUOTE TOKEN. The gas coin is a separate entry
 * point on the contract and a separate pair of functions here; see
 * `quoteBuyWithNative` for why it cannot simply be composed.
 */

const BPS = 10_000n;
const WAD = 10n ** 18n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** The curve's two reserves at this instant, virtual halves included. */
export function reserves(
  launch: Pick<Launch, "virtualQuote" | "virtualToken" | "reserve" | "sold">
) {
  return {
    x: launch.virtualQuote + launch.reserve,
    y: launch.virtualToken - launch.sold,
  };
}

/*//////////////////////////////////////////////////////////////
                     The anti-snipe surcharge
//////////////////////////////////////////////////////////////*/

/** When a buy happens, and whether its recipient pays the surcharge. */
export type BuyContext = {
  /**
   * The chain's time in unix seconds — `block.timestamp`, NOT your clock.
   *
   * It only matters inside the window, and there it matters more in one
   * direction than the other: a clock AHEAD of the chain sees a smaller
   * surcharge than the contract will charge, quotes more tokens than the buy
   * delivers, and sizes a minimum that reverts. Read it off a block. Past the
   * window, any value at or after `openedAt + snipeWindow` gives the same answer.
   */
  now: bigint;
  /**
   * Whether the recipient is exempt. Defaults to false — the answer the
   * launch's own `quoteBuy` gives, because it does not know who the tokens are
   * for. `launchpad.isExempt` asks the chain; the creator always is.
   */
  exempt?: boolean;
};

type SnipeState = Pick<Launch, "snipeTaxBps" | "snipeWindow" | "snipeDecay" | "openedAt">;

/**
 * The surcharge a buy pays at `ctx.now`, in basis points.
 *
 * `tax · (window − elapsed)^decay / window^decay`, in integers and nothing else,
 * as the contract computes it: steep at the start, flat by the end, zero once
 * the window has closed.
 *
 * A `now` earlier than `openedAt` cannot happen on-chain. Off-chain it is a
 * clock behind the chain, and it reads as the opening instant — the highest
 * surcharge, which is the direction that cannot make a minimum revert.
 */
export function snipeTaxBps(launch: SnipeState, ctx: BuyContext): number {
  const window = BigInt(launch.snipeWindow);
  const tax = BigInt(launch.snipeTaxBps);
  if (window === 0n || tax === 0n) return 0;

  const elapsed = ctx.now > launch.openedAt ? ctx.now - launch.openedAt : 0n;
  if (elapsed >= window) return 0;
  if (ctx.exempt) return 0;

  const remaining = window - elapsed;
  const decay = BigInt(launch.snipeDecay);
  return Number((tax * remaining ** decay) / window ** decay);
}

/**
 * The single rate a buy pays: the curve fee plus the surcharge, capped one basis
 * point short of everything.
 *
 * The contract adds the two into one rate for the arithmetic and separates them
 * only where the money is booked. This mirrors that — including which of the
 * two gives way at the cap: the surcharge does.
 */
function buyFeeBps(launch: Pick<Launch, "curveFeeBps"> & SnipeState, ctx: BuyContext) {
  const curveFee = BigInt(launch.curveFeeBps);
  let snipeBps = BigInt(snipeTaxBps(launch, ctx));
  let feeBps = curveFee + snipeBps;
  if (feeBps >= BPS) {
    feeBps = BPS - 1n;
    snipeBps = feeBps - curveFee;
  }
  return { feeBps, snipeBps };
}

/*//////////////////////////////////////////////////////////////
                              Buying
//////////////////////////////////////////////////////////////*/

export type BuyQuote = {
  tokensOut: bigint;
  /** Everything charged, surcharge included. */
  fee: bigint;
  /**
   * Non-zero only when the buy COMPLETES the curve.
   *
   * A buy that would take more than the curve has left is filled partially and
   * the overshoot handed back — it does not revert. A caller that assumed
   * otherwise sizes its slippage against an amount it will not spend.
   */
  refund: bigint;
  /** The part of `fee` that is the anti-snipe surcharge. Zero outside the window. */
  snipeFee: bigint;
};

type BuyState = Pick<
  Launch,
  "virtualQuote" | "virtualToken" | "reserve" | "sold" | "curveSupply" | "curveFeeBps" | "phase"
> &
  SnipeState;

/**
 * What `amountIn` of the QUOTE TOKEN buys.
 *
 * THE BUY THAT FILLS THE CURVE ALSO GRADUATES IT, in the same transaction: it
 * opens the pool, mints and locks the position, and pays the graduation reward
 * to whoever SENT it. This quote is still exact for the tokens and the refund;
 * the gas is not the gas of an ordinary buy.
 */
export function quoteBuy(launch: BuyState, amountIn: bigint, ctx: BuyContext): BuyQuote {
  // Matches the contract, which answers zero rather than reverting for a launch
  // that is not trading — so a screen showing many launches does not have to
  // branch on phase before it can price one.
  if (launch.phase !== 1 || amountIn <= 0n) {
    return { tokensOut: 0n, fee: 0n, refund: 0n, snipeFee: 0n };
  }

  const { x, y } = reserves(launch);
  const remaining = launch.curveSupply - launch.sold;
  const { feeBps, snipeBps } = buyFeeBps(launch, ctx);

  let fee = (amountIn * feeBps) / BPS;
  const net = amountIn - fee;
  let tokensOut = (y * net) / (x + net);
  let refund = 0n;

  if (tokensOut >= remaining) {
    tokensOut = remaining;
    let netRequired = ceilDiv(x * remaining, y - remaining);
    if (netRequired > net) netRequired = net;
    let gross = ceilDiv(netRequired * BPS, BPS - feeBps);
    if (gross > amountIn) gross = amountIn;
    fee = gross - netRequired;
    refund = amountIn - gross;
  }

  // A proportion of whatever the fee came to, so the two stay in step through
  // the completion branch's rounding as well as the ordinary one.
  const snipeFee = snipeBps !== 0n && feeBps !== 0n ? (fee * snipeBps) / feeBps : 0n;
  return { tokensOut, fee, refund, snipeFee };
}

/*//////////////////////////////////////////////////////////////
                              Selling
//////////////////////////////////////////////////////////////*/

export type SellQuote = { amountOut: bigint; fee: bigint };

type SellState = Pick<
  Launch,
  "virtualQuote" | "virtualToken" | "reserve" | "sold" | "curveFeeBps" | "phase"
>;

/** What selling `tokensIn` returns, in the QUOTE TOKEN. Sells are never surcharged. */
export function quoteSell(launch: SellState, tokensIn: bigint): SellQuote {
  // More than has been sold is more than anybody can hold: the contract answers
  // zero rather than a number the trade could not honour, and the sell reverts.
  if (launch.phase !== 1 || tokensIn <= 0n || tokensIn > launch.sold) {
    return { amountOut: 0n, fee: 0n };
  }

  const { x, y } = reserves(launch);
  let gross = (x * tokensIn) / (y + tokensIn);
  // The rounding-dust guard the contract applies: the curve can never pay out
  // more than it holds, whatever the arithmetic says.
  if (gross > launch.reserve) gross = launch.reserve;
  const fee = (gross * BigInt(launch.curveFeeBps)) / BPS;
  return { amountOut: gross - fee, fee };
}

/*//////////////////////////////////////////////////////////////
                     Paying with the gas coin
//////////////////////////////////////////////////////////////*/

export type NativeBuyQuote = BuyQuote & {
  /** In NATIVE units: the curve's refund converted back, plus the truncated dust. */
  nativeRefund: bigint;
};

/**
 * What `nativeIn` of the gas coin buys.
 *
 * NOT COMPOSABLE FROM `quoteBuy`, and the contract says so in the same words:
 * the conversion truncates, and what falls below one whole unit of the quote
 * token is never spent. It comes back — in the unit it arrived in — on top of
 * whatever the curve itself refunds. Multiplying a quote-token refund by the
 * divisor and stopping there loses that dust silently.
 *
 * Returns null where the launch does not take the gas coin at all, which is
 * what `nativeDivisor === 0n` means. The contract reverts there; answering null
 * lets a caller check without a try/catch.
 */
export function quoteBuyWithNative(
  launch: BuyState & Pick<Launch, "nativeDivisor">,
  nativeIn: bigint,
  ctx: BuyContext
): NativeBuyQuote | null {
  if (launch.nativeDivisor === 0n) return null;

  const amountIn = nativeIn / launch.nativeDivisor;
  const dust = nativeIn - amountIn * launch.nativeDivisor;

  const quote = quoteBuy(launch, amountIn, ctx);
  return { ...quote, nativeRefund: quote.refund * launch.nativeDivisor + dust };
}

/** What selling `tokensIn` returns in the gas coin. Null where it is not accepted. */
export function quoteSellForNative(
  launch: SellState & Pick<Launch, "nativeDivisor">,
  tokensIn: bigint
): { nativeOut: bigint; fee: bigint } | null {
  if (launch.nativeDivisor === 0n) return null;
  const { amountOut, fee } = quoteSell(launch, tokensIn);
  return { nativeOut: amountOut * launch.nativeDivisor, fee };
}

/*//////////////////////////////////////////////////////////////
                        Derived figures
//////////////////////////////////////////////////////////////*/

/** Spot price, in quote-token units per whole (1e18) token. */
export function price(
  launch: Pick<Launch, "virtualQuote" | "virtualToken" | "reserve" | "sold">
): bigint {
  const { x, y } = reserves(launch);
  if (y === 0n) return 0n;
  return (x * WAD) / y;
}

/** How far along the curve is, 0..1. Reaching 1 is the buy that graduates it. */
export function progress(launch: Pick<Launch, "sold" | "curveSupply">): number {
  if (launch.curveSupply === 0n) return 0;
  // Through a fixed scale rather than Number(bigint) on both halves: the
  // supplies are 1e26-ish and dividing two lossy doubles compounds the loss.
  return Number((launch.sold * 1_000_000n) / launch.curveSupply) / 1_000_000;
}

/**
 * What is still buyable, and what it would cost, before the curve completes.
 *
 * The inverse of `quoteBuy` at the boundary: "what would it cost me to take the
 * rest of this curve" — and so also the largest buy worth sizing, since anything
 * more is refunded. Grossed up through the SAME combined rate a buy pays, so
 * inside the anti-snipe window it depends on `ctx` exactly as `quoteBuy` does.
 */
export function costToComplete(
  launch: BuyState,
  ctx: BuyContext
): { tokensRemaining: bigint; amountIn: bigint } {
  const tokensRemaining = launch.curveSupply - launch.sold;
  if (launch.phase !== 1 || tokensRemaining <= 0n) return { tokensRemaining: 0n, amountIn: 0n };

  const { x, y } = reserves(launch);
  const { feeBps } = buyFeeBps(launch, ctx);
  const netRequired = ceilDiv(x * tokensRemaining, y - tokensRemaining);
  // Grossed back up through the fee, the way the contract derives it, so the
  // figure is what you send rather than what the curve receives.
  const amountIn = ceilDiv(netRequired * BPS, BPS - feeBps);
  return { tokensRemaining, amountIn };
}
