/**
 * The launchpad.
 *
 * ONE CONTRACT PER LAUNCH, cloned by a factory — the same shape the pool factory
 * uses for pools. So a launch has an address of its own, distinct from the token
 * it sells, and that address is what you call. `getLaunchByToken` is the hop for
 * a caller who only has the token.
 *
 * THE CURVE IS PRICED IN A QUOTE TOKEN, not necessarily the gas coin. Paying
 * with the gas coin is a separate entry point that exists only where the launch
 * was set up for it — see `nativeDivisor`.
 *
 * A launch opens in Trading and ends in Graduated, and the constant-product
 * launch goes straight from one to the other:
 *
 *   Trading     — the curve is open. buy/sell work.
 *   Graduated   — the liquidity is in a pool and locked forever. From here the
 *                 token is an ordinary DEX asset: price it with
 *                 `dex.getBestQuote`, not with anything in this module.
 *
 * THE BUY THAT FILLS THE CURVE GRADUATES IT, in the same transaction — it opens
 * the pool, mints and locks the position, and pays the graduation reward to
 * whoever SENT the buy. `ReadyToGraduate` is still in the enum for launch types
 * that may take two steps; this one never reports it.
 *
 * ANTI-SNIPE. For its first `snipeWindow` seconds a launch charges buys a
 * decaying surcharge on top of the curve fee, keyed on the RECIPIENT — the
 * creator and anyone the creator exempted pay none. `quoteBuy` answers for a
 * recipient that is not exempt; `quoteBuyFor` answers exactly.
 *
 * That last transition is the one that catches integrations out. A screen that
 * prices a graduated token off the curve shows a number nobody can trade at,
 * and `quoteBuy` answers zero rather than erroring — so check the phase.
 *
 * BUY AND SELL, AND NOTHING ELSE. Creating a launch and graduating one are both
 * out of scope — neither is trading. See `trade.ts` for the honest note on what
 * that does and does not achieve.
 */

export {
  getLaunch,
  getLaunchByToken,
  getLaunches,
  listLaunches,
  listTokens,
  isLaunch,
  predictLaunch,
  LaunchPhase,
  LaunchType,
} from "./launches.js";

export {
  buildBuy,
  buildBuyWithNative,
  buildSell,
  buildSellForNative,
  quoteBuy,
  quoteBuyFor,
  currentSnipeTaxBps,
  isExempt,
  quoteBuyWithNative,
  quoteSell,
  quoteSellForNative,
  type TradeOptions,
} from "./trade.js";

/**
 * The events, for your own log filters: new launches from the factory, trades,
 * a filled curve and a graduation from each launch. See `events.ts` for which
 * address emits which.
 */
export {
  launchCreatedEvent,
  tradeEvent,
  curveCompletedEvent,
  graduatedEvent,
} from "./events.js";

/**
 * The curve, off-chain.
 *
 * Namespaced rather than flattened, because `curve.quoteBuy` and the contract's
 * `quoteBuy` are different calls with the same answer, and an integrator ought
 * to be able to see which one they picked at the call site.
 */
export * as curve from "./curve.js";

export { type Launch } from "../types.js";
