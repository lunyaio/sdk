import { encodeFunctionData, encodePacked, keccak256, type Address, type Hex } from "viem";

import { pluginAbi } from "../generated/abis.js";
import type { LunyaClient } from "../client.js";
import { InvalidArgumentError } from "../errors.js";
import { eventNamed } from "../internal/events.js";
import { Q96, sqrtRatioAtTick } from "../internal/math.js";
import { batched } from "../internal/multicall.js";
import { PoolType, poolTypeLabel, type TransactionRequest } from "../types.js";
import type { PoolState } from "./pools.js";

/**
 * Limit orders.
 *
 * AN ORDER IS A POSITION ONE TICK-SPACING WIDE, resting entirely beyond the
 * price and held by the pool's PLUGIN. When a swap carries the price through
 * it, the liquidity converts; after the swap the plugin burns it and escrows
 * what came out for everyone in that batch, and each placer claims their share.
 * A batch the settlement has not reached yet — each swap settles a bounded
 * number — goes back to waiting if the price retreats first. Once settled, a
 * fill is final.
 *
 * WHERE: the pool's plugin, `PoolState.plugin`, one per pool. The router and
 * the position manager know nothing about orders.
 *
 * THE OWNER IS WHOEVER SENDS. There is no recipient: an order placed by a
 * contract belongs to that contract, and only it can cancel or claim.
 *
 * SIZED IN LIQUIDITY, NOT TOKENS. `orderAmount` turns liquidity into what a
 * placement pulls, and `orderLiquidity` goes the other way. Selling token0 pays
 * token0 and fills into token1; selling token1 pays token1 and fills into token0.
 *
 * BATCHED BY EPOCH. Every order at one tick and side rests in one batch; a fill
 * settles the batch whole and opens the next epoch. An order is identified by
 * owner, tick, side and EPOCH — and no event carries the epoch on placement, so
 * read it with `getOrderBatch` when you place.
 *
 * NO SWAP FEES FOR THE PLACER. What a batch earns while it is crossed is left
 * to the protocol; a claim pays the converted principal, pro rata, rounded down.
 *
 * CL POOLS ONLY. A CP pool holds only the full range and a STABLE pool has no
 * ticks, and the plugin refuses both.
 */

/** The `pluginConfig` bit that lets a plugin see swaps. Without it nothing ever fills. */
const AFTER_SWAP = 1 << 3;

const MAX_UINT128 = (1n << 128n) - 1n;

type OrderAt = {
  fillTick: number;
  /** True to sell token0 for token1, which fills as the price RISES to `fillTick`. */
  sellingToken0: boolean;
};

/*//////////////////////////////////////////////////////////////
                          Sizing
//////////////////////////////////////////////////////////////*/

/**
 * The range an order at `fillTick` occupies: the spacing below it when selling
 * token0, the spacing above it when selling token1.
 */
