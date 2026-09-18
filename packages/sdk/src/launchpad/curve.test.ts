import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  costToComplete,
  price,
  progress,
  quoteBuy,
  quoteBuyWithNative,
  quoteSell,
  quoteSellForNative,
  snipeTaxBps,
} from "./curve.js";
import type { Launch } from "../types.js";

/**
 * The off-chain curve against the contract's arithmetic.
 *
 * These are not tests that the curve is a good curve. They are tests that THIS
 * implementation agrees with the launch's own quotes — including where each of
 * them rounds, and including the anti-snipe surcharge — because the whole value
 * of having the maths on this side is that a `minTokensOut` sized here survives
 * the contract's own recomputation. A discrepancy of one wei in the wrong
 * direction is a revert.
 *
 * The expected values are written out from the contract's formulas
 * independently below rather than copied from the implementation, so a change to
 * one does not silently update the other.
 */

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

const CURVE_SUPPLY = 793_100_000n * 10n ** 18n;
const VIRTUAL_TOKEN = 1_073_000_000n * 10n ** 18n;

/** Long after any window, so the surcharge is out of the way unless a test puts it back. */
const LATER = { now: 1_000_000n };

function launch(overrides: Partial<Launch> = {}): Launch {
  return {
    address: "0x0000000000000000000000000000000000000001",
    token: "0x0000000000000000000000000000000000000002",
    quoteToken: "0x0000000000000000000000000000000000000003",
    creator: "0x0000000000000000000000000000000000000004",
    phase: 1,
    virtualQuote: 10n ** 18n,
    virtualToken: VIRTUAL_TOKEN,
    curveSupply: CURVE_SUPPLY,
    lpSupply: 206_900_000n * 10n ** 18n,
    reserve: 0n,
    sold: 0n,
    curveFeeBps: 100,
    graduationFeeBps: 500,
    graduationReward: 10n ** 16n,
    // No surcharge unless a test opts in.
    snipeTaxBps: 0,
    snipeWindow: 0,
    snipeDecay: 1,
    openedAt: 1_000n,
    // Zero means the gas coin is not accepted; the native tests opt in.
    nativeDivisor: 0n,
    progress: 0,
    price: 0n,
    ...overrides,
  } as Launch;
}

/** A launch with its anti-snipe window open: 50% at the start, over 60 seconds, quadratic. */
const sniped = (overrides: Partial<Launch> = {}) =>
  launch({
    snipeTaxBps: 5_000,
    snipeWindow: 60,
    snipeDecay: 2,
    openedAt: 1_000n,
    reserve: 5n * 10n ** 17n,
    sold: 1_000_000n * 10n ** 18n,
    ...overrides,
  });

describe("quoteBuy", () => {
  test("matches the contract's formula on an ordinary buy", () => {
    const l = launch({ reserve: 5n * 10n ** 17n, sold: 1_000_000n * 10n ** 18n });
    const amountIn = 10n ** 17n;

    const x = l.virtualQuote + l.reserve;
    const y = l.virtualToken - l.sold;
    const fee = (amountIn * BigInt(l.curveFeeBps)) / BPS;
    const net = amountIn - fee;
    const expected = (y * net) / (x + net);

    const q = quoteBuy(l, amountIn, LATER);
    assert.equal(q.tokensOut, expected);
    assert.equal(q.fee, fee);
    assert.equal(q.refund, 0n, "an ordinary buy refunds nothing");
    assert.equal(q.snipeFee, 0n, "no surcharge outside the window");
  });

  test("fills partially and refunds when the buy would overrun the curve", () => {
    const l = launch({ reserve: 30n * 10n ** 18n, sold: CURVE_SUPPLY - 10n ** 18n });
    const q = quoteBuy(l, 1000n * 10n ** 18n, LATER);

    assert.equal(q.tokensOut, l.curveSupply - l.sold, "fills exactly the remainder");
    assert.ok(q.refund > 0n, "the overshoot comes back");
  });

  test("the refunding branch never charges a fee on the refund", () => {
    const l = launch({ reserve: 30n * 10n ** 18n, sold: CURVE_SUPPLY - 10n ** 18n });
    const amountIn = 1000n * 10n ** 18n;
    const q = quoteBuy(l, amountIn, LATER);

    const gross = amountIn - q.refund;
    const netRequired = gross - q.fee;
    assert.equal(gross, ceilDiv(netRequired * BPS, BPS - BigInt(l.curveFeeBps)));
  });

  test("answers zero for a launch that is not trading, rather than throwing", () => {
    for (const phase of [0, 2, 3] as const) {
      assert.deepEqual(quoteBuy(launch({ phase }), 10n ** 18n, LATER), {
        tokensOut: 0n,
        fee: 0n,
        refund: 0n,
        snipeFee: 0n,
      });
    }
  });
});

