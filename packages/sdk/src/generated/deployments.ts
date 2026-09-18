// GENERATED — do not hand-edit.
// Rebuilt from the contract build artifacts. See the repository README.

import type { Deployment } from "../types.js";

/**
 * Every network this version of the SDK knows Lunya to be on.
 *
 * A listed deployment is a claim about what these addresses were when this
 * version was cut, not about what is live this minute — a test network's
 * contracts get replaced. Pin the version, or pass your own `addresses`.
 */
export const DEPLOYMENTS = [
  {
    "chainId": 5042,
    "name": "Arc Mainnet",
    "rpcUrl": "https://rpc.mainnet.arc.io",
    "explorerUrl": "https://explorer.arc.io",
    "testnet": false,
    "native": {
      "symbol": "USDC",
      "decimals": 18,
      "isUsd": true,
      "hasWrapper": false
    },
    "pairToken": "0x3600000000000000000000000000000000000000",
    "wrappedNative": null,
    "dex": {
      "factory": "0x711492df23f320745de6fd7f0ab9564fdbfea016",
      "poolDeployer": "0x1ec3a928d8b578fb29317b3675851c3d6bd3b335",
      "swapRouter": "0x25cdc61f38db50c4da71e8a073d5de3caad3d0ad",
      "quoter": "0x766d8bd38832443c5278ce00891629b75ca621c9",
      "startBlock": 21067506
    },
    "launchFactory": {
      "address": "0xfb68a7bdc87b6754b5dd092586b8e2904baad46e",
      "startBlock": 21067677
    }
  },
  {
    "chainId": 5042002,
    "name": "Arc Testnet",
    "rpcUrl": "https://rpc.testnet.arc.io",
    "explorerUrl": "https://testnet.arcscan.app",
    "testnet": true,
    "native": {
      "symbol": "USDC",
      "decimals": 18,
      "isUsd": true,
      "hasWrapper": false
    },
    "pairToken": "0x3600000000000000000000000000000000000000",
    "wrappedNative": null,
    "dex": {
      "factory": "0x711492df23f320745de6fd7f0ab9564fdbfea016",
      "poolDeployer": "0x1ec3a928d8b578fb29317b3675851c3d6bd3b335",
      "swapRouter": "0x25cdc61f38db50c4da71e8a073d5de3caad3d0ad",
      "quoter": "0x766d8bd38832443c5278ce00891629b75ca621c9",
      "startBlock": 62792073
    },
    "launchFactory": {
      "address": "0xfb68a7bdc87b6754b5dd092586b8e2904baad46e",
      "startBlock": 62792254
    }
  }
] as const satisfies readonly Deployment[];

/** The chains this version knows about, for a caller that wants the union. */
export type KnownChainId = (typeof DEPLOYMENTS)[number]["chainId"];
