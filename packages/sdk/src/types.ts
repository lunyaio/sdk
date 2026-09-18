import type { Address, Hex } from "viem";

/*//////////////////////////////////////////////////////////////
                          Pool types
//////////////////////////////////////////////////////////////*/

/**
 * The three curves one core serves, spelled the way the factory's enum orders
 * them.
 *
 * The type travels as a `uint8` in every periphery call — the factory keys
 * pools on `(tokenA, tokenB, poolType)`, and the router, quoter and position
 * manager all carry it rather than resolving an address themselves. There is no
 * fee tier: a pool's fee lives on the pool.
 */
export const PoolType = { CL: 0, CP: 1, STABLE: 2 } as const;
export type PoolType = (typeof PoolType)[keyof typeof PoolType];

export const POOL_TYPES: readonly PoolType[] = [PoolType.CL, PoolType.CP, PoolType.STABLE];

export const poolTypeLabel = (t: PoolType | number): string =>
  ({ 0: "CL", 1: "CP", 2: "STABLE" })[t as 0 | 1 | 2] ?? `unknown(${t})`;

/**
 * Whether a pool of this type holds liquidity AT ticks.
 *
 * STABLE does not: its `slot0().tick` is a derived measurement of where the
 * price sits, not a place anything is stored. Minting against a tick read off a
 * STABLE pool is the mistake this predicate exists to make hard.
 */
export const hasTicks = (t: PoolType): boolean => t !== PoolType.STABLE;

/**
 * Which coin a pool takes its fees in.
 *
 * `Paid`, what every pool is born with, takes the fee from whatever the trader
 * pays. `Token0` and `Token1` take it in that coin whichever way the trade goes —
 * from what the trader pays when they pay it, from what they receive when they
 * receive it. A pool setting the administrator can change at any time, so read
 * it rather than caching it. The quoter accounts for it; anything that prices a
 * pool itself has to.
 */
export const FeeToken = { Paid: 0, Token0: 1, Token1: 2 } as const;
export type FeeToken = (typeof FeeToken)[keyof typeof FeeToken];

/*//////////////////////////////////////////////////////////////
                         Deployments
//////////////////////////////////////////////////////////////*/

/**
 * Where the DEX is, on one chain.
 *
 * FOUR ADDRESSES, not the whole periphery. This package quotes and swaps, so it
 * needs the factory (to find a pool), the deployer (to derive one offline), the
 * router (to execute) and the quoter (to price). A pool's plugin, where limit
 * orders live, is read off the pool, and the tick lens is not needed —
 * `getTicks` reads the pool itself. The position manager, farming and vaults
 * belong to surfaces it does not cover, and carrying their addresses would
 * suggest otherwise.
 */
export type DexAddresses = {
  factory: Address | null;
  poolDeployer: Address | null;
  swapRouter: Address | null;
  quoter: Address | null;
  /** Where an indexer following these contracts should start. */
  startBlock: number;
};

export type LaunchFactoryAddresses = {
  /**
   * The factory that clones launches.
   *
   * Named for what it is: launches used to live inside one contract keyed by
   * token, and each is now its own contract cloned from here. Code that reached
   * for a "launchpad address" and called `buy` on it is calling a factory.
   */
  address: Address | null;
  startBlock: number;
};

export type NativeInfo = {
  symbol: string;
  decimals: number;
  isUsd: boolean;
  /**
   * Whether the gas coin has an ERC-20 wrapper.
   *
   * FALSE ON SOME CHAINS, where the gas coin IS an ERC-20 and the two balances
   * are one balance seen at two decimal scales. With no wrapper the coin cannot
   * be spent by value through the router — paying that way sends it to a
   * `receive` with nothing to convert it with — so every trade is an ERC-20
   * trade. Check this before offering a "pay with the native coin" toggle.
   */
  hasWrapper: boolean;
};

/**
 * Where Lunya is, on one chain.
 *
 * Keyed on the chain, because that is the only identity that means anything
 * outside: a chain id is a fact anybody can check, and any other name would be
 * one you had to be told.
 */
export type Deployment = {
  chainId: number;
  /** Human-readable, for a UI. */
  name: string;
  /** A public endpoint, where one exists. Null means you must supply a transport. */
  rpcUrl: string | null;
  explorerUrl: string | null;
  /** A public test network. False means production. */
  testnet: boolean;
  native: NativeInfo;
  /** The ERC-20 every launch pairs against, and the hub of the default routes. */
  pairToken: Address | null;
  /** The wrapper, where there is one. Equal to `pairToken` on wrapping chains. */
  wrappedNative: Address | null;
  dex: DexAddresses | null;
  launchFactory: LaunchFactoryAddresses | null;
};

/*//////////////////////////////////////////////////////////////
                        Transactions
//////////////////////////////////////////////////////////////*/

/**
 * An unsigned call, ready for any signer.
 *
 * Every write in this SDK returns one of these rather than sending it. That is
 * deliberate: an integrator's signer is a wagmi hook, an ethers Wallet, a KMS,
 * a Safe proposal or a queue, and an SDK that owned `sendTransaction` would
 * serve exactly one of them. `client.send()` is offered on top for the case
 * where a viem WalletClient is genuinely what you have.
 */
export type TransactionRequest = {
  to: Address;
  data: Hex;
  /** Native coin to attach. Always 0n where the chain has no wrapper. */
  value: bigint;
  /**
   * Approvals this call needs before it can succeed, in order.
   *
   * Carried WITH the call rather than left for the caller to work out, because
   * "why did my swap revert" is almost always this, and the answer is knowable
   * at build time. Empty when the spend is native or already approved is not
   * something we checked — see `dex.ensureAllowance` for the checked version.
   */
  approvals?: ApprovalRequest[];
  /** What this call does, for a confirmation screen or a log line. */
  description?: string;
};

