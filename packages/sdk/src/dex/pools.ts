import { getAddress, zeroAddress, type Address } from "viem";

import { pluginAbi, poolAbi, poolDeployerAbi, poolFactoryAbi, stablePoolAbi } from "../generated/abis.js";
import type { LunyaClient } from "../client.js";
import {
  PoolType,
  POOL_TYPES,
  hasTicks,
  type FeeToken,
  type PoolType as PoolTypeValue,
} from "../types.js";
import { batched } from "../internal/multicall.js";

/*//////////////////////////////////////////////////////////////
                          Sorting
//////////////////////////////////////////////////////////////*/

/**
 * The canonical order a pool stores its pair in.
 *
 * Byte order on the checksummed-lowercase form, which is what Solidity's `<`
 * compares. Getting this wrong does not fail loudly — it inverts every price
 * you compute — so nothing in this SDK compares addresses by hand.
 */
export function sortTokens(tokenA: Address, tokenB: Address): [Address, Address] {
  // Lowercased before checksumming: an address that arrived from a database or
  // a log in the wrong case is still that address, and refusing it here would
  // be a checksum lecture in the middle of a swap.
  const a = getAddress(tokenA.toLowerCase());
  const b = getAddress(tokenB.toLowerCase());
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

export const isToken0 = (token: Address, other: Address): boolean =>
  token.toLowerCase() < other.toLowerCase();

/*//////////////////////////////////////////////////////////////
                          Addresses
//////////////////////////////////////////////////////////////*/

/**
 * Where a pool lives, asked of the deployer.
 *
 * CREATE2 from the **deployer**, not the factory, salted by
 * `(token0, token1, poolType)`. Asked on-chain rather than computed here on
 * purpose: the init code hash is a property of the deployment, and an SDK that
 * hardcoded one would compute confident, wrong addresses the first time a
 * deployment shipped a different blueprint. The docs tell integrators the same
 * thing, and this is that advice as code.
 *
 * Note this answers for a pool that does not exist yet, which is exactly what
 * makes it useful before `createPool`. Use `getPool` to ask whether one does.
 */
export async function computePoolAddress(
  client: LunyaClient,
  tokenA: Address,
  tokenB: Address,
  poolType: PoolTypeValue
): Promise<Address> {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  return client.publicClient.readContract({
    address: client.dexAddress("poolDeployer"),
    abi: poolDeployerAbi,
    functionName: "computePoolAddress",
    args: [token0, token1, poolType],
  });
}

/** The pool of one type for a pair, or null where none has been created. */
export async function getPool(
  client: LunyaClient,
  tokenA: Address,
  tokenB: Address,
  poolType: PoolTypeValue
): Promise<Address | null> {
  const address = await client.publicClient.readContract({
    address: client.dexAddress("factory"),
    abi: poolFactoryAbi,
    functionName: "getPool",
    args: [tokenA, tokenB, poolType],
  });
  return address === zeroAddress ? null : address;
}

export type PairPool = { poolType: PoolTypeValue; pool: Address };

/**
 * Which curves actually exist for a pair.
 *
 * One `getPool` per type, multicalled — the factory keys on the triple and
 * answers one at a time. Three reads still cost one round trip.
 *
 * A read that FAILED is not a pool that is absent, and the two are treated
 * differently here: a failure is skipped, but if every read failed the RPC is
 * the problem and saying "no pools" would send the caller looking for a pair
 * that is sitting right there.
 */
export async function getPairPools(
  client: LunyaClient,
  tokenA: Address,
  tokenB: Address
): Promise<PairPool[]> {
  if (tokenA.toLowerCase() === tokenB.toLowerCase()) return [];

  const factory = client.dexAddress("factory");
  const results = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: true,
      contracts: POOL_TYPES.map((poolType) => ({
        address: factory,
        abi: poolFactoryAbi,
        functionName: "getPool" as const,
        args: [tokenA, tokenB, poolType] as const,
      })),
      ...extra,
    })
  );

  if (results.every((r) => r.status === "failure")) {
    // Every entry failing does not mean the pair has no pools — a `getPool` that
    // does not answer is not a pool that is absent. viem spreads a whole-request
    // failure (a 429, a dead endpoint) across the entries rather than throwing,
    // so this is what rate limiting looks like from here, and reporting it as
    // "no pools" sends the caller hunting for a pair that is sitting right there.
    //
    // The underlying error is carried on `cause` rather than summarised, because
    // "rate limit exceeded" and "no contract at that address" call for entirely
    // different fixes and only the error itself can tell them apart.
    const error = new Error(
      `the factory at ${factory} answered none of the three getPool reads for ` +
        `${tokenA}/${tokenB}. This is an RPC or address problem, not an absent pair — ` +
        `check the cause.`
    );
    const reason = results.find((r) => r.status === "failure")?.error;
    if (reason) error.cause = reason;
    throw error;
  }

  const pools: PairPool[] = [];
  results.forEach((result, i) => {
    if (result.status !== "success") return;
    const address = result.result as Address;
    if (address === zeroAddress) return;
    pools.push({ poolType: POOL_TYPES[i]!, pool: address });
  });
  return pools;
}

