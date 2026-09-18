import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  DEPLOYMENTS,
  createLunyaClient,
  deploymentByChainId,
  deploymentsByChainId,
  mainnetDeployments,
  testnetDeployments,
} from "./client.js";
import type { Deployment } from "./types.js";
import { isAddress } from "viem";

/**
 * Choosing a network.
 *
 * The behaviour worth pinning is the REFUSALS. A selector that guesses — picks
 * the first of two deployments on a chain, or quietly falls back to testnet
 * when mainnet is asked for — is how an integration routes real funds at
 * contracts nobody chose, and it does it without a single error to notice.
 */

const all = DEPLOYMENTS as readonly Deployment[];

describe("selecting a network", () => {
  test('"testnet" resolves to the public test deployment', () => {
    const client = createLunyaClient({ deployment: "testnet" });
    assert.equal(client.deployment.testnet, true);
  });

  test('"mainnet" resolves to the production deployment, never to a test one', () => {
    const client = createLunyaClient({ deployment: "mainnet" });
    assert.equal(client.deployment.testnet, false);
    assert.notEqual(client.deployment.chainId, createLunyaClient({ deployment: "testnet" }).deployment.chainId);
  });

  test("a chain id selects directly", () => {
    const known = all[0]!;
    const client = createLunyaClient({ deployment: known.chainId });
    assert.equal(client.deployment.chainId, known.chainId);
  });

  test("an unknown chain id says which ones exist", () => {
    assert.throws(() => createLunyaClient({ deployment: 999999 }), /no Lunya deployment on chain/);
    assert.throws(() => createLunyaClient({ deployment: 999999 }), new RegExp(all[0]!.name));
  });

  /**
   * The escape hatch that replaces shipping a sandbox.
   *
   * A local node's addresses belong to one run on one machine, so they are not
   * in the registry. This is how a Lunya developer reaches one — and how anyone
   * reaches a deployment newer than the SDK they installed.
   */
  test("a whole Deployment object bypasses the shipped registry entirely", () => {
    const invented: Deployment = {
      ...all[0]!,
      name: "Somewhere Else",
      chainId: 999999,
      rpcUrl: "http://127.0.0.1:1",
    };
    const client = createLunyaClient({ deployment: invented });
    assert.equal(client.deployment.name, "Somewhere Else");
    assert.equal(client.chain.id, 999999);
  });
});

describe("looking a deployment up", () => {
  test("by chain id", () => {
    const known = all[0]!;
    assert.equal(deploymentByChainId(known.chainId)?.chainId, known.chainId);
  });

  test("an unknown chain is undefined, not a throw", () => {
    assert.equal(deploymentByChainId(999999), undefined);
    assert.deepEqual(deploymentsByChainId(999999), []);
  });

  test("no internal identifier leaks into the published registry", () => {
    // This repository is public and anonymous. A deployment carries a chain and
    // a human name; anything resembling an internal id, app or target name is a
    // detail of how Lunya builds things and has no business being published.
    for (const d of all) {
      for (const key of ["id", "app", "target"]) {
        assert.ok(!(key in d), `Deployment carries "${key}", which is internal vocabulary`);
      }
      assert.ok(!/@/.test(d.name), `name "${d.name}" looks like an internal id`);
    }
  });

  test("every shipped deployment is either mainnet or testnet, and the two partition it", () => {
    assert.equal(mainnetDeployments().length + testnetDeployments().length, all.length);
  });

  test("nothing local is shipped — a sandbox belongs to one machine", () => {
    for (const d of all) {
      assert.notEqual(d.chainId, 31337, `${d.name} is a local node and should not be in the registry`);
      assert.ok(d.rpcUrl === null || !d.rpcUrl.includes("127.0.0.1"), `${d.name} points at localhost`);
    }
  });
});

describe("addresses", () => {
  /**
   * Every listed network ships the whole set a trade needs. An entry with a
   * hole in it would answer `has()` for a product and then throw halfway
   * through a trade on it.
   */
  test("every shipped network carries every address a trade needs", () => {
    for (const d of all) {
      for (const key of ["factory", "poolDeployer", "swapRouter", "quoter"] as const) {
        const value = d.dex?.[key];
        assert.ok(value && isAddress(value, { strict: false }), `${d.name} has no dex.${key}`);
      }
      const factory = d.launchFactory?.address;
      assert.ok(factory && isAddress(factory, { strict: false }), `${d.name} has no launch factory`);

      const client = createLunyaClient({ deployment: d.chainId });
      assert.equal(client.has("dex"), true);
      assert.equal(client.has("launchpad"), true);
    }
  });

  test("an unconfigured accessor throws by name rather than encoding to undefined", () => {
    const bare: Deployment = { ...all[0]!, dex: null, launchFactory: null };
    const client = createLunyaClient({ deployment: bare });
    assert.equal(client.has("dex"), false);
    assert.throws(() => client.dexAddress("quoter"), /dex\.quoter is not configured/);
    assert.throws(() => client.launchFactoryAddress(), /launch factory is not configured/);
  });

  test("overrides supply them, over a keyword selection as much as a chain id", () => {
    const swapRouter = "0x00000000000000000000000000000000000000aa" as const;
    const quoter = "0x00000000000000000000000000000000000000bb" as const;

    const client = createLunyaClient({
      deployment: "testnet",
      addresses: { dex: { swapRouter, quoter } },
    });

    assert.equal(client.dexAddress("swapRouter"), swapRouter);
    assert.equal(client.dexAddress("quoter"), quoter);
    // A partial override replaces what it names and nothing else.
    const shipped = createLunyaClient({ deployment: "testnet" });
    assert.equal(client.dexAddress("factory"), shipped.dexAddress("factory"));
    // And the chain metadata survives the merge untouched.
    assert.equal(client.deployment.chainId, shipped.deployment.chainId);
  });
});
