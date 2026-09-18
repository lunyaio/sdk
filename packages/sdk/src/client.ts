import {
  createPublicClient,
  http,
  defineChain,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
  type Hash,
} from "viem";

import { DEPLOYMENTS } from "./generated/deployments.js";
import { NotConfiguredError, InvalidArgumentError } from "./errors.js";
import type { Deployment, DexAddresses, LaunchFactoryAddresses, TransactionRequest } from "./types.js";

/*//////////////////////////////////////////////////////////////
                        Deployments
//////////////////////////////////////////////////////////////*/

export { DEPLOYMENTS };

/** Every deployment on a chain. Usually one, but the scheme allows more. */
export const deploymentsByChainId = (chainId: number): Deployment[] =>
  (DEPLOYMENTS as readonly Deployment[]).filter((d) => d.chainId === chainId);

/**
 * The deployment on a chain, when there is exactly one.
 *
 * THROWS ON AMBIGUITY rather than picking. One chain could in principle host
 * more than one deployment, and silently returning whichever came first in a
 * generated file is how an integration routes to the wrong set of contracts
 * while looking entirely correct. Use `deploymentsByChainId` and choose.
 */
export function deploymentByChainId(chainId: number): Deployment | undefined {
  const matches = deploymentsByChainId(chainId);
  if (matches.length > 1) {
    throw new InvalidArgumentError(
      `chain ${chainId} hosts ${matches.length} Lunya deployments. ` +
        `Use deploymentsByChainId() and choose.`
    );
  }
  return matches[0];
}

/**
 * Canonical Multicall3, at the same address on every chain that has it.
 *
 * Declared unconditionally, because viem REFUSES `multicall` outright on a
 * chain whose config omits it — and a batched read is the difference between
 * one round trip and fifty. Where the contract is genuinely absent, as on a
 * fresh local node, `internal/multicall` notices and re-runs the batch
 * deployless, so the optimism costs one probe rather than every read.
 */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * A viem `Chain` for a deployment, so an integrator does not have to hand-write
 * one for a chain their wallet library has never heard of.
 */
export function chainOf(deployment: Deployment): Chain {
  return defineChain({
    contracts: { multicall3: { address: MULTICALL3 } },
    id: deployment.chainId,
    name: deployment.name,
    nativeCurrency: {
      name: deployment.native.symbol,
      symbol: deployment.native.symbol,
      // Every EVM native is eighteen, whatever the ERC-20 alongside it counts in.
      decimals: 18,
    },
    rpcUrls: { default: { http: deployment.rpcUrl ? [deployment.rpcUrl] : [] } },
    blockExplorers: deployment.explorerUrl
      ? { default: { name: "Explorer", url: deployment.explorerUrl } }
      : undefined,
    testnet: deployment.testnet,
  });
}

/*//////////////////////////////////////////////////////////////
                          Client
//////////////////////////////////////////////////////////////*/

/**
 * How you say which network you mean.
 *
 *   "mainnet"     the production network
 *   "testnet"     the public test network
 *   5042002       a chain id
 *   { … }         a whole Deployment — a local node, or one newer than this SDK
 *
 * The two words exist because a chain id is something you have to already know.
 * `"mainnet"` is Arc mainnet and `"testnet"` Arc's public test network; either
 * refuses rather than guesses if a version ever lists two of a kind.
 */
export type DeploymentSelector = "mainnet" | "testnet" | number | Deployment;

export type LunyaClientConfig = {
  /** Which network. See `DeploymentSelector`. */
  deployment: DeploymentSelector;
  /**
   * How to reach the chain. Supply your own to use a private endpoint, an
   * archive node or a rate-limited key — the shipped `rpcUrl` is a public
   * endpoint and should not be leaned on in production.
   */
  transport?: Transport;
  /** Bring your own client, e.g. the one wagmi already made. Wins over `transport`. */
  publicClient?: PublicClient;
  /** Only needed for `client.send()`. Everything else returns unsigned calls. */
  walletClient?: WalletClient;
  /**
   * Override individual addresses. Merged over the deployment's, so a partial
   * object is fine — this is how you point at a freshly redeployed router
   * without waiting for an SDK release.
   */
  addresses?: {
    dex?: Partial<DexAddresses>;
    launchFactory?: Partial<LaunchFactoryAddresses>;
    pairToken?: Address;
  };
  /**
   * Extra hops a route may pass through, beyond the pair token.
   *
   * Routing here is deliberately small: a pool per pair, or one hop through the
   * hub. Anything cleverer is an aggregator's job, and an SDK that pretended
   * otherwise would quietly return worse prices than the caller could get.
   */
  routeThrough?: Address[];
};

export type LunyaClient = {
  deployment: Deployment;
  chain: Chain;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  routeThrough: Address[];

  /** Resolved addresses. Throws by name rather than encoding a call to `undefined`. */
  dexAddress: <K extends keyof DexAddresses>(key: K) => NonNullable<DexAddresses[K]>;
  launchFactoryAddress: () => Address;
  pairToken: () => Address;
  /** Whether a product is present, for feature-gating without a try/catch. */
  has: (what: "dex" | "launchpad") => boolean;

  /**
   * Sign and broadcast one of the calls this SDK built.
   *
   * Requires a `walletClient`. Approvals carried on the request are NOT sent —
   * an SDK that silently signed a second transaction would be doing something
   * the caller did not ask for. Send them yourself, or use `sendAll`.
   */
  send: (request: TransactionRequest) => Promise<Hash>;
  /** The approvals first, then the call, in order, waiting for each receipt. */
  sendAll: (request: TransactionRequest) => Promise<Hash[]>;
};

