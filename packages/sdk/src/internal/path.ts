import { getAddress, isAddress, type Address, type Hex } from "viem";

import { InvalidArgumentError } from "../errors.js";
import { PoolType, type Hop } from "../types.js";

/**
 * Route encoding, the way `Path.sol` reads it.
 *
 * `token(20) | poolType(1) | token(20) | poolType(1) | token(20) | …`
 *
 * NOT Uniswap's layout, where the middle field is a three-byte fee. This is the
 * single most likely thing for an integrator to get wrong, because the shape is
 * so nearly familiar: a V3-style path here is either rejected outright or — with
 * the wrong byte count — walks into a different pool than the one you priced.
 * Hence a module of its own, and hence `decodePath` right next to it, so a path
 * can be checked rather than trusted.
 */

const ADDRESS_BYTES = 20;
const POOL_TYPE_BYTES = 1;
const HOP_BYTES = ADDRESS_BYTES + POOL_TYPE_BYTES;

export function encodePath(hops: readonly Hop[]): Hex {
  if (hops.length === 0) throw new InvalidArgumentError("a path needs at least one hop");

  for (let i = 1; i < hops.length; i++) {
    const prev = hops[i - 1]!;
    const here = hops[i]!;
    // Compared as raw bytes, not through `getAddress`. A path IS bytes, and a
    // caller whose addresses came out of a database in the wrong case should
    // get a working path rather than a checksum lecture.
    if (prev.tokenOut.toLowerCase() !== here.tokenIn.toLowerCase()) {
      throw new InvalidArgumentError(
        `hop ${i} starts at ${here.tokenIn} but hop ${i - 1} ended at ${prev.tokenOut} — the route is not connected`
      );
    }
  }

  const byte = (v: number) => {
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new InvalidArgumentError(`pool type ${v} does not fit in one byte`);
    }
    return v.toString(16).padStart(2, "0");
  };

  return ("0x" +
    hops[0]!.tokenIn.slice(2) +
    hops.map((h) => byte(h.poolType) + h.tokenOut.slice(2)).join("")) as Hex;
}

/**
 * The reverse, for checking one you were handed.
 *
 * Worth having in an SDK rather than only in tests: an aggregator that builds
 * paths itself still wants to assert the bytes it produced mean what it thinks,
 * and the failure mode of getting this wrong is silent.
 */
export function decodePath(path: Hex): Hop[] {
  const body = path.startsWith("0x") ? path.slice(2) : path;
  if (body.length % 2 !== 0) throw new InvalidArgumentError("path is not whole bytes");

  const bytes = body.length / 2;
  if (bytes < ADDRESS_BYTES + HOP_BYTES || (bytes - ADDRESS_BYTES) % HOP_BYTES !== 0) {
    throw new InvalidArgumentError(
      `path is ${bytes} bytes, which is not 20 + n·21. ` +
        `A Uniswap V3 path (20 + n·23, with a 3-byte fee) will fail this check — the middle field here is a 1-byte pool type.`
    );
  }

  const at = (offset: number, length: number) => body.slice(offset * 2, (offset + length) * 2);
  const hops: Hop[] = [];
  let cursor = 0;
  let tokenIn = ("0x" + at(cursor, ADDRESS_BYTES)) as Address;
  cursor += ADDRESS_BYTES;

  while (cursor < bytes) {
    const poolType = Number.parseInt(at(cursor, POOL_TYPE_BYTES), 16);
    cursor += POOL_TYPE_BYTES;
    const tokenOut = ("0x" + at(cursor, ADDRESS_BYTES)) as Address;
    cursor += ADDRESS_BYTES;

    if (poolType !== PoolType.CL && poolType !== PoolType.CP && poolType !== PoolType.STABLE) {
      throw new InvalidArgumentError(`path names pool type ${poolType}, which does not exist`);
    }
    // `strict: false`: shape, not checksum. The bytes in a path carry no case
    // information to check against, so a strict test here rejects every path
    // that came off the wire — which is all of them.
    if (!isAddress(tokenIn, { strict: false }) || !isAddress(tokenOut, { strict: false })) {
      throw new InvalidArgumentError("path contains a malformed address");
    }

    hops.push({ tokenIn: normalise(tokenIn), tokenOut: normalise(tokenOut), poolType });
    tokenIn = tokenOut;
  }

  return hops;
}

/** Lowercase first, so an input in the wrong case checksums rather than throwing. */
const normalise = (address: Address): Address => getAddress(address.toLowerCase());

/**
 * The same route walked backwards, which is what `exactOutput` takes.
 *
 * The router and the quoter both reverse an exact-output path on purpose: a hop
 * only learns what it must produce once the hop after it has been priced, so
 * the walk starts at the end of the trade. Passing a forward path to
 * `exactOutput` is not an error the contract can detect — it just prices a
 * route nobody asked for.
 */
export function reversePath(hops: readonly Hop[]): Hop[] {
  return [...hops]
    .reverse()
    .map((h) => ({ tokenIn: h.tokenOut, tokenOut: h.tokenIn, poolType: h.poolType, pool: h.pool }));
}
