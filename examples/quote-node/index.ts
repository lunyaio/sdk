/**
 * Quote a swap and a curve buy from Node, with no wallet.
 *
 *   pnpm --filter quote-node start
 *
 * Everything here is a read. It is the first thing to run against a new
 * deployment, because it answers the two questions that block every other
 * integration: is the RPC reachable, and are the addresses you configured the
 * live ones.
 */
import {
  createLunyaClient,
  deploymentFromEnv,
  dex,
  launchpad,
  explainLunyaError,
  poolTypeLabel,
  PoolType,
} from "@lunya/sdk";
import { formatUnits, http, type Address } from "viem";

/**
 * Load `.env` from the workspace root, if there is one.
 *
 * `process.loadEnvFile` is Node's own, so there is no dependency and nothing to
 * install. Anything already exported in the shell WINS over the file — which is
 * what lets CI and a one-off run work without editing anything.
 *
 * Wrapped because a missing file throws, and not having one is the normal case
 * for somebody who exports variables instead.
 */
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // No .env, or this runtime has no loader. The environment is the environment.
}

/**
 * Which network, from the environment.
 *
 * A word or a chain id — `"testnet"`, `"mainnet"`, or `5042002`. Defaults to the
 * public test network, which is the one you want when trying this out.
 */
const network = (): "mainnet" | "testnet" | number => {
  const raw = process.env.LUNYA_NETWORK ?? "testnet";
  if (raw === "mainnet" || raw === "testnet") return raw;
  const chainId = Number(raw);
  if (!Number.isInteger(chainId)) {
    throw new Error(`LUNYA_NETWORK must be "mainnet", "testnet" or a chain id — got "${raw}"`);
  }
  return chainId;
};

const client = createLunyaClient({
  // The shipped addresses, with any LUNYA_* override from the environment.
  // See .env.example for the variable names.
  deployment: deploymentFromEnv({ network: network() }),
  // The shipped `rpcUrl` is a public endpoint. Point this at your own before
  // doing anything in a loop — public endpoints rate-limit, and they should.
  ...(process.env.LUNYA_RPC_URL ? { transport: http(process.env.LUNYA_RPC_URL) } : {}),
});

console.log(`\n${client.deployment.name}  (chain ${client.deployment.chainId})`);
console.log(`  native   ${client.deployment.native.symbol}, wrapper: ${client.deployment.native.hasWrapper ? "yes" : "none"}`);
console.log(`  dex      ${client.has("dex") ? "yes" : "no"}`);
console.log(`  launchpad ${client.has("launchpad") ? "yes" : "no"}`);


/*//////////////////////////////////////////////////////////////
                        1. A DEX quote
//////////////////////////////////////////////////////////////*/

if (client.has("dex")) {
  const pairToken = client.pairToken();
  const pools = await discoverPools();
  console.log(`${pools.length} pool(s) found\n`);

  const withPair = pools.find((p) => p.token0 === pairToken || p.token1 === pairToken);
  if (!withPair) {
    console.log("  no pool against the pair token — nothing to quote\n");
  } else {
    const [tokenIn, tokenOut] =
      withPair.token0 === pairToken
        ? [withPair.token0, withPair.token1]
        : [withPair.token1, withPair.token0];

    const amountIn = 1_000n;
    try {
      const quote = await dex.getBestQuote(client, tokenIn, tokenOut, amountIn, { directOnly: true });
      console.log(
        `  ${amountIn} in  ->  ${quote.amountOut} out ` +
          `via ${quote.hops.map((h) => poolTypeLabel(h.poolType)).join(" -> ")} ` +
          `(fee ${quote.feeAmount / 10_000}%)`
      );

      // The unsigned call. Nothing is sent; there is no wallet here.
      const tx = dex.buildSwapFromQuote(client, quote, {
        slippageBps: 50,
        recipient: "0x000000000000000000000000000000000000dEaD",
      });
      console.log(`  calldata ${tx.data.slice(0, 10)}…  ${tx.data.length / 2 - 1} bytes`);
      console.log(`  approvals needed: ${tx.approvals?.length ?? 0}\n`);
    } catch (error) {
      console.log(`  no quote: ${explainLunyaError(error)}\n`);
    }
  }
}

/**
 * Finding pools, on YOUR RPC. Nothing here touches the Lunya indexer.
 *
 * `findPools` is the path an aggregator wants: derive every candidate address
 * locally, confirm existence in batched multicalls, done. It needs a token
 * universe, which you already have — it is the list you were going to price
 * anyway.
 *
 * The other path is indexing `PoolCreated` (`dex.poolCreatedEvent`), which is
 * also how you stay current afterwards. It is not the default here for a reason
 * worth knowing: this deployment's pools were created a million blocks behind
 * the head, and a public endpoint caps both how many blocks one `eth_getLogs`
 * may span and how often you may ask. Backfilling that way needs your own node.
 */
async function discoverPools(): Promise<dex.FoundPool[]> {
  const named = (process.env.LUNYA_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean) as Address[];

  // Falls back to the pair token plus whatever the launchpad has created, which
  // is every token this SDK can name without being told. On a deployment whose
  // pools pair against tokens from somewhere else, that finds nothing — and
  // saying so is more useful than pretending discovery is automatic.
  const universe = named.length > 1
    ? named
    : [client.pairToken(), ...(await launchpad.listTokens(client, { limit: 15 })).map((t) => t.token)];

  console.log(
    named.length > 1
      ? `discovery: findPools over ${universe.length} tokens you named`
      : `discovery: findPools over ${universe.length} tokens (pair token + launched tokens)`
  );

  const pools = await dex.findPools(client, universe, { batchSize: 150 });
  if (!pools.length && named.length <= 1) {
    console.log("  none — pass LUNYA_TOKENS=0x…,0x… with the tokens you actually track");
  }
  return pools;
}

/*//////////////////////////////////////////////////////////////
                    2. A launchpad curve quote
//////////////////////////////////////////////////////////////*/

if (client.has("launchpad")) {
  const addresses = await launchpad.listLaunches(client, { limit: 5 });
  const launches = await launchpad.getLaunches(client, addresses);
  console.log(`launchpad: ${launches.length} launch(es)\n`);

  // The CHAIN's time, not this machine's. Inside a launch's anti-snipe window a
  // buy's fee depends on it, and a clock running ahead of the chain quotes a
  // smaller surcharge than the contract will charge.
  const { timestamp: now } = await client.publicClient.getBlock();

  for (const launch of launches) {
    const amountIn = 10n ** 17n;

    // Priced off-chain, from state we already have — no second round trip. For
    // a recipient that is not exempt, which is the default and the cautious one.
    const quote = launchpad.curve.quoteBuy(launch, amountIn, { now });
    const toFinish = launchpad.curve.costToComplete(launch, { now });
    const surcharge = launchpad.curve.snipeTaxBps(launch, { now });

    console.log(`  ${launch.address}  sells ${launch.token}`);
    console.log(`    phase ${launch.phase}, ${(launch.progress * 100).toFixed(2)}% of the curve sold`);
    console.log(`    quoted in ${launch.quoteToken}${launch.nativeDivisor === 0n ? " (no native entry)" : ""}`);
    if (surcharge > 0) console.log(`    anti-snipe window open: +${surcharge} bps on buys`);
    console.log(`    ${amountIn} buys ${formatUnits(quote.tokensOut, 18)} tokens (fee ${quote.fee}, surcharge ${quote.snipeFee})`);
    if (toFinish.amountIn > 0n) console.log(`    ${toFinish.amountIn} would complete the curve`);
  }
  console.log();
}
