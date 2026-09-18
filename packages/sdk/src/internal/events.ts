/** One event of an ABI, typed as that event rather than as the whole ABI's union. */
export type EventNamed<A extends readonly unknown[], N extends string> = Extract<
  A[number],
  { type: "event"; name: N }
>;

/**
 * Pick an event out of a generated ABI by name.
 *
 * Throws rather than returning undefined: an event that is not there is a
 * generated ABI that no longer matches the SDK, and that should fail at import,
 * not as a log filter that silently matches nothing.
 */
export function eventNamed<const A extends readonly { type: string; name?: string }[], N extends string>(
  abi: A,
  name: N
): EventNamed<A, N> {
  const item = abi.find((e) => e.type === "event" && e.name === name);
  if (!item) throw new Error(`the generated ABI declares no ${name} event`);
  return item as EventNamed<A, N>;
}