export function orderRange(
  params: OrderAt & { tickSpacing: number }
): { tickLower: number; tickUpper: number } {
  const { fillTick, sellingToken0, tickSpacing } = params;
  return sellingToken0
    ? { tickLower: fillTick - tickSpacing, tickUpper: fillTick }
    : { tickLower: fillTick, tickUpper: fillTick + tickSpacing };
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * What placing `liquidity` pulls: token0 when selling token0, token1 when
 * selling token1.
 *
 * Rounded up, exactly as the pool's mint rounds — so this is the approval to
 * give and the balance to hold.
 */
export function orderAmount(params: OrderAt & { tickSpacing: number; liquidity: bigint }): bigint {
  const { tickLower, tickUpper } = orderRange(params);
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  const liquidity = params.liquidity;
  return params.sellingToken0
    ? ceilDiv(ceilDiv((liquidity << 96n) * (sqrtB - sqrtA), sqrtB), sqrtA)
    : ceilDiv(liquidity * (sqrtB - sqrtA), Q96);
}

/**
 * The most liquidity `amount` of the token being sold can place.
 *
 * The exact inverse of `orderAmount`, not an approximation: `orderAmount` of the
 * answer is at most `amount`, and of one more is above it. Capped at uint128,
 * which is what the contract takes.
 */
export function orderLiquidity(params: OrderAt & { tickSpacing: number; amount: bigint }): bigint {
  if (params.amount <= 0n) return 0n;
  const { tickLower, tickUpper } = orderRange(params);
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  // Both rounding steps in `orderAmount` are ceilings, and a ceiling is at most
  // n exactly when what it rounds is at most n — so the bound on liquidity is
  // the unrounded one, floored once.
  const liquidity = params.sellingToken0
    ? (params.amount * sqrtA * sqrtB) / (Q96 * (sqrtB - sqrtA))
    : (params.amount * Q96) / (sqrtB - sqrtA);
  return liquidity > MAX_UINT128 ? MAX_UINT128 : liquidity;
}

/*//////////////////////////////////////////////////////////////
                          Builders
//////////////////////////////////////////////////////////////*/

/**
 * Place an order.
 *
 * Takes the pool as `getPoolState` read it — its plugin, tokens, spacing and
 * price — and checks here what the contract would refuse: a pool that cannot
 * hold orders, a tick off the spacing, a price already at or past the fill
 * tick. Checked against the state you READ, so a price that moves between the
 * read and the send can still revert.
 *
 * Carries one approval: the token being sold, to the PLUGIN, for exactly what
 * the placement pulls.
 */
export function buildPlaceOrder(
  params: OrderAt & {
    pool: PoolState;
    liquidity: bigint;
  }
): TransactionRequest {
  const { pool, fillTick, sellingToken0, liquidity } = params;
  const plugin = requireOrderPlugin(pool);

  if (liquidity <= 0n) throw new InvalidArgumentError("liquidity must be positive");
  if (liquidity > MAX_UINT128) throw new InvalidArgumentError("liquidity does not fit a uint128");
  if (fillTick % pool.tickSpacing !== 0) {
    throw new InvalidArgumentError(`fillTick ${fillTick} is not on the pool's tick spacing of ${pool.tickSpacing}`);
  }

  // The contract's own precondition: the whole range beyond the price, or the
  // order would open half-converted and fill at once at a worse price.
  const beyond = sellingToken0
    ? pool.tick < fillTick - pool.tickSpacing
    : pool.tick >= fillTick + pool.tickSpacing;
  if (!beyond) {
    throw new InvalidArgumentError(
      `the price (tick ${pool.tick}) is already at or past ${fillTick} for an order selling ` +
        `token${sellingToken0 ? 0 : 1}: it would fill at once, at a worse price than asked`
    );
  }

  const amount = orderAmount({ fillTick, sellingToken0, tickSpacing: pool.tickSpacing, liquidity });
  const token = sellingToken0 ? pool.token0 : pool.token1;

  return {
    to: plugin,
    data: encodeFunctionData({
      abi: pluginAbi,
      functionName: "placeOrder",
      args: [fillTick, sellingToken0, liquidity],
    }),
    value: 0n,
    approvals: [{ token, spender: plugin, amount }],
    description: `rest ${amount} of ${token} at tick ${fillTick} on ${pool.address}`,
  };
}

/**
 * Take liquidity back out of an order that has not filled.
 *
 * Only from the OPEN batch: once a batch settles its epoch moves on, and a
 * filled order is claimed, not cancelled. Pays back whatever the burn returns at
 * the current price — the original token if the price never reached the range,
 * a mix if it sits inside it.
 */
export function buildCancelOrder(
  params: OrderAt & { plugin: Address; liquidity: bigint }
): TransactionRequest {
  if (params.liquidity <= 0n) throw new InvalidArgumentError("liquidity must be positive");
  return {
    to: params.plugin,
    data: encodeFunctionData({
      abi: pluginAbi,
      functionName: "cancelOrder",
      args: [params.fillTick, params.sellingToken0, params.liquidity],
    }),
    value: 0n,
    description: `cancel ${params.liquidity} liquidity at tick ${params.fillTick}`,
  };
}

/**
 * Claim a filled order: the whole share, at once, straight from the pool.
 *
 * Reverts until the batch has settled — `getOrder` says whether it has.
 */
export function buildClaimOrder(
  params: OrderAt & { plugin: Address; epoch: number }
): TransactionRequest {
  return {
    to: params.plugin,
    data: encodeFunctionData({
      abi: pluginAbi,
      functionName: "claimOrder",
      args: [params.fillTick, params.sellingToken0, params.epoch],
    }),
    value: 0n,
    description: `claim the order at tick ${params.fillTick}, epoch ${params.epoch}`,
  };
}

/**
 * Settle what the last swaps crossed but did not get to.
 *
 * A swap settles a bounded number of batches; the rest wait, and go back to
 * resting if the price retreats before anything settles them. Anybody may call
 * this — the plugin's `SettlementIncomplete` event is the signal that it is
 * worth calling.
 */
export function buildPokeOrders(params: { plugin: Address }): TransactionRequest {
  return {
    to: params.plugin,
    data: encodeFunctionData({ abi: pluginAbi, functionName: "pokeOrders", args: [] }),
    value: 0n,
    description: `settle pending orders on ${params.plugin}`,
  };
}

function requireOrderPlugin(pool: PoolState): Address {
  if (pool.poolType !== PoolType.CL) {
    throw new InvalidArgumentError(
      `limit orders need a CL pool, and ${pool.address} is ${poolTypeLabel(pool.poolType)}`
    );
  }
  if (!pool.plugin) {
    throw new InvalidArgumentError(`${pool.address} has no plugin, so nothing can hold an order`);
  }
  if ((pool.pluginConfig & AFTER_SWAP) === 0) {
    throw new InvalidArgumentError(
      `${pool.address}'s plugin is not called after swaps, so an order placed there could never fill`
    );
  }
  return pool.plugin;
}

/*//////////////////////////////////////////////////////////////
                          Reading
//////////////////////////////////////////////////////////////*/

/** The key the plugin files a batch under: `keccak256(abi.encodePacked(int24, bool, uint32))`. */
export function orderBatchKey(params: OrderAt & { epoch: number }): Hex {
  return keccak256(
    encodePacked(["int24", "bool", "uint32"], [params.fillTick, params.sellingToken0, params.epoch])
  );
}

/**
 * The batch resting at a tick and side right now.
 *
 * `epoch` is the one an order placed now joins — read it when you place, since
 * it is what a claim will need. `tickSpacing` is the spacing the batch opened
 * under.
 */
export async function getOrderBatch(
  client: LunyaClient,
  params: OrderAt & { plugin: Address }
): Promise<{ liquidity: bigint; epoch: number; tickSpacing: number }> {
  const [liquidity, epoch, tickSpacing] = await client.publicClient.readContract({
    address: params.plugin,
    abi: pluginAbi,
    functionName: "restingAt",
    args: [params.fillTick, params.sellingToken0],
  });
  return { liquidity, epoch: Number(epoch), tickSpacing: Number(tickSpacing) };
}

export type Order = OrderAt & {
  epoch: number;
  /** This owner's liquidity in the batch. Zero once claimed or cancelled away, or if never placed. */
  liquidity: bigint;
  /**
   * `resting` — in the open batch, and cancellable. It may already be converted
   * and waiting on settlement; `buildPokeOrders` settles it.
   * `filled` — settled; `claimable` is what claiming pays.
   * `none` — nothing of this owner's in that batch.
   */
  status: "resting" | "filled" | "none";
  /** What `claimOrder` pays, token0 and token1, where the batch has filled. */
  claimable: { amount0: bigint; amount1: bigint } | null;
};

/**
 * One owner's order in one batch, and what claiming it would pay.
 *
 * Mostly one token: selling token0 claims token1, and the other way round. A
 * batch that settled with the price stopped inside its range can return a
 * remainder of the original token as well, and the claim pays both.
 */
export async function getOrder(
  client: LunyaClient,
  params: OrderAt & { plugin: Address; owner: Address; epoch: number }
): Promise<Order> {
  const key = orderBatchKey(params);
  const contract = { address: params.plugin, abi: pluginAbi } as const;

  const [contribution, filled, resting] = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...contract, functionName: "contributionOf", args: [key, params.owner] },
        { ...contract, functionName: "filledBatch", args: [key] },
        { ...contract, functionName: "restingAt", args: [params.fillTick, params.sellingToken0] },
      ],
      ...extra,
    })
  );

  const base = { fillTick: params.fillTick, sellingToken0: params.sellingToken0, epoch: params.epoch };
  const liquidity = contribution as bigint;
  const [, batchLiquidity, amount0, amount1, settled] = filled as readonly [number, bigint, bigint, bigint, boolean];
  const currentEpoch = Number((resting as readonly [bigint, number, number])[1]);

  if (liquidity === 0n) return { ...base, liquidity, status: "none", claimable: null };
  if (settled) {
    return {
      ...base,
      liquidity,
      status: "filled",
      // The contract's own arithmetic: pro rata on the batch, floored.
      claimable: {
        amount0: (amount0 * liquidity) / batchLiquidity,
        amount1: (amount1 * liquidity) / batchLiquidity,
      },
    };
  }
  return {
    ...base,
    liquidity,
    status: params.epoch === currentEpoch ? "resting" : "none",
    claimable: null,
  };
}

/*//////////////////////////////////////////////////////////////
                          Events
//////////////////////////////////////////////////////////////*/

/*
 * All five come from the pool's PLUGIN, not the pool: filter on `PoolState.plugin`.
 */

/** Liquidity placed. Carries no epoch — read `getOrderBatch` for it at placement. */
export const orderPlacedEvent = eventNamed(pluginAbi, "OrderPlaced");
/** Liquidity taken back out of an open batch. */
export const orderCancelledEvent = eventNamed(pluginAbi, "OrderCancelled");
/** A batch settled. `epoch` is the one that filled; the next placement at that tick opens the one after. */
export const ordersFilledEvent = eventNamed(pluginAbi, "OrdersFilled");
/** An owner's share paid out. */
export const orderClaimedEvent = eventNamed(pluginAbi, "OrderClaimed");
/** A swap crossed more than it could settle. The rest waits for the next swap or `pokeOrders`. */
export const settlementIncompleteEvent = eventNamed(pluginAbi, "SettlementIncomplete");
