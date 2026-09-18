import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeFunctionData, keccak256, type Address } from "viem";

import { pluginAbi } from "../generated/abis.js";
import { sqrtRatioAtTick } from "../internal/math.js";
import { FeeToken, PoolType } from "../types.js";
import type { PoolState } from "./pools.js";
import { buildPlaceOrder, orderAmount, orderBatchKey, orderLiquidity, orderRange } from "./orders.js";

const PLUGIN: Address = "0x9999999999999999999999999999999999999999";
const MAX_UINT128 = (1n << 128n) - 1n;

const pool = (overrides: Partial<PoolState> = {}): PoolState => ({
  address: "0x1111111111111111111111111111111111111111",
  token0: "0x2222222222222222222222222222222222222222",
  token1: "0x3333333333333333333333333333333333333333",
  poolType: PoolType.CL,
  sqrtPriceX96: sqrtRatioAtTick(0),
  tick: 0,
  tickIsReal: true,
  fee: 3000,
  dynamicFee: true,
  liquidity: 10n ** 18n,
  tickSpacing: 60,
  feeProtocol0: 0,
  feeProtocol1: 0,
  feeToken: FeeToken.Paid,
  plugin: PLUGIN,
  // The default plugin's hooks: AFTER_SWAP among them.
  pluginConfig: 0x045e,
  stable: null,
  ...overrides,
});

describe("sizing an order", () => {
  test("the range is the spacing below the fill tick selling token0, above it selling token1", () => {
    assert.deepEqual(orderRange({ fillTick: 600, sellingToken0: true, tickSpacing: 60 }), {
      tickLower: 540,
      tickUpper: 600,
    });
    assert.deepEqual(orderRange({ fillTick: -600, sellingToken0: false, tickSpacing: 60 }), {
      tickLower: -600,
      tickUpper: -540,
    });
  });

  test("the liquidity an amount buys is the most it pays for — never over, never a unit short", () => {
    for (const fillTick of [-887160, -60000, -120, 120, 60000, 887160]) {
      for (const sellingToken0 of [true, false]) {
        for (const amount of [1n, 999n, 10n ** 6n, 10n ** 18n, 12_345_678_901_234_567_890n]) {
          const at = { fillTick, sellingToken0, tickSpacing: 60 };
          const liquidity = orderLiquidity({ ...at, amount });
          if (liquidity === MAX_UINT128) continue;
          assert.ok(orderAmount({ ...at, liquidity }) <= amount, `over at ${fillTick} ${sellingToken0} ${amount}`);
          assert.ok(orderAmount({ ...at, liquidity: liquidity + 1n }) > amount, `short at ${fillTick} ${sellingToken0} ${amount}`);
        }
      }
    }
  });

  test("any non-zero liquidity costs at least a wei, as the mint's rounding up guarantees", () => {
    assert.ok(orderAmount({ fillTick: 600, sellingToken0: true, tickSpacing: 60, liquidity: 1n }) >= 1n);
    assert.ok(orderAmount({ fillTick: 600, sellingToken0: false, tickSpacing: 60, liquidity: 1n }) >= 1n);
  });

  test("the batch key packs int24, bool and uint32 into eight bytes, as the plugin does", () => {
    // -60 as an int24 is 0xffffc4, true is 0x01, epoch 5 is 0x00000005.
    assert.equal(orderBatchKey({ fillTick: -60, sellingToken0: true, epoch: 5 }), keccak256("0xffffc40100000005"));
  });
});

describe("placing an order", () => {
  test("calls the plugin and approves it for exactly what the placement pulls", () => {
    const p = pool();
    const tx = buildPlaceOrder({ pool: p, fillTick: 600, sellingToken0: true, liquidity: 10n ** 18n });

    assert.equal(tx.to, PLUGIN);
    const call = decodeFunctionData({ abi: pluginAbi, data: tx.data });
    assert.equal(call.functionName, "placeOrder");
    assert.deepEqual(call.args, [600, true, 10n ** 18n]);
    assert.deepEqual(tx.approvals, [
      {
        token: p.token0,
        spender: PLUGIN,
        amount: orderAmount({ fillTick: 600, sellingToken0: true, tickSpacing: 60, liquidity: 10n ** 18n }),
      },
    ]);
  });

  test("selling token1 pays token1", () => {
    const p = pool();
    const tx = buildPlaceOrder({ pool: p, fillTick: -600, sellingToken0: false, liquidity: 10n ** 18n });
    assert.equal(tx.approvals?.[0]?.token, p.token1);
  });

  test("the price must clear the whole range, by the contract's own inequalities", () => {
    // Selling token0 needs tick < fillTick − spacing; at tick 0 a fill at 60 is one spacing too close.
    assert.throws(
      () => buildPlaceOrder({ pool: pool(), fillTick: 60, sellingToken0: true, liquidity: 1n }),
      /already at or past/
    );
    assert.doesNotThrow(() => buildPlaceOrder({ pool: pool(), fillTick: 120, sellingToken0: true, liquidity: 1n }));
    // Selling token1 needs tick ≥ fillTick + spacing; at tick 0 a fill at −60 is exactly enough.
    assert.doesNotThrow(() => buildPlaceOrder({ pool: pool(), fillTick: -60, sellingToken0: false, liquidity: 1n }));
    assert.throws(
      () => buildPlaceOrder({ pool: pool(), fillTick: 0, sellingToken0: false, liquidity: 1n }),
      /already at or past/
    );
  });

  test("refuses what the plugin would refuse, before anything is signed", () => {
    const place = (p: PoolState, fillTick = 600) =>
      buildPlaceOrder({ pool: p, fillTick, sellingToken0: true, liquidity: 1n });

    assert.throws(() => place(pool(), 630), /spacing/);
    assert.throws(() => place(pool({ poolType: PoolType.CP })), /CL pool/);
    assert.throws(() => place(pool({ poolType: PoolType.STABLE })), /CL pool/);
    assert.throws(() => place(pool({ plugin: null })), /no plugin/);
    assert.throws(() => place(pool({ pluginConfig: 0 })), /after swaps/);
    assert.throws(() => buildPlaceOrder({ pool: pool(), fillTick: 600, sellingToken0: true, liquidity: 0n }), /positive/);
  });
});
