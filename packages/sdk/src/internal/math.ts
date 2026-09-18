/**
 * The arithmetic quoting and swapping need, in exact integers.
 *
 * The slippage bounds are signed into transactions, so they are integer-only
 * and their rounding is deliberately asymmetric — a floor rounds down, a
 * ceiling rounds up — and both land in the caller's favour rather than against
 * the bound they set.
 *
 * The tick/sqrt-price pair is here for one job: turning a price you want to cap
 * at into the `sqrtPriceLimitX96` a swap takes. A bot bounding its own price
 * impact needs that; nothing else in quoting does, because `slot0` already
 * hands back the tick and the sqrt price together.
 *
 * There is no liquidity solve here. It existed for the position builders, which
 * are out of scope: this SDK covers quoting, swapping and the bonding curve.
 */

export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;

/** The widest range the tick math admits. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/**
 * No price limit — let the quote and the slippage guard do the work.
 *
 * Zero is the periphery's own sentinel for "unbounded": it substitutes the
 * relevant MIN/MAX sqrt price per direction, which a caller cannot do without
 * first knowing which of the two tokens sorted to token0.
 */
export const NO_PRICE_LIMIT = 0n;

/** √1.0001^tick · 2^96, exact, by the standard binary decomposition. */
export function sqrtRatioAtTick(tick: number): bigint {
  const t = Math.trunc(tick);
  if (t < MIN_TICK || t > MAX_TICK) throw new RangeError(`tick ${t} out of range`);
  const abs = BigInt(Math.abs(t));

  // Each constant is √1.0001^(2^i) in Q128, multiplied in only when that bit of
  // |tick| is set. The table is what makes this exact rather than a pow().
  let ratio =
    (abs & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (bit: bigint, k: bigint) => {
    if ((abs & bit) !== 0n) ratio = (ratio * k) >> 128n;
  };
  mul(0x2n, 0xfff97272373d413259a46990580e213an);
  mul(0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  mul(0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  mul(0x10n, 0xffcb9843d60f6159c9db58835c926644n);
  mul(0x20n, 0xff973b41fa98c081472e6896dfb254c0n);
  mul(0x40n, 0xff2ea16466c96a3843ec78b326b52861n);
  mul(0x80n, 0xfe5dee046a99a2a811c461f1969c3053n);
  mul(0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  mul(0x200n, 0xf987a7253ac413176f2b074cf7815e54n);
  mul(0x400n, 0xf3392b0822b70005940c7a398e4b70f3n);
  mul(0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  mul(0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  mul(0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  mul(0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n);
  mul(0x8000n, 0x31be135f97d08fd981231505542fcfa6n);
  mul(0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  mul(0x20000n, 0x5d6af8dedb81196699c329225ee604n);
  mul(0x40000n, 0x2216e584f5fa1ea926041bedfe98n);
  mul(0x80000n, 0x48a170391f7dc42444e8fa2n);

  // The table computes the reciprocal branch; a positive tick inverts it back.
  if (t > 0) ratio = (1n << 256n) / ratio;

  // Q128 → Q96, rounding up so the result never sits below the true ratio.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/**
 * The greatest tick whose ratio is at or below `sqrtPriceX96`.
 *
 * Found by bisection over `sqrtRatioAtTick` rather than by the log2
 * decomposition. Slower — twenty-odd iterations — and exactly as accurate,
 * which for a function called when a caller sets a price limit rather than
 * inside a hot loop is the right trade. The alternative is three hundred lines
 * whose only witness is itself.
 */
export function tickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) throw new RangeError("sqrtPriceX96 must be positive");
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sqrtRatioAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/*//////////////////////////////////////////////////////////////
                          Slippage
//////////////////////////////////////////////////////////////*/

/** `amount` less `bps` basis points, rounded down — a floor on what you accept. */
export function minusSlippage(amount: bigint, bps: number): bigint {
  assertBps(bps);
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/** `amount` plus `bps` basis points, rounded up — a ceiling on what you will pay. */
export function plusSlippage(amount: bigint, bps: number): bigint {
  assertBps(bps);
  const num = amount * BigInt(10_000 + bps);
  return num / 10_000n + (num % 10_000n === 0n ? 0n : 1n);
}

function assertBps(bps: number) {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw new RangeError(`slippageBps must be an integer in [0, 10000), got ${bps}`);
  }
}

/** Twenty minutes out, which is the convention every EVM periphery uses. */
export const defaultDeadline = (seconds = 1200): bigint =>
  BigInt(Math.floor(Date.now() / 1000) + seconds);
