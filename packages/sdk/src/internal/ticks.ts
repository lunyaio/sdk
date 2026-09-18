/**
 * The geometry of a CL pool's tick tree, as pure arithmetic.
 *
 * Three levels. LEAVES are bitmap words, `tickBitmap(word)`, one bit per raw
 * tick: word `tick >> 8`, bit `tick & 0xff`. The tick is never divided by the
 * spacing, which is the change from Uniswap V3 that breaks V3 readers. A SECOND
 * layer marks which leaves are non-empty and has no getter. The ROOT,
 * `tickTreeRoot()`, marks which second-layer words are non-empty: bit `r` covers
 * leaf words `256r − 3466` to `256r − 3211`, clamped to the tick range.
 */

/** The leaf words the tick range spans: MIN_TICK is in the first, MAX_TICK in the last. */
export const MIN_LEAF_WORD = -3466;
export const MAX_LEAF_WORD = 3465;

/** What shifts a leaf word to a non-negative second-layer index. */
const LEAF_OFFSET = 3466;

/** Bits 0..27: 6932 leaf words, 256 to a second-layer word. */
const ROOT_BITS = 28;

/** The leaf words a root marks as possibly occupied, ascending. */
export function leafWordsUnderRoot(root: number): number[] {
  const words: number[] = [];
  for (let r = 0; r < ROOT_BITS; r++) {
    if (((root >>> r) & 1) === 0) continue;
    const from = Math.max(MIN_LEAF_WORD, 256 * r - LEAF_OFFSET);
    const to = Math.min(MAX_LEAF_WORD, 256 * r + 255 - LEAF_OFFSET);
    for (let word = from; word <= to; word++) words.push(word);
  }
  return words;
}

/** The ticks one leaf word holds, ascending: `word × 256 + bit` for each set bit. */
export function ticksInWord(word: number, bitmap: bigint): number[] {
  const ticks: number[] = [];
  if (bitmap === 0n) return ticks;
  for (let bit = 0; bit < 256; bit++) {
    if ((bitmap >> BigInt(bit)) & 1n) ticks.push(word * 256 + bit);
  }
  return ticks;
}

/** The leaf word and bit a tick lives at. The inverse of `ticksInWord`. */
export function tickPosition(tick: number): { word: number; bit: number } {
  // `>>` on a JS number is an arithmetic shift, so it floors for negative ticks
  // exactly as Solidity's does on an int24.
  return { word: tick >> 8, bit: tick & 0xff };
}
