import { launchAbi, launchFactoryAbi } from "../generated/abis.js";
import { eventNamed } from "../internal/events.js";

/**
 * The launchpad's events, as ABI items for your own `watchEvent` or `getLogs`.
 *
 * Exported rather than wrapped, like the DEX's `poolCreatedEvent`: how you
 * index — a websocket, polled logs, a backfill, a queue — is your
 * infrastructure, and nothing here needs to own it.
 *
 * WHO EMITS WHAT decides the filter. `launchCreatedEvent` comes from the
 * FACTORY, so one address covers every launch there will ever be. The other
 * three come from each LAUNCH: filter on the launches you track. A log from an
 * address you did not take from the factory is not a launch until `isLaunch`
 * says so — anybody can emit an event with the same signature.
 */

/**
 * A launch was created. Emitted by the factory, once per launch.
 *
 * `launch` is what you call and `token` what you hold; `quoteToken` is what the
 * curve prices in, and `launchParams` the per-launch parameters as the creation
 * passed them. Read the launch before buying on it: the anti-snipe window
 * counts from its `openedAt`.
 */
export const launchCreatedEvent = eventNamed(launchFactoryAbi, "LaunchCreated");

/**
 * A buy or a sell on one launch.
 *
 * `trader` is whose balance in the launched token moved — the RECIPIENT of a
 * buy, the SELLER of a sell, on whoever's behalf it was sent. `quoteAmount` is
 * the change in the curve's reserve, in quote-token units, whichever entry point
 * paid: a native buy and an ERC-20 buy of the same size log the same. `reserve`
 * and `sold` are the curve after the trade, so a launch can be followed from its
 * logs alone.
 */
export const tradeEvent = eventNamed(launchAbi, "Trade");

/**
 * The curve filled. `reserve` is what it raised.
 *
 * Emitted by the buy that filled it, and that same transaction graduates the
 * launch — `graduatedEvent` follows in it.
 */
export const curveCompletedEvent = eventNamed(launchAbi, "CurveCompleted");

/**
 * The raise went into a pool.
 *
 * `pool` is where the token now trades, `tokenId` the locked position, and
 * `quoteSeeded` / `tokensSeeded` the amounts actually deposited — not the amounts
 * offered. From this log on, price the token with `dex`.
 */
export const graduatedEvent = eventNamed(launchAbi, "Graduated");
