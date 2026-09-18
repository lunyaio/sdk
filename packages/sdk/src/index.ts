/**
 * @lunya/sdk — integrate the Lunya exchange and launchpad.
 *
 * ```ts
 * import { createLunyaClient, dex, launchpad } from "@lunya/sdk";
 *
 * const client = createLunyaClient({ deployment: "testnet" });
 *
 * const { quote, transaction } = await dex.buildSwap(client, {
 *   tokenIn, tokenOut, amountIn: 1_000000n, slippageBps: 50, recipient,
 * });
 * // `transaction` is an unsigned { to, data, value } — hand it to any signer.
 * ```
 *
 * THREE THINGS THAT SURPRISE PEOPLE, stated once here because each of them
 * costs an afternoon:
 *
 * 1. **Writes return unsigned calls, they do not send.** Your signer is a wagmi
 *    hook, an ethers Wallet, a KMS or a Safe proposal, and an SDK that owned
 *    `sendTransaction` would serve exactly one of them. `client.send()` exists
 *    for when a viem WalletClient really is what you have.
 *
 * 2. **The DEX is Uniswap-V3-shaped but not Uniswap-V3-compatible.** The events
 *    are identical, so your indexing works unchanged. The periphery is not:
 *    the callbacks are `lunya*`, a path's middle field is a one-byte pool type
 *    rather than a three-byte fee, and pools are keyed on a curve rather than a
 *    fee tier. Route through this SDK, never a V3 router.
 *
 * 3. **A launch stops being a launch.** Once it graduates, its liquidity is in
 *    an ordinary CP pool and the curve answers zero rather than erroring. Price
 *    a graduated token with `dex`, not with `launchpad`.
 *
 * ADDRESSES SHIP for every network listed — Arc mainnet and Arc's public test
 * network — as they were when this version was cut. `addresses` on the client,
 * or `deploymentFromEnv()`, overrides any of them: a fork, your own deployment,
 * or contracts newer than this version.
 *
 * SCOPE. Trading: quoting, swapping, limit orders, and buying and selling on
 * the bonding curve, with the pool data to price locally and the events to
 * follow it live. No liquidity provision, no farming, no pool creation, no
 * launching, no graduating — this package is for trading bots and aggregators,
 * and none of those is trading. It ships the ABIs of the contracts trading
 * touches.
 */

/*//////////////////////////////////////////////////////////////
                          The client
//////////////////////////////////////////////////////////////*/

export {
  createLunyaClient,
  chainOf,
  deploymentByChainId,
  deploymentsByChainId,
  mainnetDeployments,
  testnetDeployments,
  DEPLOYMENTS,
  type LunyaClient,
  type LunyaClientConfig,
  type DeploymentSelector,
} from "./client.js";

/*//////////////////////////////////////////////////////////////
                          Products
//////////////////////////////////////////////////////////////*/

export { deploymentFromEnv, type FromEnvOptions } from "./env.js";

export * as dex from "./dex/index.js";
export * as launchpad from "./launchpad/index.js";

/*//////////////////////////////////////////////////////////////
                            Types
//////////////////////////////////////////////////////////////*/

export {
  PoolType,
  POOL_TYPES,
  poolTypeLabel,
  hasTicks,
  FeeToken,
  LaunchType,
  LaunchPhase,
  launchPhaseLabel,
  type Deployment,
  type DexAddresses,
  type LaunchFactoryAddresses,
  type NativeInfo,
  type TransactionRequest,
  type ApprovalRequest,
  type Hop,
  type Route,
  type Quote,
  type SlippageOptions,
  type Launch,
} from "./types.js";

/*//////////////////////////////////////////////////////////////
                            Errors
//////////////////////////////////////////////////////////////*/

export {
  LunyaError,
  NotConfiguredError,
  NoRouteError,
  InvalidArgumentError,
  decodeLunyaRevert,
  explainLunyaError,
  type DecodedRevert,
} from "./errors.js";

/*//////////////////////////////////////////////////////////////
                       Maths and encoding
//////////////////////////////////////////////////////////////*/

/**
 * Exact-integer arithmetic and the route encoding.
 *
 * Exported because an integration that builds its own calls still needs the
 * same numbers, and because `encodePath` is the single easiest thing to get
 * wrong when coming from Uniswap.
 */
export {
  Q96,
  Q128,
  MIN_TICK,
  MAX_TICK,
  NO_PRICE_LIMIT,
  sqrtRatioAtTick,
  tickAtSqrtRatio,
  minusSlippage,
  plusSlippage,
  defaultDeadline,
} from "./internal/math.js";

export { encodePath, decodePath, reversePath } from "./internal/path.js";

/*//////////////////////////////////////////////////////////////
                            ERC-20
//////////////////////////////////////////////////////////////*/

export {
  buildApproval,
  readTokenMetadata,
  readAllowance,
  readBalance,
  pendingApprovals,
  buildPermitTypedData,
  type TokenMetadata,
  type PermitTypedData,
} from "./internal/erc20.js";

/*//////////////////////////////////////////////////////////////
                             ABIs
//////////////////////////////////////////////////////////////*/

/**
 * The contracts trading touches — pool factory, deployer, CL/CP pool, STABLE
 * pool, the pool plugin, router, quoter, launch factory, launch.
 *
 * Generated from the contract build artifacts rather than transcribed, so a
 * struct that grows a field cannot silently produce calldata the contract never
 * agreed to. Each is kept whole, so an event filter or a read this package does
 * not wrap is still available to you.
 */
export { abis, type AbiName } from "./generated/abis.js";
