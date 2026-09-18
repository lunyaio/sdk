import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { curveCompletedEvent, graduatedEvent, launchCreatedEvent, tradeEvent } from "./events.js";

const inputs = (event: { inputs: readonly { name: string; indexed?: boolean }[] }) =>
  Object.fromEntries(event.inputs.map((i) => [i.name, Boolean(i.indexed)]));

describe("launchpad events", () => {
  test("LaunchCreated indexes the launch, the token and the creator", () => {
    assert.equal(launchCreatedEvent.name, "LaunchCreated");
    const fields = inputs(launchCreatedEvent);
    assert.equal(fields.launch, true);
    assert.equal(fields.token, true);
    assert.equal(fields.creator, true);
    assert.ok("quoteToken" in fields);
  });

  test("Trade carries the curve's state after the trade", () => {
    assert.equal(tradeEvent.name, "Trade");
    assert.deepEqual(Object.keys(inputs(tradeEvent)), [
      "trader",
      "isBuy",
      "quoteAmount",
      "tokenAmount",
      "fee",
      "reserve",
      "sold",
    ]);
  });

  test("the curve filling and the graduation are separate events", () => {
    assert.equal(curveCompletedEvent.name, "CurveCompleted");
    assert.equal(graduatedEvent.name, "Graduated");
    assert.ok("quoteSeeded" in inputs(graduatedEvent));
  });
});
