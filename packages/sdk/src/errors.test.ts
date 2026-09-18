import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BaseError, encodeErrorResult, type Hex } from "viem";

import { abis } from "./generated/abis.js";
import { HINTS, decodeLunyaRevert } from "./errors.js";

/** A revert the way one reaches an integrator from deeper in the stack: raw bytes on a cause. */
const revertWith = (data: Hex) =>
  new BaseError("execution reverted", { cause: Object.assign(new Error("inner"), { data }) });

describe("revert decoding", () => {
  test("a STABLE pool's own error is named, not left as a selector", () => {
    // Declared by the STABLE pool and by nothing else shipped: before its ABI
    // was carried, a stable swap reverting here surfaced as four bare bytes.
    const data = encodeErrorResult({ abi: abis.stablePool, errorName: "InsufficientReserve" });
    const decoded = decodeLunyaRevert(revertWith(data));
    assert.equal(decoded?.name, "InsufficientReserve");
    assert.ok(decoded?.hint);
  });

  test("every hint names an error a shipped contract can throw", () => {
    const declared = new Set(
      Object.values(abis).flatMap((abi) =>
        (abi as readonly { type: string; name?: string }[])
          .filter((e) => e.type === "error")
          .map((e) => e.name)
      )
    );
    assert.deepEqual(
      Object.keys(HINTS).filter((name) => !declared.has(name)),
      []
    );
  });
});
