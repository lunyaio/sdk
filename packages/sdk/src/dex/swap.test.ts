import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeFunctionData, type Address, type Hex } from "viem";

import { createLunyaClient } from "../client.js";
import { swapRouterAbi } from "../generated/abis.js";
import { PoolType, type Quote } from "../types.js";
import { buildSwapExactOutFromQuote, buildSwapFromQuote } from "./swap.js";

const ROUTER: Address = "0x1111111111111111111111111111111111111111";
const TOKEN_IN: Address = "0x2222222222222222222222222222222222222222";
const TOKEN_OUT: Address = "0x3333333333333333333333333333333333333333";
const RECIPIENT: Address = "0x4444444444444444444444444444444444444444";

const client = createLunyaClient({
  deployment: "testnet",
  addresses: {
    dex: {
      factory: "0x5555555555555555555555555555555555555555",
      poolDeployer: "0x6666666666666666666666666666666666666666",
      swapRouter: ROUTER,
      quoter: "0x7777777777777777777777777777777777777777",
    },
  },
});

const quote: Quote = {
  hops: [{ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, poolType: PoolType.CL }],
  amountIn: 1_000_000n,
  amountOut: 990_000n,
  feeAmount: 3000,
};

const r = `0x${"11".repeat(32)}` as Hex;
const s = `0x${"22".repeat(32)}` as Hex;
const signature = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;

const calls = (data: Hex) => {
  const outer = decodeFunctionData({ abi: swapRouterAbi, data });
  assert.equal(outer.functionName, "multicall");
  return (outer.args[0] as readonly Hex[]).map((call) => decodeFunctionData({ abi: swapRouterAbi, data: call }));
};

describe("a swap paid for by permit", () => {
  test("leads with selfPermitIfNecessary and asks for no approval", () => {
    const tx = buildSwapFromQuote(client, quote, {
      slippageBps: 50,
      recipient: RECIPIENT,
      permit: { value: quote.amountIn, deadline: 1_900_000_000n, signature },
    });

    const [permit, swap] = calls(tx.data);
    assert.equal(permit?.functionName, "selfPermitIfNecessary");
    assert.deepEqual(permit?.args, [TOKEN_IN, quote.amountIn, 1_900_000_000n, 27, r, s]);
    assert.equal(swap?.functionName, "exactInputSingle");
    assert.deepEqual(tx.approvals, []);
  });

  test("a permit that does not cover the spend is refused, not sent to revert", () => {
    assert.throws(
      () =>
        buildSwapFromQuote(client, quote, {
          slippageBps: 50,
          recipient: RECIPIENT,
          permit: { value: quote.amountIn - 1n, deadline: 1_900_000_000n, signature },
        }),
      /permit covers/
    );
  });

  test("exact-out has to cover the padded maximum, not the quoted input", () => {
    assert.throws(
      () =>
        buildSwapExactOutFromQuote(client, quote, {
          slippageBps: 50,
          recipient: RECIPIENT,
          permit: { value: quote.amountIn, deadline: 1_900_000_000n, signature },
        }),
      /permit covers/
    );
  });

  test("without a permit, the approval is still attached", () => {
    const tx = buildSwapFromQuote(client, quote, { slippageBps: 50, recipient: RECIPIENT });
    assert.deepEqual(tx.approvals, [{ token: TOKEN_IN, spender: ROUTER, amount: quote.amountIn }]);
  });
});
