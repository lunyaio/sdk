import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { decodePath, encodePath, reversePath } from "./path.js";
import { PoolType, type Hop } from "../types.js";

/**
 * The encoding, tested hard, because it is the one place where being NEARLY
 * right about Uniswap is worse than knowing nothing.
 *
 * A V3 path is `token | fee(3 bytes) | token`. This one is
 * `token | poolType(1 byte) | token`. A V3-shaped path is not rejected by
 * arithmetic — it is 20 + n·23 bytes, which fails the length check here, but
 * the reason to test it is that the failure has to be LOUD and say why.
 */

const A = "0xAAaAaAaAAaaaAAaaAAAaAaaAAAaAaAAaAAaAaAAa" as const;
const B = "0xbBBbBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" as const;
const C = "0xCcCCccCcCCCcCCCCCcCcCccCcCCCcCcccccccCCC" as const;

describe("encodePath", () => {
  test("a single hop is token | type | token — 41 bytes", () => {
    const path = encodePath([{ tokenIn: A, tokenOut: B, poolType: PoolType.CL }]);
    assert.equal((path.length - 2) / 2, 41);
    assert.equal(path.toLowerCase(), `0x${A.slice(2)}00${B.slice(2)}`.toLowerCase());
  });

  test("the pool type is ONE byte, not three", () => {
    const path = encodePath([{ tokenIn: A, tokenOut: B, poolType: PoolType.STABLE }]);
    const middle = path.slice(2 + 40, 2 + 40 + 2);
    assert.equal(middle, "02");
    // The V3 mistake, spelled out: three bytes here would make it 43.
    assert.notEqual((path.length - 2) / 2, 43);
  });

  test("two hops share the middle token rather than repeating it", () => {
    const path = encodePath([
      { tokenIn: A, tokenOut: B, poolType: PoolType.CL },
      { tokenIn: B, tokenOut: C, poolType: PoolType.CP },
    ]);
    assert.equal((path.length - 2) / 2, 62, "20 + 21 + 21");
  });

  test("refuses a route that is not connected", () => {
    assert.throws(
      () =>
        encodePath([
          { tokenIn: A, tokenOut: B, poolType: PoolType.CL },
          { tokenIn: C, tokenOut: A, poolType: PoolType.CL },
        ]),
      /not connected/
    );
  });

  test("refuses an empty route", () => {
    assert.throws(() => encodePath([]), /at least one hop/);
  });
});

describe("decodePath", () => {
  test("round-trips every route it encodes", () => {
    const hops: Hop[] = [
      { tokenIn: A, tokenOut: B, poolType: PoolType.CL },
      { tokenIn: B, tokenOut: C, poolType: PoolType.STABLE },
    ];
    const decoded = decodePath(encodePath(hops));
    assert.equal(decoded.length, 2);
    assert.deepEqual(
      decoded.map((h) => [h.tokenIn.toLowerCase(), h.tokenOut.toLowerCase(), h.poolType]),
      hops.map((h) => [h.tokenIn.toLowerCase(), h.tokenOut.toLowerCase(), h.poolType])
    );
  });

  test("rejects a Uniswap V3 path, and says why", () => {
    // token | fee(3) | token — what every V3 integration builds.
    const v3 = `0x${A.slice(2)}000bb8${B.slice(2)}` as const;
    assert.equal((v3.length - 2) / 2, 43);
    assert.throws(() => decodePath(v3), /Uniswap V3 path/);
  });

  test("rejects a pool type that does not exist", () => {
    const bad = `0x${A.slice(2)}07${B.slice(2)}` as const;
    assert.throws(() => decodePath(bad), /pool type 7/);
  });

  test("rejects a bare token with no hop after it", () => {
    assert.throws(() => decodePath(`0x${A.slice(2)}`), /not 20 \+ n/);
  });
});

describe("reversePath", () => {
  test("an exact-output route is walked from the token being bought", () => {
    const forward: Hop[] = [
      { tokenIn: A, tokenOut: B, poolType: PoolType.CL },
      { tokenIn: B, tokenOut: C, poolType: PoolType.CP },
    ];
    const reversed = reversePath(forward);

    assert.equal(reversed[0]!.tokenIn.toLowerCase(), C.toLowerCase());
    assert.equal(reversed[reversed.length - 1]!.tokenOut.toLowerCase(), A.toLowerCase());
    // Still a connected route, so it still encodes.
    assert.doesNotThrow(() => encodePath(reversed));
  });

  test("reversing twice is the identity", () => {
    const forward: Hop[] = [
      { tokenIn: A, tokenOut: B, poolType: PoolType.CL },
      { tokenIn: B, tokenOut: C, poolType: PoolType.CP },
    ];
    assert.equal(encodePath(reversePath(reversePath(forward))), encodePath(forward));
  });
});
