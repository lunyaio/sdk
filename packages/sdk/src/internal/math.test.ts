import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  MAX_TICK,
  MIN_TICK,
  Q96,
  minusSlippage,
  plusSlippage,
  sqrtRatioAtTick,
  tickAtSqrtRatio,
} from "./math.js";

/**
 * The arithmetic quoting and swapping rest on.
 *
 * The properties tested are the ones a wrong answer would violate SILENTLY.
 * Slippage rounding above all: a floor that rounded up, or a ceiling that
 * rounded down, does not throw — it reverts on-chain on some fraction of
 * trades, and looks like the market moving.
 */

describe("sqrtRatioAtTick", () => {
  test("tick 0 is exactly 1.0 in Q96", () => {
    assert.equal(sqrtRatioAtTick(0), Q96);
  });

  test("is strictly increasing", () => {
    let previous = 0n;
    for (const tick of [-887272, -100000, -1000, -1, 0, 1, 1000, 100000, 887272]) {
      const ratio = sqrtRatioAtTick(tick);
      assert.ok(ratio > previous, `tick ${tick} did not increase the ratio`);
      previous = ratio;
    }
  });

  test("one tick is one basis point of price, i.e. half of that in sqrt", () => {
    // √1.0001 ≈ 1.00005, so consecutive ticks differ by ~0.005% in sqrt space.
    const here = sqrtRatioAtTick(0);
    const next = sqrtRatioAtTick(1);
    const ratio = Number(next) / Number(here);
    assert.ok(Math.abs(ratio - Math.sqrt(1.0001)) < 1e-9, `got ${ratio}`);
  });

  test("refuses a tick outside the representable range", () => {
    assert.throws(() => sqrtRatioAtTick(MAX_TICK + 1), RangeError);
    assert.throws(() => sqrtRatioAtTick(MIN_TICK - 1), RangeError);
  });
});

describe("tickAtSqrtRatio", () => {
  test("inverts sqrtRatioAtTick exactly", () => {
    for (const tick of [-887272, -50000, -60, -1, 0, 1, 60, 50000, 887271]) {
      assert.equal(tickAtSqrtRatio(sqrtRatioAtTick(tick)), tick, `failed at ${tick}`);
    }
  });

  test("returns the tick BELOW a price sitting between two", () => {
    const between = (sqrtRatioAtTick(100) + sqrtRatioAtTick(101)) / 2n;
    assert.equal(tickAtSqrtRatio(between), 100);
  });
});

describe("slippage", () => {
  test("a floor rounds down and a ceiling rounds up", () => {
    // 333 at 1bp: the exact answers are 332.9667 and 333.0333.
    assert.equal(minusSlippage(333n, 1), 332n);
    assert.equal(plusSlippage(333n, 1), 334n);
  });

  test("zero tolerance is the identity", () => {
    assert.equal(minusSlippage(12345n, 0), 12345n);
    assert.equal(plusSlippage(12345n, 0), 12345n);
  });

  test("50 bps is half a percent", () => {
    assert.equal(minusSlippage(10_000n, 50), 9_950n);
    assert.equal(plusSlippage(10_000n, 50), 10_050n);
  });

  test("refuses a tolerance that is not a sane basis-point figure", () => {
    for (const bps of [-1, 10_000, 10_001, 1.5, NaN]) {
      assert.throws(() => minusSlippage(1n, bps), RangeError, `accepted ${bps}`);
    }
  });
});
