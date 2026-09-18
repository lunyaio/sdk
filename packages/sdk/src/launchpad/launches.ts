import { zeroAddress, type Address, type Hex } from "viem";

import { launchAbi, launchFactoryAbi } from "../generated/abis.js";
import type { LunyaClient } from "../client.js";
import { LaunchPhase, LaunchType, type Launch } from "../types.js";
import { batched } from "../internal/multicall.js";
import { price, progress } from "./curve.js";

/*//////////////////////////////////////////////////////////////
                        Reading a launch
//////////////////////////////////////////////////////////////*/

/**
 * A launch is its own contract, so there are two addresses in play and they are
 * not interchangeable.
 *
 * `launch` is what you call — `buy`, `sell`, `quoteBuy` all live on it. `token`
 * is what you end up holding. A caller who has the token and wants to trade it
 * goes through `getLaunchByToken`, which asks the factory; a caller who already
 * has the launch address should not pay for that hop.
 */
/**
 * What `config()` hands back.
 *
 * A named struct, so viem decodes it to an object — read by field rather than
 * by position, which is what keeps this from silently misreading if the
 * contract ever reorders it.
 */
type LaunchConfig = {
  quoteToken: Address;
  creator: Address;
  nativeDivisor: bigint;
  virtualQuote: bigint;
  virtualToken: bigint;
  curveSupply: bigint;
  lpSupply: bigint;
  graduationReward: bigint;
  curveFeeBps: number;
  graduationFeeBps: number;
  snipeTaxBps: number;
  snipeWindow: number;
  snipeDecay: number;
};

/**
 * Everything a launch needs to be priced, in one round trip.
 *
 * Six reads in one batch: `config()`, `token` and `openedAt` are fixed for the
 * life of a launch, and `phase`, `reserve` and `sold` are the parts that move.
 * `openedAt` is there because the anti-snipe surcharge counts from it.
 */
export async function getLaunch(client: LunyaClient, launch: Address): Promise<Launch> {
  const contract = { address: launch, abi: launchAbi } as const;

  const [config, token, phase, reserve, sold, openedAt] = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...contract, functionName: "config" },
        { ...contract, functionName: "token" },
        { ...contract, functionName: "phase" },
        { ...contract, functionName: "reserve" },
        { ...contract, functionName: "sold" },
        { ...contract, functionName: "openedAt" },
      ],
      ...extra,
    })
  );

  return decodeLaunch(launch, token as Address, config as unknown as LaunchConfig, {
    phase: Number(phase),
    reserve: reserve as bigint,
    sold: sold as bigint,
    openedAt: BigInt(openedAt as unknown as number),
  });
}

function decodeLaunch(
  address: Address,
  token: Address,
  c: LaunchConfig,
  state: { phase: number; reserve: bigint; sold: bigint; openedAt: bigint }
): Launch {
  const base = {
    address,
    token,
    quoteToken: c.quoteToken,
    creator: c.creator,
    phase: state.phase as LaunchPhase,
    nativeDivisor: c.nativeDivisor,
    virtualQuote: c.virtualQuote,
    virtualToken: c.virtualToken,
    curveSupply: c.curveSupply,
    lpSupply: c.lpSupply,
    graduationReward: c.graduationReward,
    curveFeeBps: Number(c.curveFeeBps),
    graduationFeeBps: Number(c.graduationFeeBps),
    snipeTaxBps: Number(c.snipeTaxBps),
    snipeWindow: Number(c.snipeWindow),
    snipeDecay: Number(c.snipeDecay),
    openedAt: state.openedAt,
    reserve: state.reserve,
    sold: state.sold,
  };
  return { ...base, progress: progress(base), price: price(base) };
}

/**
 * The launch that sells a token, or null if the factory never made one.
 *
 * Worth knowing: this is the hop a caller pays for arriving with a token
 * address rather than a launch address. Cache it — a launch's token never
 * changes, so the mapping is permanent.
 */
export async function getLaunchByToken(
  client: LunyaClient,
  token: Address
): Promise<Launch | null> {
  const launch = await client.publicClient.readContract({
    address: client.launchFactoryAddress(),
    abi: launchFactoryAbi,
    functionName: "launchOf",
    args: [token],
  });
  if (launch === zeroAddress) return null;
  return getLaunch(client, launch as Address);
}

/**
 * Several launches in one batch.
 *
 * Worth having as its own function rather than a loop of `getLaunch`: a board
 * showing fifty launches is three hundred reads done naively, and every
 * public endpoint rate-limits long before it runs out of capacity to answer.
 */
