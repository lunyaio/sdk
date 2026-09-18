/**
 * Batched reads that work whether or not the chain has Multicall3.
 *
 * viem's `multicall` needs the canonical contract at 0xcA11…CA11, and refuses
 * outright on a chain whose config does not declare it. So `chainOf` declares
 * it unconditionally, and this covers the case where the declaration turns out
 * to be a lie.
 *
 * THE FAILURE IT PREVENTS IS THE QUIET KIND. With `allowFailure: true`, which
 * is the default and what most callers use, a missing Multicall3 throws
 * nothing: every entry comes back `status: "failure"`, which is indistinguishable
 * from "that pool does not exist". A swap silently loses its routes, a board
 * silently loses every launch, and no error appears anywhere.
 *
 * viem can also run Multicall3 DEPLOYLESS, sending the contract's init code in
 * a plain `eth_call` so the batch works whether or not anybody deployed it.
 * That is not the default here: the bytecode is 5.6 KB on every request, and
 * against a chain that already has the contract that is bandwidth spent on a
 * problem it does not have.
 *
 * So the deployed path runs first, the deployless path covers for it, and the
 * verdict is remembered per chain — the probe is paid once per process.
 *
 * Takes a closure rather than the parameters, because that is what keeps viem's
 * return types intact: `run` is the real call, and the fallback is the same call
 * with one option added. Callers keep the tuple types they had.
 *
 *     const [a, b] = await batched(client, (extra) =>
 *       client.multicall({ contracts, allowFailure: false, ...extra })
 *     );
 */

type Mode = "deployed" | "deployless";

const mode = new Map<number, Mode>();

/** Forget a chain's verdict — for a node that gains the contract mid-session. */
export const forgetMulticallMode = (chainId: number): void => {
  mode.delete(chainId);
};

export async function batched<T>(
  /** Anything that knows its chain — the verdict is cached per chain id. */
  client: { chain?: { id: number } | null } | null | undefined,
  run: (extra: { deployless?: true }) => Promise<T>
): Promise<T> {
  const id = client?.chain?.id;
  if (id !== undefined && mode.get(id) === "deployless") return run({ deployless: true });

  let first: T | undefined;
  try {
    first = await run({});
    // Nothing succeeded: either the chain has no Multicall3, or the calls are
    // genuinely dead. The two are indistinguishable from here, so ask the other
    // way — once, and remember which it was.
    if (!allFailed(first)) {
      if (id !== undefined) mode.set(id, "deployed");
      return first;
    }
  } catch (error) {
    // `allowFailure: false` throws where the others report failures, and viem
    // throws outright when the chain declares no multicall3 at all. Both land
    // here and both are answered the same way.
    if (!isBatchable(error)) throw error;
  }

  const viaCode = await run({ deployless: true });
  const stillEmpty = allFailed(viaCode);
  if (id !== undefined) mode.set(id, stillEmpty ? "deployed" : "deployless");
  // Both empty means the calls really are dead; give back the first answer, so
  // a caller reading `.status` sees the shape it asked for.
  return stillEmpty && first !== undefined ? first : viaCode;
}

/** True only for a non-empty batch in which every entry failed. */
function allFailed(result: unknown): boolean {
  if (!Array.isArray(result) || result.length === 0) return false;
  return result.every((r) => r && typeof r === "object" && "status" in r && r.status === "failure");
}

/**
 * Whether an error is one the deployless path could plausibly fix.
 *
 * Retrying everything would turn a genuine revert into two round trips and the
 * same revert, and would hide a bad ABI behind a slower failure. The two shapes
 * worth retrying are viem refusing for lack of a declared contract, and the
 * batch call itself reverting because nothing is at that address.
 */
function isBatchable(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const message = `${error.name} ${error.message}`;
  return (
    message.includes("does not support contract") ||
    message.includes("multicall3") ||
    message.includes("Multicall3") ||
    // A call to an address with no code returns empty, which viem reports as a
    // decode failure rather than as a revert.
    message.includes("returned no data")
  );
}
