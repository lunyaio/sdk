import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MAX_LEAF_WORD, MIN_LEAF_WORD, leafWordsUnderRoot, tickPosition, ticksInWord } from "./ticks.js";

const MIN_TICK = -887272;
const MAX_TICK = 887272;

describe("tick tree geometry", () => {
  test("the range's two ends sit where the contract puts them", () => {
    assert.deepEqual(tickPosition(MIN_TICK), { word: MIN_LEAF_WORD, bit: 24 });
    assert.deepEqual(tickPosition(MAX_TICK), { word: MAX_LEAF_WORD, bit: 232 });
  });

  test("a negative tick floors into the word below, as an int24 shift does", () => {
    assert.deepEqual(tickPosition(-1), { word: -1, bit: 255 });
    assert.deepEqual(tickPosition(-256), { word: -1, bit: 0 });
    assert.deepEqual(tickPosition(-257), { word: -2, bit: 255 });
  });

  test("a word hands back exactly the ticks it holds, ascending", () => {
    const bitmap = (1n << 24n) | (1n << 232n) | 1n;
    assert.deepEqual(ticksInWord(-1, bitmap), [-256, -232, -24]);
    assert.deepEqual(ticksInWord(7, 0n), []);
  });

  test("position and word agree in both directions", () => {
    for (const tick of [MIN_TICK, -887000, -1, 0, 1, 255, 256, 60, 887040, MAX_TICK]) {
      const { word, bit } = tickPosition(tick);
      assert.deepEqual(ticksInWord(word, 1n << BigInt(bit)), [tick]);
    }
  });

  test("an empty root means no words to read", () => {
    assert.deepEqual(leafWordsUnderRoot(0), []);
  });

  test("root bit 0 covers the bottom 256 words, bit 27 only the last 20", () => {
    const bottom = leafWordsUnderRoot(1);
    assert.equal(bottom.length, 256);
    assert.equal(bottom[0], MIN_LEAF_WORD);
    assert.equal(bottom.at(-1), -3211);

    const top = leafWordsUnderRoot(1 << 27);
    assert.equal(top.length, 20);
    assert.equal(top[0], 3446);
    assert.equal(top.at(-1), MAX_LEAF_WORD);
  });

  test("a full-range pool's two ticks fall under root bits 0 and 27", () => {
    const words = leafWordsUnderRoot(1 | (1 << 27));
    assert.ok(words.includes(tickPosition(MIN_TICK).word));
    assert.ok(words.includes(tickPosition(MAX_TICK).word));
  });

  test("every word a full root marks is in range, once, in order", () => {
    const words = leafWordsUnderRoot(2 ** 28 - 1);
    assert.equal(words.length, MAX_LEAF_WORD - MIN_LEAF_WORD + 1);
    assert.ok(words.every((w, i) => i === 0 || w === words[i - 1]! + 1));
  });
});
