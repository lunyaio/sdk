import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";

import { abis } from "./generated/abis.js";

/*//////////////////////////////////////////////////////////////
                        SDK-side errors
//////////////////////////////////////////////////////////////*/

export class LunyaError extends Error {
  override name = "LunyaError";
}

/** A deployment does not run the piece you asked for, or you configured no address for it. */
export class NotConfiguredError extends LunyaError {
  override name = "NotConfiguredError";
  constructor(what: string) {
    super(
      `${what} is not configured for this deployment. ` +
        `Pass it explicitly via \`addresses\`, or pick a deployment that runs it.`
    );
  }
}

/** No pool of any type exists for a pair, so there is nothing to price against. */
export class NoRouteError extends LunyaError {
  override name = "NoRouteError";
  constructor(tokenIn: string, tokenOut: string) {
    super(
      `no route from ${tokenIn} to ${tokenOut}. ` +
        `No pool exists for the pair on any curve, and no hub route was configured.`
    );
  }
}

export class InvalidArgumentError extends LunyaError {
  override name = "InvalidArgumentError";
}

/*//////////////////////////////////////////////////////////////
                      Revert decoding
//////////////////////////////////////////////////////////////*/

/**
 * Every custom error the protocol can revert with, in one table.
 *
 * The reason this is worth having: a revert from a pool reaches an integrator
 * through the router, and viem can only name it if the ABI it was given happens
 * to declare it — which the router's ABI does not, for a pool's errors. Decoding
 * against the union turns `0x2c5211c6` back into `ZeroAmount` regardless of
 * which contract in the stack actually threw.
 */
const ERROR_ABI = Object.values(abis).flatMap((abi) =>
  (abi as readonly { type: string }[]).filter((e) => e.type === "error")
);

export type DecodedRevert = {
  /** The custom error's name, e.g. `SlippageExceeded`. */
  name: string;
  args: readonly unknown[];
  /** What it means and what usually causes it, where we know. */
  hint?: string;
};

/**
 * What the protocol's errors actually mean.
 *
 * Written here rather than left to the contracts' NatSpec because the audience
 * differs: a comment in Solidity explains a decision to a reviewer, and this
 * explains a failure to somebody whose transaction just reverted and who has no
 * intention of reading Solidity.
 */
/**
 * Keyed by error name. Every key must be an error some shipped ABI declares —
 * a test holds it to that, because a hint for an error the contracts no longer
 * throw is a hint nobody will ever see, left explaining a protocol that is gone.
 *
 * @internal Exported for that test, not from the package.
 */