export function createLunyaClient(config: LunyaClientConfig): LunyaClient {
  const deployment = resolveDeployment(config);
  const chain = chainOf(deployment);

  const publicClient =
    config.publicClient ??
    createPublicClient({
      chain,
      transport: config.transport ?? defaultTransport(deployment),
    });

  const dex = deployment.dex;
  const launchFactory = deployment.launchFactory;

  const dexAddress = <K extends keyof DexAddresses>(key: K): NonNullable<DexAddresses[K]> => {
    const value = dex?.[key];
    if (value === null || value === undefined) throw new NotConfiguredError(`dex.${String(key)}`);
    return value as NonNullable<DexAddresses[K]>;
  };

  const launchFactoryAddress = (): Address => {
    if (!launchFactory?.address) throw new NotConfiguredError("launch factory");
    return launchFactory.address;
  };

  const pairToken = (): Address => {
    if (!deployment.pairToken) throw new NotConfiguredError("pairToken");
    return deployment.pairToken;
  };

  const send = async (request: TransactionRequest): Promise<Hash> => {
    const wallet = config.walletClient;
    if (!wallet) {
      throw new InvalidArgumentError(
        "send() needs a walletClient. Every builder in this SDK returns an unsigned " +
          "{ to, data, value } — pass it to whatever signer you already have."
      );
    }
    const account = wallet.account;
    if (!account) throw new InvalidArgumentError("the walletClient has no account attached");
    return wallet.sendTransaction({
      account,
      chain,
      to: request.to,
      data: request.data,
      value: request.value,
    });
  };

  const sendAll = async (request: TransactionRequest): Promise<Hash[]> => {
    const hashes: Hash[] = [];
    for (const approval of request.approvals ?? []) {
      const { buildApproval } = await import("./internal/erc20.js");
      const hash = await send(buildApproval(approval));
      await publicClient.waitForTransactionReceipt({ hash });
      hashes.push(hash);
    }
    const hash = await send(request);
    await publicClient.waitForTransactionReceipt({ hash });
    hashes.push(hash);
    return hashes;
  };

  return {
    deployment,
    chain,
    publicClient,
    walletClient: config.walletClient,
    routeThrough: config.routeThrough ?? (deployment.pairToken ? [deployment.pairToken] : []),
    dexAddress,
    launchFactoryAddress,
    pairToken,
    has: (what) =>
      what === "dex"
        ? Boolean(dex?.swapRouter && dex.quoter && dex.factory)
        : Boolean(launchFactory?.address),
    send,
    sendAll,
  };
}

/*//////////////////////////////////////////////////////////////
                          Internals
//////////////////////////////////////////////////////////////*/

const describeKnown = () =>
  (DEPLOYMENTS as readonly Deployment[]).map((d) => `${d.name} (${d.chainId})`).join(", ");

/** The production deployments. Empty until there is one. */
export const mainnetDeployments = (): Deployment[] =>
  (DEPLOYMENTS as readonly Deployment[]).filter((d) => !d.testnet);

/** The public test deployments. */
export const testnetDeployments = (): Deployment[] =>
  (DEPLOYMENTS as readonly Deployment[]).filter((d) => d.testnet);

function resolveByKind(kind: "mainnet" | "testnet"): Deployment {
  const matches = kind === "mainnet" ? mainnetDeployments() : testnetDeployments();

  if (matches.length === 0) {
    const alternatives = describeKnown();
    throw new InvalidArgumentError(
      kind === "mainnet"
        ? `this version of the SDK lists no mainnet deployment. Known: ${alternatives}. ` +
          `Pass a Deployment yourself.`
        : `this version of the SDK knows no public test network. Known: ${alternatives}.`
    );
  }
  // Ambiguity is refused rather than guessed, for the same reason
  // `deploymentByChainId` refuses it: picking one silently is how an
  // integration ends up on contracts it did not choose.
  if (matches.length > 1) {
    throw new InvalidArgumentError(
      `"${kind}" is ambiguous — ${matches.length} networks match ` +
        `(${matches.map((d) => `${d.name} / ${d.chainId}`).join(", ")}). Give a chain id.`
    );
  }
  return matches[0]!;
}

function resolveDeployment(config: LunyaClientConfig): Deployment {
  const selector = config.deployment;

  if (selector === "mainnet" || selector === "testnet") {
    return applyOverrides(resolveByKind(selector), config);
  }

  const base = typeof selector === "number" ? deploymentByChainId(selector) : selector;

  if (!base) {
    throw new InvalidArgumentError(
      `no Lunya deployment on chain ${String(selector)}. This SDK knows: ${describeKnown()}, ` +
        `plus the aliases "mainnet" and "testnet". ` +
        `Pass a whole Deployment object for a network it does not know about.`
    );
  }

  return applyOverrides(base, config);
}

function applyOverrides(base: Deployment, config: LunyaClientConfig): Deployment {
  const overrides = config.addresses;
  if (!overrides) return base;

  return {
    ...base,
    pairToken: overrides.pairToken ?? base.pairToken,
    dex: base.dex || overrides.dex ? ({ ...base.dex, ...overrides.dex } as DexAddresses) : null,
    launchFactory:
      base.launchFactory || overrides.launchFactory
        ? ({ ...base.launchFactory, ...overrides.launchFactory } as LaunchFactoryAddresses)
        : null,
  };
}

function defaultTransport(deployment: Deployment): Transport {
  if (!deployment.rpcUrl) {
    throw new InvalidArgumentError(
      `${deployment.name} ships no public RPC URL — pass a \`transport\`.`
    );
  }
  return http(deployment.rpcUrl);
}