describe("the anti-snipe surcharge", () => {
  test("is the whole tax at the instant the launch opens", () => {
    assert.equal(snipeTaxBps(sniped(), { now: 1_000n }), 5_000);
  });

  test("decays as the contract's integer power", () => {
    // Fifteen seconds in: 5000 · 45² / 60² = 2812.5, truncated.
    assert.equal(snipeTaxBps(sniped(), { now: 1_015n }), 2_812);
  });

  test("is gone the second the window closes, and not a second before", () => {
    assert.equal(snipeTaxBps(sniped(), { now: 1_060n }), 0);
    assert.ok(snipeTaxBps(sniped(), { now: 1_059n }) > 0);
  });

  test("is never charged to an exempt recipient", () => {
    assert.equal(snipeTaxBps(sniped(), { now: 1_000n, exempt: true }), 0);
  });

  test("a clock behind the chain reads as the opening instant — the safe direction", () => {
    assert.equal(snipeTaxBps(sniped(), { now: 900n }), 5_000);
  });

  test("a zero window or a zero tax means there is none", () => {
    assert.equal(snipeTaxBps(sniped({ snipeWindow: 0 }), { now: 1_000n }), 0);
    assert.equal(snipeTaxBps(sniped({ snipeTaxBps: 0 }), { now: 1_000n }), 0);
  });

  test("is added to the curve fee, and snipeFee is its share of what the fee came to", () => {
    const l = sniped();
    const amountIn = 10n ** 17n;
    const q = quoteBuy(l, amountIn, { now: 1_000n });

    const feeBps = BigInt(l.curveFeeBps) + 5_000n;
    const fee = (amountIn * feeBps) / BPS;
    assert.equal(q.fee, fee);
    assert.equal(q.snipeFee, (fee * 5_000n) / feeBps);
  });

  test("makes a buy strictly worse inside the window, and changes nothing for the exempt", () => {
    const l = sniped();
    const amountIn = 10n ** 17n;
    const taxed = quoteBuy(l, amountIn, { now: 1_000n });
    const exempt = quoteBuy(l, amountIn, { now: 1_000n, exempt: true });

    assert.ok(taxed.tokensOut < exempt.tokensOut);
    assert.deepEqual(exempt, quoteBuy(l, amountIn, LATER), "exempt is the same as past the window");
  });

  test("the combined rate stops one basis point short of everything, and the surcharge gives way", () => {
    const l = sniped({ curveFeeBps: 100, snipeTaxBps: 9_950 });
    const amountIn = 10n ** 18n;
    const q = quoteBuy(l, amountIn, { now: 1_000n });

    // 100 + 9950 would be 10050. The contract caps the total at 9999 and takes
    // the difference out of the surcharge, which leaves it at 9899.
    assert.equal(q.fee, (amountIn * 9_999n) / BPS);
    assert.equal(q.snipeFee, (q.fee * 9_899n) / 9_999n);
  });
});

describe("quoteSell", () => {
  test("matches the contract's formula", () => {
    const l = launch({ reserve: 2n * 10n ** 18n, sold: 50_000_000n * 10n ** 18n });
    const tokensIn = 1_000_000n * 10n ** 18n;

    const x = l.virtualQuote + l.reserve;
    const y = l.virtualToken - l.sold;
    const gross = (x * tokensIn) / (y + tokensIn);
    const fee = (gross * BigInt(l.curveFeeBps)) / BPS;

    const q = quoteSell(l, tokensIn);
    assert.equal(q.fee, fee);
    assert.equal(q.amountOut, gross - fee);
  });

  test("is never surcharged, even inside the window", () => {
    const tokensIn = 10n ** 20n;
    assert.deepEqual(quoteSell(sniped(), tokensIn), quoteSell(sniped({ snipeTaxBps: 0 }), tokensIn));
  });

  test("never pays out more than the curve holds", () => {
    // A reserve far smaller than the position being sold: the rounding-dust
    // guard has to bind, or the curve would promise money it does not have.
    const l = launch({ reserve: 1000n, sold: 500_000_000n * 10n ** 18n });
    const q = quoteSell(l, 400_000_000n * 10n ** 18n);
    assert.ok(q.amountOut + q.fee <= l.reserve);
  });

  test("refuses to price a sale larger than what was ever bought", () => {
    const l = launch({ reserve: 10n ** 18n, sold: 100n });
    assert.deepEqual(quoteSell(l, 101n), { amountOut: 0n, fee: 0n });
  });
});