export async function getLaunches(client: LunyaClient, launches: Address[]): Promise<Launch[]> {
  if (launches.length === 0) return [];

  const results = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: false,
      contracts: launches.flatMap((address) => {
        const contract = { address, abi: launchAbi } as const;
        return [
          { ...contract, functionName: "config" as const },
          { ...contract, functionName: "token" as const },
          { ...contract, functionName: "phase" as const },
          { ...contract, functionName: "reserve" as const },
          { ...contract, functionName: "sold" as const },
          { ...contract, functionName: "openedAt" as const },
        ];
      }),
      ...extra,
    })
  );

  return launches.map((address, i) => {
    const at = i * 6;
    return decodeLaunch(address, results[at + 1] as Address, results[at] as unknown as LaunchConfig, {
      phase: Number(results[at + 2]),
      reserve: results[at + 3] as bigint,
      sold: results[at + 4] as bigint,
      openedAt: BigInt(results[at + 5] as unknown as number),
    });
  });
}

/*//////////////////////////////////////////////////////////////
                          Discovery
//////////////////////////////////////////////////////////////*/

/**
 * Every launch the factory has made, in creation order.
 *
 * Paged, because the registry is an array read one index at a time. For a live
 * feed, index the factory's creation event yourself rather than re-walking this.
 */
export async function listLaunches(
  client: LunyaClient,
  options: { offset?: number; limit?: number } = {}
): Promise<Address[]> {
  const factory = client.launchFactoryAddress();
  const total = Number(
    await client.publicClient.readContract({
      address: factory,
      abi: launchFactoryAbi,
      functionName: "launchCount",
    })
  );

  const offset = options.offset ?? 0;
  const limit = Math.min(options.limit ?? 100, Math.max(0, total - offset));
  if (limit <= 0) return [];

  const results = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: false,
      contracts: Array.from({ length: limit }, (_, i) => ({
        address: factory,
        abi: launchFactoryAbi,
        functionName: "launchAt" as const,
        args: [BigInt(offset + i)] as const,
      })),
      ...extra,
    })
  );

  return results as Address[];
}

/**
 * Every token the factory has launched, each with the launch that sells it, in
 * creation order.
 *
 * `listLaunches` plus one `token()` per launch, batched. Both halves come back
 * because they are two contracts: the token is what a wallet or a token list
 * knows, the launch is what `buy` and `sell` are called on.
 */
export async function listTokens(
  client: LunyaClient,
  options: { offset?: number; limit?: number } = {}
): Promise<{ token: Address; launch: Address }[]> {
  const launches = await listLaunches(client, options);
  if (launches.length === 0) return [];

  const tokens = await batched(client.publicClient, (extra) =>
    client.publicClient.multicall({
      allowFailure: false,
      contracts: launches.map((address) => ({
        address,
        abi: launchAbi,
        functionName: "token" as const,
      })),
      ...extra,
    })
  );

  return launches.map((launch, i) => ({ token: tokens[i] as Address, launch }));
}

/** Whether an address is a launch this factory made. Cheap, and worth asking. */
export async function isLaunch(client: LunyaClient, address: Address): Promise<boolean> {
  return client.publicClient.readContract({
    address: client.launchFactoryAddress(),
    abi: launchFactoryAbi,
    functionName: "isLaunch",
    args: [address],
  });
}

/**
 * Where a launch WOULD be, before anybody creates it.
 *
 * The same trick the pool deployer plays: the address is deterministic in the
 * creation parameters — launch type, quote token, creator, creator fee
 * recipient, launch parameters and salt — so it can be known in advance and
 * stays known. Useful for watching an address before it exists, and for checking
 * that a launch you were handed is the one those parameters produce.
 *
 * Asked on-chain rather than derived here because the clone's init code is a
 * property of the deployment — an SDK carrying a constant would compute
 * confident, wrong addresses on any factory built from a different
 * implementation.
 */
export async function predictLaunch(
  client: LunyaClient,
  params: {
    /** Defaults to the constant-product launch, the only type there is today. */
    launchType?: LaunchType;
    quoteToken: Address;
    creator: Address;
    /** Where the creator's share of fees goes. Part of the address. */
    creatorFeeRecipient: Address;
    /** Per-launch parameters, byte for byte as the creation passes them. Defaults to none. */
    launchParams?: Hex;
    salt: Hex;
  }
): Promise<{ launch: Address; token: Address }> {
  const result = await client.publicClient.readContract({
    address: client.launchFactoryAddress(),
    abi: launchFactoryAbi,
    functionName: "predictLaunch",
    args: [
      params.launchType ?? LaunchType.ConstantProduct,
      params.quoteToken,
      params.creator,
      params.creatorFeeRecipient,
      params.launchParams ?? "0x",
      params.salt,
    ],
  });
  const [launch, token] = result as readonly [Address, Address];
  return { launch, token };
}

export { LaunchPhase, LaunchType };