export const HINTS: Record<string, string> = {
  // ---- Launchpad
  SlippageExceeded:
    "The curve moved between quoting and executing — or the quote assumed a smaller anti-snipe surcharge than this recipient pays. Re-quote with quoteBuyFor, or raise your tolerance.",
  WrongPhase:
    "The launch is not trading. The buy that fills a curve graduates it on the spot; from then on the token trades on the DEX.",
  MoreThanSold:
    "The sell is larger than everything the curve has sold, which is more than anybody can hold. The amount is wrong.",
  NativeNotAccepted:
    "This launch does not take the gas coin (`nativeDivisor` is zero). Use the quote-token entry points.",
  Expired: "The deadline passed before the transaction was mined. Build a fresh one.",
  ZeroAmount: "The amount was zero.",
  // ---- DEX periphery
  TooLittleReceived:
    "The swap would deliver less than `amountOutMinimum`. Re-quote, or raise your slippage tolerance.",
  TooMuchRequested: "The swap would cost more than `amountInMaximum`.",
  AmountOutOfRange: "An amount above int256 max changes the meaning of the swap, so it is refused.",
  InvalidPath:
    "The path is malformed. It is token | poolType (1 byte) | token, repeated — not a Uniswap V3 path with a 3-byte fee. Build it with `encodePath`.",
  NotAPool: "No pool of that type exists for the pair.",
  NoNativeWrapper:
    "This chain has no wrapped native token, so nothing can be wrapped or unwrapped. Trade the ERC-20.",
  UnexpectedNative: "The gas coin was sent to something that does not take it.",
  // ---- Pools, every type
  Locked:
    "The pool is not initialised yet, or is mid-call — the second is almost always a reentrant call from a token with a transfer hook.",
  // ---- Limit orders (the pool's plugin)
  NotFilling:
    "This plugin is not filling orders: it is no longer the pool's plugin, or the pool does not call it after swaps. Cancel and claim still work on the plugin that holds an order.",
  PriceAlreadyPast:
    "The price is already at or past the fill tick, so the order would open half-converted and fill at once. Pick a tick beyond the price.",
  TickNotOnSpacing: "The fill tick is not a multiple of the pool's tick spacing.",
  NotAConcentratedPool: "Limit orders need a CL pool: a CP pool holds only the full range, and a STABLE pool has no ticks.",
  SpacingChangedUnderBatch:
    "The batch resting at this tick opened under a different tick spacing, so it cannot take this order.",
  NotYours:
    "Nothing of yours to cancel or claim there: more than you rest, a batch that already filled (claim it instead), or a share already claimed.",
  NotSettled: "That batch has not settled. If the price has already crossed it, pokeOrders settles it.",
  // ---- STABLE pools
  InsufficientReserve:
    "A STABLE pool cannot pay an exact output that is not less than the reserve paying it. Ask for less.",
  PriceOutOfRange:
    "The STABLE curve was asked for a price it cannot represent — usually a zero or extreme price limit.",
};

/**
 * Pull a protocol error out of whatever viem threw.
 *
 * Returns null for anything that is not a contract revert — a dropped
 * connection is not a protocol error, and reporting it as one sends people
 * looking in the wrong place.
 */
export function decodeLunyaRevert(error: unknown): DecodedRevert | null {
  // viem names the error itself when the ABI it was called with declares it,
  // which is the common case for a direct call. Take that and only add the hint.
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    const named = (reverted as ContractFunctionRevertedError | null)?.data?.errorName;
    if (named) {
      const args = ((reverted as ContractFunctionRevertedError).data?.args ?? []) as readonly unknown[];
      return { name: named, args, hint: HINTS[named] };
    }
  }

  // Otherwise the revert came from deeper in the stack — a pool's error surfacing
  // through the router — and only the union can name it.
  const data = revertData(error);
  if (!data || data === "0x") return null;

  try {
    const decoded = decodeErrorResult({ abi: ERROR_ABI as never, data });
    return {
      name: decoded.errorName,
      args: (decoded.args ?? []) as readonly unknown[],
      hint: HINTS[decoded.errorName],
    };
  } catch {
    return null;
  }
}

/**
 * A one-line explanation of a failed call, for a log or a toast.
 *
 * Falls back to viem's own short message rather than to "unknown error": a
 * revert we cannot name is still a revert somebody has to act on.
 */
export function explainLunyaError(error: unknown): string {
  const decoded = decodeLunyaRevert(error);
  if (decoded) {
    const args = decoded.args.length ? `(${decoded.args.map(String).join(", ")})` : "";
    return decoded.hint ? `${decoded.name}${args}: ${decoded.hint}` : `${decoded.name}${args}`;
  }
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

/** The raw revert bytes, dug out of whichever layer of viem's error chain carries them. */
function revertData(error: unknown): Hex | null {
  if (!(error instanceof BaseError)) return null;

  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  const raw = (reverted as unknown as { raw?: Hex } | null)?.raw;
  if (raw) return raw;

  const walked = error.walk((e) => typeof (e as { data?: unknown }).data === "string");
  const data = (walked as { data?: unknown } | null)?.data;
  return typeof data === "string" && data.startsWith("0x") ? (data as Hex) : null;
}