describe("round trips", () => {
  test("buying and immediately selling back loses exactly the two fees", () => {
    const l = launch({ reserve: 5n * 10n ** 18n, sold: 100_000_000n * 10n ** 18n });
    const amountIn = 10n ** 18n;

    const bought = quoteBuy(l, amountIn, LATER);
    const after = {
      ...l,
      reserve: l.reserve + (amountIn - bought.fee),
      sold: l.sold + bought.tokensOut,
    };
    const sold = quoteSell(after, bought.tokensOut);

    assert.ok(sold.amountOut < amountIn, "a round trip cannot be profitable");
    const lost = amountIn - sold.amountOut;
    assert.ok(lost >= bought.fee + sold.fee, "at least the two fees are lost");
    assert.ok(lost <= bought.fee + sold.fee + 4n, `lost ${lost}`);
  });
});

describe("paying with the gas coin", () => {
  /** A six-decimal quote token on an eighteen-decimal chain. */
  const DIVISOR = 10n ** 12n;

  test("is refused outright where the launch does not accept it", () => {
    assert.equal(quoteBuyWithNative(launch({ nativeDivisor: 0n }), 10n ** 18n, LATER), null);
    assert.equal(quoteSellForNative(launch({ nativeDivisor: 0n }), 10n ** 18n), null);
  });

  test("returns the dust below one quote unit, on top of the curve's own refund", () => {
    const l = launch({
      nativeDivisor: DIVISOR,
      reserve: 5n * 10n ** 17n,
      sold: 1_000_000n * 10n ** 18n,
    });
    // Deliberately not a whole multiple of the divisor.
    const nativeIn = 3n * DIVISOR + 777n;
    const q = quoteBuyWithNative(l, nativeIn, LATER)!;

    // The curve never sees the dust, so it cannot refund it — this is exactly
    // what makes the native quote non-composable from the quote-token one.
    assert.equal(q.nativeRefund % DIVISOR, 777n, "the truncated dust comes back");
    const { nativeRefund: _, ...curveHalf } = q;
    assert.deepEqual(curveHalf, quoteBuy(l, nativeIn / DIVISOR, LATER));
  });

  test("a whole multiple of the divisor leaves no dust", () => {
    const l = launch({ nativeDivisor: DIVISOR, reserve: 5n * 10n ** 17n, sold: 1n });
    const q = quoteBuyWithNative(l, 5n * DIVISOR, LATER)!;
    assert.equal(q.nativeRefund, q.refund * DIVISOR);
  });

  test("is surcharged like any other buy", () => {
    const q = quoteBuyWithNative(sniped({ nativeDivisor: DIVISOR }), 10n ** 30n, { now: 1_000n })!;
    assert.ok(q.snipeFee > 0n);
  });

  test("selling converts the payout up, and leaves the fee in quote units", () => {
    const l = launch({
      nativeDivisor: DIVISOR,
      reserve: 2n * 10n ** 18n,
      sold: 50_000_000n * 10n ** 18n,
    });
    const tokensIn = 1_000_000n * 10n ** 18n;
    const quoteSide = quoteSell(l, tokensIn);
    const nativeSide = quoteSellForNative(l, tokensIn)!;

    assert.equal(nativeSide.nativeOut, quoteSide.amountOut * DIVISOR);
    assert.equal(nativeSide.fee, quoteSide.fee);
  });
});

describe("costToComplete", () => {
  test("names an amount that actually completes the curve", () => {
    const l = launch({ reserve: 20n * 10n ** 18n, sold: CURVE_SUPPLY / 2n });
    const { tokensRemaining, amountIn } = costToComplete(l, LATER);

    assert.equal(tokensRemaining, CURVE_SUPPLY - l.sold);
    assert.equal(quoteBuy(l, amountIn, LATER).tokensOut, tokensRemaining);
  });

  test("still completes it with the surcharge in force", () => {
    const l = sniped({ reserve: 20n * 10n ** 18n, sold: CURVE_SUPPLY / 2n });
    const ctx = { now: 1_015n };
    const { tokensRemaining, amountIn } = costToComplete(l, ctx);

    assert.equal(quoteBuy(l, amountIn, ctx).tokensOut, tokensRemaining);
    assert.ok(amountIn > costToComplete(l, LATER).amountIn, "the surcharge costs more to finish");
  });

  test("is zero for a launch that is not trading", () => {
    assert.deepEqual(costToComplete(launch({ phase: 3 }), LATER), {
      tokensRemaining: 0n,
      amountIn: 0n,
    });
  });
});

describe("derived figures", () => {
  test("progress reaches 1 exactly when the curve is sold out", () => {
    assert.equal(progress(launch({ sold: 0n })), 0);
    assert.equal(progress(launch({ sold: CURVE_SUPPLY })), 1);
    assert.ok(Math.abs(progress(launch({ sold: CURVE_SUPPLY / 2n })) - 0.5) < 1e-6);
  });

  test("price rises as the curve is bought", () => {
    const early = price(launch({ sold: 0n, reserve: 0n }));
    const later = price(launch({ sold: 400_000_000n * 10n ** 18n, reserve: 20n * 10n ** 18n }));
    assert.ok(later > early);
  });
});
