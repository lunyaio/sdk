import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { poolCreatedEvent } from "./discovery.js";

/**
 * The factory declares two events called `PoolCreated`: its own, and one with
 * Uniswap V3's exact signature for indexers built for V3 — which carries no fee,
 * squeezes the pool type into V3's `uint24` slot, and is off until governance
 * turns it on. Picking by name alone returns whichever sorts first, and that is
 * the compatibility one. This pins the choice to the protocol's own.
 */
describe("poolCreatedEvent", () => {
  test("is the protocol's own event, not the Uniswap-shaped compatibility one", () => {
    const { inputs } = poolCreatedEvent as unknown as {
      inputs: readonly { name: string; type: string }[];
    };

    assert.equal(
      inputs.find((i) => i.name === "poolType")?.type,
      "uint8",
      "the pool type is the enum, not squeezed into a uint24"
    );
    assert.ok(inputs.some((i) => i.name === "fee"), "it carries the fee");
    assert.ok(inputs.some((i) => i.name === "pool"), "it carries the pool");
  });
});