/*//////////////////////////////////////////////////////////////
                            State
//////////////////////////////////////////////////////////////*/

export type PoolState = {
  address: Address;
  token0: Address;
  token1: Address;
  poolType: PoolTypeValue;
  sqrtPriceX96: bigint;
  /**
   * Where the price sits.
   *
   * On a CL or CP pool this is a place liquidity is stored. On a STABLE pool it
   * is a DERIVED MEASUREMENT and nothing is held at it — see `tickIsReal`, and
   * never mint against a tick read from a STABLE pool.
   */
  tick: number;
  /** True where `tick` names a real position boundary. False on STABLE. */
  tickIsReal: boolean;
  /** In hundredths of a bip: 1e6 = 100%. There are no fee tiers. */
  fee: number;
  /** Whether a plugin is moving the fee with volatility. */
  dynamicFee: boolean;
  liquidity: bigint;
  tickSpacing: number;
  feeProtocol0: number;
  feeProtocol1: number;
  /** Which coin the fee is taken in. See `FeeToken`. */
  feeToken: FeeToken;
  /** The pool's plugin — where limit orders and the dynamic fee live — or null for none. */
  plugin: Address | null;
  /** Which of the plugin's hooks the pool calls, as the pool's bit flags. */
  pluginConfig: number;
  /**
   * A STABLE pool's own curve state; null on CL and CP.
   *
   * A STABLE pool prices from RESERVES, not from a price and a liquidity, so
   * `sqrtPriceX96`, `tick` and `liquidity` describe it only as measurements. What
   * actually prices a trade on it is here.
   */
  stable: StablePoolState | null;
};

export type StablePoolState = {
  /**
   * Token0 on the curve, in raw units.
   *
   * Not the pool's balance: collected fees and protocol fees owed sit beside it
   * and are not part of what prices a trade.
   */
  reserve0: bigint;
  /** Token1 on the curve, in raw units. */
  reserve1: bigint;
  /** The amplification coefficient in force right now, ramp included, in hundredths. */
  amplificationX100: number;
  /**
   * A change of amplification in flight, or null.
   *
   * `amplificationX100` already includes it; the endpoints say where A is
   * heading and when it gets there. Null unless the pool reports a ramp as live —
   * a finished ramp keeps its endpoints until a swap clears them, so on their
   * own they say nothing.
   */
  ramp: {
    startAmplificationX100: number;
    targetAmplificationX100: number;
    /** Unix seconds. */
    startTime: number;
    /** Unix seconds. */
    endTime: number;
  } | null;
  /** 10^(18 − decimals0): lifts a raw token0 amount to the 18-decimal scale the curve works in. */
  rate0: bigint;
  /** 10^(18 − decimals1). */
  rate1: bigint;
  /** sqrt(rate1 / rate0) as Q64.96: the factor between a raw sqrt price and a normalised one. */
  priceScaleSqrtQ96: bigint;
};

/**
 * Everything about a pool that pricing needs.
 *
 * `slot0()` is read rather than the individual getters because it is five
 * fields on **every** pool type by design — the shared interface exists so
 * generic code never branches on the curve. It is five, not V3's seven: there
 * are no observation fields (the TWAP is a plugin) and no `unlocked`.
 *
 * One round trip for CL and CP. A STABLE pool's curve state is a second batch,
 * because the type is only known once the first one answers — pass `poolType`
 * when you already know it (`findPools` and `getPairPools` do) and the two go
 * out together. The hint has to be right: a STABLE read against a CL pool
 * reverts.
 */
export async function getPoolState(
  client: LunyaClient,
  pool: Address,
  options: { poolType?: PoolTypeValue } = {}
): Promise<PoolState> {
  const [shared, hinted] = await Promise.all([
    readShared(client, pool),
    options.poolType === PoolType.STABLE ? readStable(client, pool) : Promise.resolve(null),
  ]);

  const poolType = shared.poolType;
  const stable = poolType === PoolType.STABLE ? (hinted ?? (await readStable(client, pool))) : null;

  return { ...shared, stable };
}

