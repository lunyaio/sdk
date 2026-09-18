import type { Address } from "viem";

import { poolAbi } from "../generated/abis.js";
import type { LunyaClient } from "../client.js";
import { batched } from "../internal/multicall.js";
import { leafWordsUnderRoot, ticksInWord } from "../internal/ticks.js";

export type PopulatedTick = {
  tick: number;
  /** Liquidity added when the price crosses this tick upward, removed when it crosses downward. */
  liquidityNet: bigint;
  /** All position liquidity that uses this tick as a bound. */
  liquidityGross: bigint;
};

/**
 * Every initialized tick on a CL or CP pool, ascending: the liquidity
 * distribution an off-chain simulator walks.
 *
 * NOT UNISWAP V3'S INDEX. Ticks are stored raw, never divided by the spacing: a
 * bitmap word is `tick >> 8` and covers 256 ticks. Do not filter what comes back
 * by `tickSpacing` either — the spacing can change on a live pool, and positions
 * opened under the old one stay where they are and are still crossed.
 *
 * Public views only, in three batches pinned to ONE BLOCK, so a swap landing
 * between them cannot hand back a distribution that never existed: the tree's
 * root, every bitmap word under the parts of the tree the root marks as occupied
 * (up to 256 a part; most pools occupy one or two), then the ticks those words
 * hold. The layer between root and words has no getter, so the empty words
 * under an occupied part are read too — that is the cost of public views.
 *
 * A limit order is an ordinary position, so its ticks are here and a swap
 * crosses them like any other. A CP pool has at most two — the ends of the full
 * range, which no swap ever reaches — so it trades at constant `liquidity`. A
 * STABLE pool has no ticks and the call reverts.
 */
export async function getTicks(client: LunyaClient, pool: Address): Promise<PopulatedTick[]> {
  const blockNumber = await client.publicClient.getBlockNumber();

  const root = await client.publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "tickTreeRoot",
    blockNumber,
  });

  const words = leafWordsUnderRoot(Number(root));
  if (words.length === 0) return [];

  const bitmaps = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: false,
      blockNumber,
      contracts: words.map((word) => ({
        address: pool,
        abi: poolAbi,
        functionName: "tickBitmap" as const,
        args: [word] as const,
      })),
      ...extra,
    })
  );

  const ticks = words.flatMap((word, i) => ticksInWord(word, bitmaps[i] as bigint));
  if (ticks.length === 0) return [];

  const infos = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: false,
      blockNumber,
      contracts: ticks.map((tick) => ({
        address: pool,
        abi: poolAbi,
        functionName: "ticks" as const,
        args: [tick] as const,
      })),
      ...extra,
    })
  );

  return ticks.map((tick, i) => {
    const [liquidityGross, liquidityNet] = infos[i] as unknown as readonly [bigint, bigint];
    return { tick, liquidityNet, liquidityGross };
  });
}
