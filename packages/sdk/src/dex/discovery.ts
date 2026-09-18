import {
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { poolDeployerAbi, poolFactoryAbi } from "../generated/abis.js";
import type { LunyaClient } from "../client.js";
import { batched } from "../internal/multicall.js";
import { POOL_TYPES, type PoolType } from "../types.js";
import { sortTokens } from "./pools.js";

/**
 * Finding pools without asking anybody.
 *
 * THE FACTORY HAS NO ENUMERATION. `getPool(tokenA, tokenB, poolType)` and
 * nothing else — no `allPools`, no count. That is a deliberate gas decision on
 * the contract's side and it leaves discovery to the caller, so this module is
 * the caller's half of it.
 *
 * NOTHING HERE CALLS A HOSTED SERVICE. An aggregator indexes for a living and
 * should not have anyone else's uptime in its critical path: a lagging index
 * means stale prices, and the outage is invisible from the inside. Everything
 * below runs against whatever RPC you already have.
 *
 * There are two honest ways to discover a pool and this module offers both:
 *
 *   DERIVE  — a pool's address is CREATE2 from the deployer, salted by
 *             `(token0, token1, poolType)`. Read the three init code hashes
 *             once and every address after that is pure local arithmetic:
 *             no RPC, no rate limit, no bound on how many you compute.
 *
 *   CONFIRM — derivation says where a pool WOULD be, not whether it exists.
 *             `findPools` answers that in batched multicalls against the
 *             factory.
 *
 * For a live feed, index `PoolCreated` yourself — `poolCreatedEvent` is
 * exported for exactly that, and the pool events are Uniswap-V3-identical by
 * design, so your existing pipeline already understands them.
 */

/*//////////////////////////////////////////////////////////////
                      Offline derivation
//////////////////////////////////////////////////////////////*/

/**
 * The three init code hashes, one per curve.
 *
 * READ FROM THE CHAIN, NEVER HARDCODED. The hash is a property of the
 * deployment — a chain that shipped a different blueprint has a different one,
 * and an SDK carrying a constant would compute confident, wrong addresses
 * there. The protocol's own integration docs give integrators this same advice;
 * this is that advice as code.
 *
 * The pool's init code carries no constructor arguments (the pool reads its
 * parameters back from the deployer during construction), which is precisely
 * what keeps the hash constant and the address computable at all.
 */
export type InitCodeHashes = Readonly<Record<PoolType, Hex>>;

/**
 * Cached per deployer address, because it cannot change for one.
 *
 * `setBlueprint` can change it, and that is an owner action that redeploys the
 * pool implementation — at which point every previously derived address is
 * historical anyway. `forgetInitCodeHashes` is there for a test chain that does
 * it mid-session.
 */
const hashCache = new Map<string, InitCodeHashes>();

export const forgetInitCodeHashes = (deployer: Address): void => {
  hashCache.delete(deployer.toLowerCase());
};

export async function getInitCodeHashes(client: LunyaClient): Promise<InitCodeHashes> {
  const deployer = client.dexAddress("poolDeployer");
  const cached = hashCache.get(deployer.toLowerCase());
  if (cached) return cached;

  const results = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: false,
      contracts: POOL_TYPES.map((poolType) => ({
        address: deployer,
        abi: poolDeployerAbi,
        functionName: "initCodeHashOf" as const,
        args: [poolType] as const,
      })),
      ...extra,
    })
  );

  const hashes = Object.fromEntries(
    POOL_TYPES.map((poolType, i) => [poolType, results[i] as Hex])
  ) as unknown as InitCodeHashes;

  hashCache.set(deployer.toLowerCase(), hashes);
  return hashes;
}

/**
 * Where a pool lives, computed locally.
 *
 * Pure: no network, no client, no limit on how many you call it for. That is
 * the whole point — an aggregator scanning a token universe should not spend an
 * RPC call per candidate, and a bot building calldata for a pair it already
 * knows should not look the address up at all.
 *
 * Note this answers for a pool that does not exist yet, which is what makes it
 * useful before `createPool` and useless as an existence test. Use `findPools`
 * for that.
 *
 * It is also the cheapest way to VERIFY a pool address you were handed: derive
 * it from the pair and compare. A pool address that does not derive is not a
 * Lunya pool for that pair, whatever it claims.
 */
export function poolAddress(
  deployer: Address,
  hashes: InitCodeHashes,
  tokenA: Address,
  tokenB: Address,
  poolType: PoolType
): Address {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  return getCreate2Address({
    from: deployer,
    // `abi.encode(token0, token1, poolType)` — encode, not encodePacked. The
    // deployer uses the padded encoding for the salt and the packed one only for
    // the 0xff prefix; mixing them up produces a plausible, wrong address.
    salt: keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint8" }],
        [token0, token1, poolType]
      )
    ),
    bytecodeHash: hashes[poolType],
  });
}

