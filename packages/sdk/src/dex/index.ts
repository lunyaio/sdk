/**
 * The exchange.
 *
 * WHAT CARRIES OVER FROM UNISWAP V3, since that is what most integrators
 * already know:
 *
 *   Identical — `swap`, `mint`, `burn`, `collect`, `flash`, `initialize`
 *   signatures on the pool, and the `Initialize`/`Mint`/`Burn`/`Collect`/`Swap`/
 *   `Flash` events. Existing indexing works unchanged, which is deliberate.
 *
 *   Different — the callbacks are `lunya*`, not `uniswapV3*`. There is no
 *   `fee()`; `feeInfo()` returns `(fee, isDynamic)`. `slot0()` has five fields,
 *   not seven, and the same five on every pool type. There are no fee tiers:
 *   `createPool(tokenA, tokenB, poolType)`. Pool addresses are CREATE2 from the
 *   DEPLOYER, not the factory. The TWAP is a plugin, not part of the pool.
 *
 * So: route through this periphery, never a V3 router; derive addresses from
 * the deployer and read the init code hash from the chain; and reuse your
 * indexing as-is.
 *
 * DISCOVERY IS YOURS. The factory has no enumeration, so `discovery.ts` gives
 * you the two things that replace it — offline CREATE2 derivation, and batched
 * existence checks against the factory. Neither calls a hosted service: an
 * aggregator should not have anyone else's uptime in its critical path.
 */

export {
  PoolType,
  getPool,
  getPairPools,
  getPoolState,
  computePoolAddress,
  sortTokens,
  isToken0,
  priceFromSqrtX96,
  type PairPool,
  type PoolState,
  type StablePoolState,
  getCurrentFee,
} from "./pools.js";
export { getTicks, type PopulatedTick } from "./ticks.js";
export {
  orderRange,
  orderAmount,
  orderLiquidity,
  buildPlaceOrder,
  buildCancelOrder,
  buildClaimOrder,
  buildPokeOrders,
  orderBatchKey,
  getOrderBatch,
  getOrder,
  orderPlacedEvent,
  orderCancelledEvent,
  ordersFilledEvent,
  orderClaimedEvent,
  settlementIncompleteEvent,
  type Order,
} from "./orders.js";

export {
  getInitCodeHashes,
  forgetInitCodeHashes,
  poolAddress,
  poolAddressFn,
  findPools,
  poolCreatedEvent,
  type InitCodeHashes,
  type FoundPool,
  type FindPoolsOptions,
} from "./discovery.js";

export {
  findRoutes,
  quoteRoute,
  quoteRouteExactOut,
  getBestQuote,
  getBestQuoteExactOut,
  type QuoteOptions,
} from "./quote.js";

export {
  buildSwap,
  buildSwapFromQuote,
  buildSwapExactOut,
  buildSwapExactOutFromQuote,
  type SwapOptions,
} from "./swap.js";