async function readShared(client: LunyaClient, pool: Address): Promise<Omit<PoolState, "stable">> {
  const contract = { address: pool, abi: poolAbi } as const;

  const [slot0, token0, token1, poolTypeRaw, liquidity, tickSpacing, feeInfo, feeToken, plugin, pluginConfig] = await batched(
    client.publicClient,
    (extra) =>
      client.publicClient.multicall({
        allowFailure: false,
        contracts: [
          { ...contract, functionName: "slot0" },
          { ...contract, functionName: "token0" },
          { ...contract, functionName: "token1" },
          { ...contract, functionName: "poolType" },
          { ...contract, functionName: "liquidity" },
          { ...contract, functionName: "tickSpacing" },
          { ...contract, functionName: "feeInfo" },
          { ...contract, functionName: "feeToken" },
          { ...contract, functionName: "plugin" },
          { ...contract, functionName: "pluginConfig" },
        ],
        ...extra,
      })
  );

  const [sqrtPriceX96, tick, fee, feeProtocol0, feeProtocol1] = slot0 as readonly [
    bigint,
    number,
    number,
    number,
    number,
  ];
  const poolType = Number(poolTypeRaw) as PoolTypeValue;

  return {
    address: pool,
    token0: token0 as Address,
    token1: token1 as Address,
    poolType,
    sqrtPriceX96,
    tick: Number(tick),
    tickIsReal: hasTicks(poolType),
    fee: Number(fee),
    dynamicFee: (feeInfo as readonly [number, boolean])[1],
    liquidity: liquidity as bigint,
    tickSpacing: Number(tickSpacing),
    feeProtocol0: Number(feeProtocol0),
    feeProtocol1: Number(feeProtocol1),
    feeToken: Number(feeToken) as FeeToken,
    plugin: plugin === zeroAddress ? null : (plugin as Address),
    pluginConfig: Number(pluginConfig),
  };
}

/**
 * The fee the next swap on a pool would pay, as closely as a read can say.
 *
 * - `static` — the pool's fee is fixed and this is it: what the next swap pays,
 *   unless an administrator changes it first.
 * - `plugin` — a dynamic pool, priced by its plugin from volatility; this is the
 *   plugin's `currentFee()` at the latest block. It moves with time as well as
 *   with trades, so a swap mined later can pay slightly differently.
 * - `lastSwap` — a dynamic pool whose plugin has no `currentFee()`; this is only
 *   what the last swap paid, not a prediction.
 *
 * In hundredths of a bip. For an exact amount, quote: the quoter runs the swap.
 */
export async function getCurrentFee(
  client: LunyaClient,
  pool: Address
): Promise<{ fee: number; source: "static" | "plugin" | "lastSwap" }> {
  const contract = { address: pool, abi: poolAbi } as const;
  const [feeInfo, plugin] = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...contract, functionName: "feeInfo" },
        { ...contract, functionName: "plugin" },
      ],
      ...extra,
    })
  );

  const [lastFee, dynamic] = feeInfo as readonly [number, boolean];
  if (!dynamic) return { fee: Number(lastFee), source: "static" };
  if (plugin === zeroAddress) return { fee: Number(lastFee), source: "lastSwap" };

  try {
    const fee = await client.publicClient.readContract({
      address: plugin as Address,
      abi: pluginAbi,
      functionName: "currentFee",
    });
    return { fee: Number(fee), source: "plugin" };
  } catch {
    // A plugin built from another factory need not have it. What the pool
    // itself knows is still worth returning, labelled for what it is.
    return { fee: Number(lastFee), source: "lastSwap" };
  }
}

async function readStable(client: LunyaClient, pool: Address): Promise<StablePoolState> {
  const contract = { address: pool, abi: stablePoolAbi } as const;

  const [reserve0, reserve1, amplificationX100, ramping, ramp, rate0, rate1, priceScaleSqrtQ96] =
    await batched(client.publicClient, (extra) =>
      client.publicClient.multicall({
        allowFailure: false,
        contracts: [
          { ...contract, functionName: "curveReserve0" },
          { ...contract, functionName: "curveReserve1" },
          { ...contract, functionName: "amplificationX100" },
          { ...contract, functionName: "amplificationRamping" },
          { ...contract, functionName: "amplificationRamp" },
          { ...contract, functionName: "rate0" },
          { ...contract, functionName: "rate1" },
          { ...contract, functionName: "priceScaleSqrtQ96" },
        ],
        ...extra,
      })
    );

  const [startAmplification, targetAmplification, startTime, endTime] = ramp as readonly [
    number,
    number,
    number,
    number,
  ];

  return {
    reserve0: reserve0 as bigint,
    reserve1: reserve1 as bigint,
    amplificationX100: Number(amplificationX100),
    ramp: ramping
      ? {
          startAmplificationX100: Number(startAmplification),
          targetAmplificationX100: Number(targetAmplification),
          startTime: Number(startTime),
          endTime: Number(endTime),
        }
      : null,
    rate0: rate0 as bigint,
    rate1: rate1 as bigint,
    priceScaleSqrtQ96: priceScaleSqrtQ96 as bigint,
  };
}

/**
 * The price of token1 in token0, as a float, adjusted for decimals.
 *
 * For display. Anything that ends up in calldata should stay in the Q96
 * integers — see `internal/math`.
 */
export function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number
): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

/*
 * There is no `createPool` here, deliberately.
 *
 * Same reasoning as the launchpad's `createToken`: opening a market is a
 * first-party surface, and this SDK is for the people trading the ones that
 * exist. The factory is permissionless for CL on this deployment and the ABI
 * ships regardless, so this is not a barrier — it is a statement about what we
 * support and what we point people at.
 *
 * `computePoolAddress` and `poolAddress` still answer for a pool that does not
 * exist yet, which is what makes them useful for deriving and verifying
 * addresses rather than for creating anything.
 */

export { PoolType };