/** Bound to a client, with the hashes fetched once. Every call after is offline. */
export async function poolAddressFn(
  client: LunyaClient
): Promise<(tokenA: Address, tokenB: Address, poolType: PoolType) => Address> {
  const deployer = client.dexAddress("poolDeployer");
  const hashes = await getInitCodeHashes(client);
  return (tokenA, tokenB, poolType) => poolAddress(deployer, hashes, tokenA, tokenB, poolType);
}

/*//////////////////////////////////////////////////////////////
                     Confirming existence
//////////////////////////////////////////////////////////////*/

export type FoundPool = {
  pool: Address;
  token0: Address;
  token1: Address;
  poolType: PoolType;
};

export type FindPoolsOptions = {
  /** Restrict to some curves. Defaults to all three. */
  poolTypes?: readonly PoolType[];
  /**
   * Calls per multicall. 500 is conservative; raise it against your own node.
   *
   * It matters more than it looks: a hundred tokens is 4,950 pairs and 14,850
   * candidates, and a single multicall carrying all of them is a request most
   * endpoints refuse outright.
   */
  batchSize?: number;
};

/**
 * Which pools actually exist among a set of tokens.
 *
 * Every unordered pair against every curve, asked of the factory in batches.
 * No logs — so no `eth_getLogs` range cap, no archive node, and nothing that
 * degrades as the chain gets older.
 *
 * The cost is quadratic in the token count, which is fine for the way this is
 * actually used: run it once over your universe, then keep it current from
 * `PoolCreated` (see `poolCreatedEvent`) or by re-running it for new tokens
 * only. Ten thousand tokens is not what this is for.
 */
export async function findPools(
  client: LunyaClient,
  tokens: readonly Address[],
  options: FindPoolsOptions = {}
): Promise<FoundPool[]> {
  const factory = client.dexAddress("factory");
  const types = options.poolTypes ?? POOL_TYPES;
  const batchSize = options.batchSize ?? 500;

  // Deduplicated and canonically ordered first: the same token twice would ask
  // the factory for a pool of a token against itself, and an unsorted pair would
  // ask the same question twice under two spellings.
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))] as Address[];

  const candidates: { token0: Address; token1: Address; poolType: PoolType }[] = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const [token0, token1] = sortTokens(unique[i]!, unique[j]!);
      for (const poolType of types) candidates.push({ token0, token1, poolType });
    }
  }

  const found: FoundPool[] = [];

  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const slice = candidates.slice(offset, offset + batchSize);
    const results = await batched(client.publicClient, (extra) =>
      client.publicClient.multicall({
        // Per-entry failures are tolerated here rather than fatal: one bad token
        // in a universe of thousands should not take the whole scan down.
        allowFailure: true,
        contracts: slice.map((c) => ({
          address: factory,
          abi: poolFactoryAbi,
          functionName: "getPool" as const,
          args: [c.token0, c.token1, c.poolType] as const,
        })),
        ...extra,
      })
    );

    results.forEach((result, i) => {
      if (result.status !== "success") return;
      const pool = result.result as Address;
      if (pool === zeroAddress) return;
      found.push({ pool, ...slice[i]! });
    });
  }

  return found;
}

/*//////////////////////////////////////////////////////////////
                       Streaming
//////////////////////////////////////////////////////////////*/

/**
 * The `PoolCreated` ABI item, for `watchEvent` / `getLogs` filters of your own.
 *
 * Exported rather than wrapped: how you index — websocket subscription, polled
 * `getLogs`, an archive backfill, a queue — is your infrastructure decision, and
 * an SDK that wrapped it would be imposing one. The event carries the pool's
 * type, tick spacing and birth fee, so a row can be built from the log alone
 * without reading the pool.
 */
/*
 * TWO EVENTS ARE CALLED `PoolCreated`, and only one of them is this protocol's.
 *
 * The factory can also emit the event under Uniswap V3's exact signature, so an
 * indexer built for V3 discovers pools with no changes. That one carries the
 * pool type squeezed into V3's `uint24 fee` slot, has no fee at all, and is OFF
 * until governance switches it on. Selecting by name alone returns whichever
 * sorts first — which is the compatibility one — and a feed built on it would
 * see no pools. So it is selected by shape: the one whose `poolType` is the enum
 * (`uint8`) and which carries a `fee`. A test pins that.
 */
export const poolCreatedEvent = poolFactoryAbi.find(
  (e) =>
    e.type === "event" &&
    e.name === "PoolCreated" &&
    (e.inputs as readonly { name: string; type: string }[]).some(
      (i) => i.name === "poolType" && i.type === "uint8"
    ) &&
    (e.inputs as readonly { name: string }[]).some((i) => i.name === "fee")
)! as NativePoolCreated;

/**
 * The native event's TYPE, so `watchEvent` and `getLogs` decode typed args.
 * Six inputs is what tells it from the V3-shaped one, which has five.
 */
type NativePoolCreated = Extract<
  (typeof poolFactoryAbi)[number],
  { type: "event"; name: "PoolCreated"; inputs: readonly [unknown, unknown, unknown, unknown, unknown, unknown] }
>;
