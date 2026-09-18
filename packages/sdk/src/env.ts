import { getAddress, isAddress, type Address } from "viem";

import { DEPLOYMENTS } from "./generated/deployments.js";
import { InvalidArgumentError } from "./errors.js";
import type { Deployment, DexAddresses, LaunchFactoryAddresses } from "./types.js";

/**
 * A deployment assembled from environment variables.
 *
 * EXPLICIT, NOT AMBIENT. Nothing else in this package reads `process.env` — a
 * library that quietly picks up configuration from the environment is one that
 * behaves differently in a test than in production for reasons nothing in the
 * call site explains, and it does not work in a browser at all. This is a
 * function you call, in Node, when the environment is where your addresses
 * happen to live.
 *
 * The registry ships every listed network's addresses, so none of these is
 * needed to trade on them. Each one set overrides the shipped value — a fork,
 * your own deployment, contracts newer than this version — and
 * `createLunyaClient({ deployment, addresses })` does the same from wherever
 * else you keep configuration.
 *
 * ```
 * LUNYA_CHAIN_ID          5042002            (or use LUNYA_NETWORK below)
 * LUNYA_RPC_URL           https://…          optional; overrides the shipped one
 *
 * LUNYA_DEX_FACTORY       0x…                \\
 * LUNYA_DEX_POOL_DEPLOYER 0x…                 |  optional; override the DEX
 * LUNYA_DEX_SWAP_ROUTER   0x…                 |
 * LUNYA_DEX_QUOTER        0x…                /
 *
 * LUNYA_LAUNCH_FACTORY    0x…                optional; overrides the launch factory
 * LUNYA_PAIR_TOKEN        0x…                optional; the default routing hub
 * ```
 */

export type FromEnvOptions = {
  /** Where to read from. Defaults to `process.env`; pass anything for a test. */
  env?: Record<string, string | undefined>;
  /**
   * Which network to start from, when `LUNYA_CHAIN_ID` is not set.
   *
   * The shipped entry supplies the chain metadata — name, native coin, explorer,
   * whether it is a testnet — which environment variables would only duplicate
   * and get wrong.
   */
  network?: "mainnet" | "testnet" | number;
};

export function deploymentFromEnv(options: FromEnvOptions = {}): Deployment {
  const env = options.env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) {
    throw new InvalidArgumentError(
      "no environment to read from. `deploymentFromEnv` is for Node; in a browser, " +
        "pass `addresses` to createLunyaClient instead."
    );
  }

  const base = resolveBase(env, options.network);

  const dex: DexAddresses = {
    factory: address(env, "LUNYA_DEX_FACTORY") ?? base.dex?.factory ?? null,
    poolDeployer: address(env, "LUNYA_DEX_POOL_DEPLOYER") ?? base.dex?.poolDeployer ?? null,
    swapRouter: address(env, "LUNYA_DEX_SWAP_ROUTER") ?? base.dex?.swapRouter ?? null,
    quoter: address(env, "LUNYA_DEX_QUOTER") ?? base.dex?.quoter ?? null,
    startBlock: Number(env.LUNYA_DEX_START_BLOCK ?? base.dex?.startBlock ?? 0),
  };

  const launchFactory: LaunchFactoryAddresses = {
    address: address(env, "LUNYA_LAUNCH_FACTORY") ?? base.launchFactory?.address ?? null,
    startBlock: Number(env.LUNYA_LAUNCH_START_BLOCK ?? base.launchFactory?.startBlock ?? 0),
  };

  return {
    ...base,
    ...(env.LUNYA_RPC_URL ? { rpcUrl: env.LUNYA_RPC_URL } : {}),
    pairToken: address(env, "LUNYA_PAIR_TOKEN") ?? base.pairToken,
    // A product with nothing configured stays null rather than becoming an
    // object of nulls, so `client.has()` keeps answering the question it was
    // asked: is this deployment running that product at all.
    dex: dex.factory || dex.swapRouter || dex.quoter ? dex : null,
    launchFactory: launchFactory.address ? launchFactory : null,
  };
}

/*//////////////////////////////////////////////////////////////
                          Internals
//////////////////////////////////////////////////////////////*/

function resolveBase(
  env: Record<string, string | undefined>,
  network: FromEnvOptions["network"]
): Deployment {
  const all = DEPLOYMENTS as readonly Deployment[];

  const chainId = env.LUNYA_CHAIN_ID ? Number(env.LUNYA_CHAIN_ID) : undefined;
  if (chainId !== undefined) {
    if (!Number.isInteger(chainId)) {
      throw new InvalidArgumentError(`LUNYA_CHAIN_ID is not a number: "${env.LUNYA_CHAIN_ID}"`);
    }
    const known = all.find((d) => d.chainId === chainId);
    if (known) return known;

    /**
     * An unknown chain is allowed, and the metadata has to come from somewhere.
     *
     * Nothing is invented: the name says plainly that it is unnamed, `native`
     * takes the eighteen-decimal default every EVM gas coin has, and `testnet`
     * is true because assuming a chain nobody has heard of is production is the
     * assumption that costs money.
     */
    return {
      chainId,
      name: `Chain ${chainId}`,
      rpcUrl: env.LUNYA_RPC_URL ?? null,
      explorerUrl: null,
      testnet: true,
      native: { symbol: "ETH", decimals: 18, isUsd: false, hasWrapper: true },
      pairToken: null,
      wrappedNative: null,
      dex: null,
      launchFactory: null,
    };
  }

  const selector = network ?? "testnet";
  if (typeof selector === "number") {
    const known = all.find((d) => d.chainId === selector);
    if (!known) throw new InvalidArgumentError(`no shipped network with chain id ${selector}`);
    return known;
  }

  const matches = all.filter((d) => (selector === "testnet" ? d.testnet : !d.testnet));
  if (matches.length !== 1) {
    throw new InvalidArgumentError(
      `"${selector}" matches ${matches.length} shipped networks. ` +
        `Set LUNYA_CHAIN_ID, or pass a chain id.`
    );
  }
  return matches[0]!;
}

function address(env: Record<string, string | undefined>, key: string): Address | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  if (!isAddress(raw, { strict: false })) {
    throw new InvalidArgumentError(`${key} is not an address: "${raw}"`);
  }
  return getAddress(raw.toLowerCase());
}