export type ApprovalRequest = {
  token: Address;
  spender: Address;
  amount: bigint;
};

/*//////////////////////////////////////////////////////////////
                          Trading
//////////////////////////////////////////////////////////////*/

/** One pool a route crosses. */
export type Hop = {
  tokenIn: Address;
  tokenOut: Address;
  poolType: PoolType;
  /** The pool's address, when it was resolved. */
  pool?: Address;
};

export type Route = {
  hops: Hop[];
  /**
   * The encoded path, present only for a multi-hop route.
   *
   * `token(20) | poolType(1) | token(20) | …` — NOT Uniswap's layout, where a
   * fee is three bytes. A path built to the familiar shape is rejected by
   * `Path.sol`, or worse, parsed into a different pool.
   */
  path?: Hex;
};

export type Quote = Route & {
  amountIn: bigint;
  amountOut: bigint;
  /** The first hop's pool fee, in hundredths of a bip (1e6 = 100%). */
  feeAmount: number;
  /**
   * What the quote actually fills, for an exact-output quote cut short by a
   * price limit. Equal to the requested amount otherwise. A caller comparing
   * routes has to see this, or it picks one that cannot fill.
   */
  amountOutReceived?: bigint;
};

export type SlippageOptions = {
  /**
   * Tolerance in basis points. 50 = 0.5%.
   *
   * There is no default: a slippage an SDK chose is a slippage nobody chose,
   * and the number decides how much value a sandwich can take. Callers state it.
   */
  slippageBps: number;
  /** Unix seconds. Defaults to 20 minutes from now at build time. */
  deadline?: bigint;
  recipient?: Address;
};

/*//////////////////////////////////////////////////////////////
                         Launchpad
//////////////////////////////////////////////////////////////*/

/**
 * The kinds of launch the factory can clone.
 *
 * One exists today: the constant-product curve. The value is what the factory's
 * `predictLaunch` and `implementationOf` take.
 */
export const LaunchType = { ConstantProduct: 1 } as const;
export type LaunchType = (typeof LaunchType)[keyof typeof LaunchType];

/**
 * Where a launch is in its life.
 *
 * THE CONSTANT-PRODUCT LAUNCH GOES STRAIGHT FROM `Trading` TO `Graduated`: the
 * buy that fills its curve opens the pool in the same transaction, so there is
 * no frozen in-between to wait out. `ReadyToGraduate` stays in the enum because
 * a future launch type may take two steps; this one never reports it.
 */
export const LaunchPhase = {
  None: 0,
  Trading: 1,
  ReadyToGraduate: 2,
  Graduated: 3,
} as const;
export type LaunchPhase = (typeof LaunchPhase)[keyof typeof LaunchPhase];

export const launchPhaseLabel = (p: LaunchPhase | number): string =>
  ({ 0: "none", 1: "trading", 2: "ready-to-graduate", 3: "graduated" })[p as 0 | 1 | 2 | 3] ??
  `unknown(${p})`;

/**
 * A launch, as its own contract holds it.
 *
 * ONE CONTRACT PER LAUNCH, cloned by the factory — the same shape the pool
 * factory uses for pools. So a launch has an ADDRESS OF ITS OWN, distinct from
 * the token it sells, and that address is what you trade against. `token` is
 * what you end up holding.
 */
export type Launch = {
  /** The launch contract. This is what `buy` and `sell` are called on. */
  address: Address;
  /** The ERC-20 the launch sells. */
  token: Address;
  /**
   * The ERC-20 the curve is priced and paid in.
   *
   * NOT necessarily the native coin. A launch quotes in whatever token it was
   * opened against, and paying with the gas coin is a separate entry point that
   * exists only where `nativeDivisor` is non-zero.
   */
  quoteToken: Address;
  creator: Address;
  phase: LaunchPhase;

  /** Curve state. The `virtual*` offsets give it a starting price with nothing in it. */
  virtualQuote: bigint;
  virtualToken: bigint;
  curveSupply: bigint;
  lpSupply: bigint;
  /** Quote tokens held by the curve. */
  reserve: bigint;
  /** Tokens sold off the curve so far. */
  sold: bigint;

  /**
   * The curve's own fee, in basis points. Snapshotted at creation.
   *
   * NOT THE WHOLE FEE while the anti-snipe window is open: a buy for a recipient
   * that is not exempt pays this plus a surcharge that decays to zero over
   * `snipeWindow` seconds. `curve.snipeTaxBps` computes it.
   */
  curveFeeBps: number;
  graduationFeeBps: number;
  graduationReward: bigint;

  /**
   * The anti-snipe surcharge: `snipeTaxBps` at the moment the launch opened,
   * falling as `(remaining / window) ^ snipeDecay` to zero after `snipeWindow`
   * seconds. A zero window or a zero tax means there is none.
   *
   * Charged on the RECIPIENT, not the sender — a buy routed through an
   * aggregator is taxed on who ends up holding. The creator, and any address the
   * creator listed at launch, is exempt.
   */
  snipeTaxBps: number;
  snipeWindow: number;
  snipeDecay: number;
  /** Unix seconds the curve opened at: where the anti-snipe window starts. */
  openedAt: bigint;

  /**
   * Native units per quote unit, or 0n where the gas coin cannot be spent here.
   *
   * A launch quoting in a six-decimal token on an eighteen-decimal chain has
   * 1e12. Zero means `buyWithNative` and `sellForNative` will revert, and the
   * only way in is the ERC-20.
   */
  nativeDivisor: bigint;

  /** Derived: how far along the curve is, 0..1. */
  progress: number;
  /** Derived: spot price in quote units per whole (1e18) token. */
  price: bigint;
};
