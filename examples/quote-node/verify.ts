/**
 * The SDK against a LIVE deployment.
 *
 *   pnpm --filter quote-node verify
 *
 * The unit tests prove the maths is self-consistent. This proves it agrees with
 * the chain, which is a different claim and the one that matters: an off-chain
 * `quoteBuy` that disagrees with the contract's by a wei produces a
 * `minTokensOut` the contract rejects, and the failure appears as slippage on
 * some fraction of trades rather than as anything you could debug.
 *
 * So it checks the things that CANNOT be checked without a chain:
 *
 *   - every curve quote against the deployed launchpad's own view, to the wei
 *   - offline CREATE2 derivation against pools the factory actually created
 *   - real routes, real quotes, real calldata, on pools with real liquidity
 *   - that a wrapper-less chain refuses a native swap rather than reverting
 *
 * Reads only. It signs nothing and needs no key, and it never touches the Lunya
 * indexer — checking the SDK against the chain by way of our own infrastructure
 * would be checking the wrong thing.
 */
import {
  abis,
  createLunyaClient,
  deploymentFromEnv,
  dex,
  launchpad,
  PoolType,
  POOL_TYPES,
  poolTypeLabel,
  explainLunyaError,
  decodePath,
  encodePath,
  readTokenMetadata,
} from "@lunya/sdk";
import { http } from "viem";

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

// The shipped addresses, with any LUNYA_* override from the environment.
// See .env.example for the variable names.
const client = createLunyaClient({
  deployment: deploymentFromEnv({ network: network() }),
  ...(process.env.LUNYA_RPC_URL ? { transport: http(process.env.LUNYA_RPC_URL) } : {}),
});
/**
 * Paced, because the shipped RPC is a PUBLIC endpoint and rate-limits.
 *
 * Not the SDK being slow — point LUNYA_RPC_URL at your own node and this runs
 * flat out. Worth leaving in, because it is the same pacing any integration on
 * a public endpoint will discover it needs, and a verification that fails on a
 * 429 teaches nothing about the SDK.
 */
const PACE_MS = Number(process.env.LUNYA_PACE_MS ?? (process.env.LUNYA_RPC_URL ? 0 : 400));
const pause = (ms = PACE_MS) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

// ---------- 1. off-chain curve vs the deployed contract, to the wei
console.log("\n== curve: off-chain vs contract ==");
const addresses = await launchpad.listLaunches(client, { limit: 5 });
const launches = await launchpad.getLaunches(client, addresses);
const { timestamp: head } = await client.publicClient.getBlock();

for (const l of launches) {
  // Against the CREATOR, who is always exempt from the anti-snipe surcharge.
  // Inside the window the surcharge moves every second, and a comparison that
  // depended on which block each read landed in would fail for reasons that are
  // not the SDK's.
  await pause();
  check(await launchpad.isExempt(client, l.address, l.creator), `creator exempt on ${l.address.slice(0, 10)}`);
  for (const amountIn of [1n, 10n ** 15n, 10n ** 17n, 5n * 10n ** 18n, 10_000n * 10n ** 18n]) {
    await pause();
    const local = launchpad.curve.quoteBuy(l, amountIn, { now: head, exempt: true });
    const chain = await launchpad.quoteBuyFor(client, l.address, amountIn, l.creator);
    check(
      local.tokensOut === chain.tokensOut && local.fee === chain.fee && local.refund === chain.refund,
      `buy ${amountIn} on ${l.address.slice(0, 10)}`,
      local.tokensOut === chain.tokensOut ? "" : `local ${local.tokensOut} vs chain ${chain.tokensOut}`
    );
  }

  // Somebody who is NOT exempt — the path an ordinary buyer takes.
  await pause();
  if (head >= l.openedAt + BigInt(l.snipeWindow)) {
    // Window closed: nothing time-dependent is left, so this is exact too.
    const amountIn = 10n ** 17n;
    const local = launchpad.curve.quoteBuy(l, amountIn, { now: head });
    const chain = await launchpad.quoteBuy(client, l.address, amountIn);
    check(
      local.tokensOut === chain.tokensOut && local.fee === chain.fee && local.refund === chain.refund,
      `non-exempt buy on ${l.address.slice(0, 10)}`
    );
  } else {
    // Window open: the surcharge only falls, so the chain's figure — read at or
    // after `head` — can be no higher than the one computed at `head`.
    const local = launchpad.curve.snipeTaxBps(l, { now: head });
    const chain = await launchpad.currentSnipeTaxBps(client, l.address, "0x000000000000000000000000000000000000dEaD");
    check(chain <= local && chain > 0, `anti-snipe surcharge on ${l.address.slice(0, 10)}`,
          `${chain} bps now, ${local} at block time ${head}`);
  }
  await pause();
  const sellAmount = l.sold / 3n;
  if (sellAmount > 0n) {
    const local = launchpad.curve.quoteSell(l, sellAmount);
    const chain = await launchpad.quoteSell(client, l.address, sellAmount);
    check(
      local.amountOut === chain.amountOut && local.fee === chain.fee,
      `sell ${sellAmount} on ${l.address.slice(0, 10)}`
    );
  }
  // costToComplete must actually complete it, per the CONTRACT.
  await pause();
  const { amountIn: toFinish, tokensRemaining } = launchpad.curve.costToComplete(l, { now: head, exempt: true });
  const chainQuote = await launchpad.quoteBuyFor(client, l.address, toFinish, l.creator);
  check(chainQuote.tokensOut === tokensRemaining, `costToComplete completes ${l.address.slice(0, 10)}`,
        `${chainQuote.tokensOut} vs ${tokensRemaining}`);
}

// ---------- 2. what the factories announced, read back from their events
console.log("\n== events: what the factories announced ==");
const factory = client.dexAddress("factory");
const launchFactory = client.launchFactoryAddress();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A read that a public endpoint may refuse for rate, retried with exponential
 * backoff — up to about a minute in all, which outlasts the per-minute windows
 * public endpoints count in.
 */
async function retrying<T>(read: () => Promise<T>, attempts = 7): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      // Only a RATE limit is worth waiting out. Anything else — a request the
      // provider will never serve — goes straight back to the caller.
      if (!/rate limit|429|too many requests/i.test(describe(error)) || attempt >= attempts) throw error;
      await pause(Math.min(1000 * 2 ** attempt, 30_000));
    }
  }
}

const describe = (error: unknown): string => {
  const e = error as { details?: string; shortMessage?: string; message?: string };
  return `${e.details ?? ""} ${e.shortMessage ?? ""} ${e.message ?? ""}`;
};

/**
 * Every PoolCreated, LaunchCreated and Trade since the deployment began.
 *
 * The point is the event items this SDK exports: one with the wrong shape does
 * not fail, it filters to nothing, and only a real scan shows it. In spans,
 * because a public endpoint caps how many blocks one `eth_getLogs` may cover —
 * about two thousand on Arc's.
 */
const LOG_SPAN = BigInt(process.env.LUNYA_LOG_SPAN ?? 2000);
const launchAddresses = await launchpad.listLaunches(client, { limit: 500 });

type Scanned = { eventName: string; address: `0x${string}`; args: Record<string, any> };
const announcedPools: { token0: `0x${string}`; token1: `0x${string}`; poolType: number; pool: `0x${string}` }[] = [];
const announcedLaunches: { launch: `0x${string}`; token: `0x${string}` }[] = [];
const trades: { launch: `0x${string}`; isBuy: boolean; tokenAmount: bigint; reserve: bigint; sold: bigint }[] = [];
{
  const head = await client.publicClient.getBlockNumber();
  const start = BigInt(Math.min(client.deployment.dex!.startBlock, client.deployment.launchFactory!.startBlock));
  // Providers cap a log request differently — by blocks, or by blocks times
  // addresses — and say so in words. The span halves until the request fits,
  // rather than asking everyone to know their provider's arithmetic.
  let span = LOG_SPAN;
  for (let from = start; from <= head; ) {
    const to = from + span - 1n > head ? head : from + span - 1n;
    await pause();
    let logs: Scanned[];
    try {
      logs = (await retrying(() =>
        client.publicClient.getLogs({
          address: [factory, launchFactory, ...launchAddresses],
          events: [dex.poolCreatedEvent, launchpad.launchCreatedEvent, launchpad.tradeEvent],
          fromBlock: from,
          toBlock: to,
        })
      )) as unknown as Scanned[];
    } catch (error) {
      const tooBig = /range|blocks|narrow|too large|exceed/i.test(describe(error)) && !/rate limit/i.test(describe(error));
      if (tooBig && span > 1n) {
        span /= 2n;
        continue;
      }
      throw error;
    }
    from = to + 1n;
    for (const log of logs) {
      if (log.eventName === "PoolCreated") {
        const { token0, token1, poolType, pool } = log.args;
        announcedPools.push({ token0, token1, poolType: Number(poolType), pool });
      } else if (log.eventName === "LaunchCreated") {
        announcedLaunches.push({ launch: log.args.launch, token: log.args.token });
      } else if (log.eventName === "Trade") {
        const { isBuy, tokenAmount, reserve, sold } = log.args;
        trades.push({ launch: log.address, isBuy, tokenAmount, reserve, sold });
      }
    }
  }
  console.log(
    `  blocks ${start}..${head}: ${announcedPools.length} PoolCreated, ` +
      `${announcedLaunches.length} LaunchCreated, ${trades.length} Trade`
  );
}

await pause();
const launchCount = await client.publicClient.readContract({
  address: launchFactory,
  abi: abis.launchFactory,
  functionName: "launchCount",
});
check(BigInt(announcedLaunches.length) === launchCount, "every launch was announced by LaunchCreated",
      `${announcedLaunches.length} logs, launchCount ${launchCount}`);

await pause();
const listed = await launchpad.listTokens(client, { limit: 500 });
check(
  announcedLaunches.every((a) => listed.some((t) => same(t.launch, a.launch) && same(t.token, a.token))),
  "LaunchCreated names the launch and token the factory lists"
);

// A launch's trades, summed, must land exactly on its state: every token the
// curve sold out is a buy's tokenAmount, every one it took back a sell's.
await pause();
for (const l of await launchpad.getLaunches(client, launchAddresses)) {
  const own = trades.filter((t) => same(t.launch, l.address));
  if (!own.length) continue;
  const net = own.reduce((sum, t) => (t.isBuy ? sum + t.tokenAmount : sum - t.tokenAmount), 0n);
  const last = own[own.length - 1]!;
  // A graduated launch has moved its reserve into the pool, so only a live
  // curve's reserve still equals the one its last trade logged.
  const reserveHolds = l.phase === launchpad.LaunchPhase.Graduated || last.reserve === l.reserve;
  check(net === l.sold && last.sold === l.sold && reserveHolds,
        `Trade logs add up on ${l.address.slice(0, 10)}`,
        `${own.length} trades, net ${net}, sold ${l.sold}${l.phase === launchpad.LaunchPhase.Graduated ? ", graduated" : ""}`);
}

// ---------- 3. real DEX pools, real quotes, real calldata
console.log("\n== dex: pools, state, quoting ==");
// Pools are discovered the way an integrator would: a token universe through
// `findPools`. By default the universe is every token a pool was announced for,
// plus the pair token and every launched token — and `findPools` has to find
// every pool the factory announced. Pass LUNYA_TOKENS to use your own instead.
const named = (process.env.LUNYA_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean) as `0x${string}`[];
const universe =
  named.length > 1
    ? named
    : [
        ...new Map(
          [client.pairToken(), ...announcedPools.flatMap((p) => [p.token0, p.token1]), ...listed.map((t) => t.token)]
            .map((t) => [t.toLowerCase(), t] as const)
        ).values(),
      ];

const poolRows = await dex.findPools(client, universe, { batchSize: 150 });
console.log(`  findPools over ${universe.length} tokens -> ${poolRows.length} pool(s)`);
if (named.length <= 1) {
  check(announcedPools.every((a) => poolRows.some((r) => same(r.pool, a.pool))),
        "findPools finds every pool PoolCreated announced", `${announcedPools.length} announced`);
}
if (!poolRows.length) {
  console.log("  no pools on this deployment yet — the DEX checks below have nothing to run on");
}

const pairs = poolRows.map((r) => ({
  token0: r.token0,
  token1: r.token1,
  poolType: r.poolType,
  pool: r.pool,
}));

for (const p of pairs) {
  await pause();
  // computePoolAddress must agree with what the factory actually created.
  const computed = await dex.computePoolAddress(client, p.token0, p.token1, p.poolType);
  check(computed.toLowerCase() === p.pool.toLowerCase(), `computePoolAddress ${poolTypeLabel(p.poolType)}`, `${computed} vs ${p.pool}`);

  const found = await dex.getPool(client, p.token0, p.token1, p.poolType);
  check(found?.toLowerCase() === p.pool.toLowerCase(), `getPool ${poolTypeLabel(p.poolType)}`);

  const state = await dex.getPoolState(client, p.pool);
  check(state.poolType === p.poolType && state.token0.toLowerCase() === p.token0.toLowerCase(),
        `getPoolState ${p.pool.slice(0,10)}`, `type ${poolTypeLabel(state.poolType)} fee ${state.fee} liq ${state.liquidity}`);
  check(state.tickIsReal === (p.poolType !== PoolType.STABLE), `tickIsReal on ${poolTypeLabel(p.poolType)}`);
}

// quoting on a pool that actually has liquidity
const live = [];
for (const p of pairs) {
  await pause();
  const state = await dex.getPoolState(client, p.pool);
  if (state.liquidity > 0n) live.push({ ...p, state });
}
console.log(`  ${live.length} pool(s) with liquidity`);

for (const p of live.slice(0, 3)) {
  await pause(2000);
  try {
    // From the pair token where the pool has it, and one WHOLE unit of whatever
    // goes in: a fixed wei amount of an eighteen-decimal token is worth nothing
    // in a six-decimal one, and a quote of zero proves nothing.
    const [tokenIn, tokenOut] = same(p.token1, client.pairToken()) ? [p.token1, p.token0] : [p.token0, p.token1];
    const { decimals } = await readTokenMetadata(client.publicClient, tokenIn);
    const q = await dex.getBestQuote(client, tokenIn, tokenOut, 10n ** BigInt(decimals), { directOnly: true });
    check(q.amountOut > 0n, `quote one ${tokenIn.slice(0,8)}->${tokenOut.slice(0,8)}`, `out ${q.amountOut} via ${poolTypeLabel(q.hops[0]!.poolType)}`);

    const tx = dex.buildSwapFromQuote(client, q, { slippageBps: 50, recipient: "0x000000000000000000000000000000000000dEaD" });
    check(tx.to.toLowerCase() === client.dexAddress("swapRouter").toLowerCase(), "swap targets the router");
    check((tx.approvals?.length ?? 0) === 1, "swap carries one approval", `${tx.approvals?.[0]?.token}`);
    check(tx.value === 0n, "no native value on a chain with no wrapper");

    // exact-out on the same pool
    await pause(2000);
    const qo = await dex.getBestQuoteExactOut(client, tokenIn, tokenOut, q.amountOut / 2n, { directOnly: true });
    check(qo.amountIn > 0n, "exact-out quote", `in ${qo.amountIn} for out ${qo.amountOut}`);
  } catch (e) {
    check(false, `quote on ${p.pool.slice(0,10)}`, explainLunyaError(e));
  }
}

// multi-hop path round trip through a real hub
if (live.length >= 2) {
  const hops = [
    { tokenIn: live[0]!.token0, tokenOut: live[0]!.token1, poolType: live[0]!.poolType },
    { tokenIn: live[0]!.token1, tokenOut: live[1]!.token1, poolType: live[1]!.poolType },
  ];
  try {
    const path = encodePath(hops as any);
    const back = decodePath(path);
    check(back.length === 2 && back[0]!.poolType === hops[0]!.poolType, "path round-trips", path.slice(0, 20) + "…");
  } catch (e) {
    check(false, "path round-trip", String(e));
  }
}

// ---------- pool data for pricing locally, and the limit-order book
console.log("\n== pool data for local pricing ==");
for (const p of pairs.slice(0, 8)) {
  await pause();
  const state = await dex.getPoolState(client, p.pool, { poolType: p.poolType });
  await pause();
  const fee = await dex.getCurrentFee(client, p.pool);
  check(fee.fee >= 0 && fee.fee < 1_000_000, `current fee on ${poolTypeLabel(p.poolType)} ${p.pool.slice(0, 10)}`,
        `${fee.fee} (${fee.source}), fee token ${state.feeToken}`);

  if (p.poolType === PoolType.STABLE) {
    check(state.stable !== null && state.stable.amplificationX100 > 0, `STABLE state on ${p.pool.slice(0, 10)}`,
          `A ${(state.stable?.amplificationX100 ?? 0) / 100}, reserves ${state.stable?.reserve0} / ${state.stable?.reserve1}`);
    continue;
  }

  // The liquidity in range is every crossing at or below the price, summed —
  // so a tick walk that missed one, or read a word wrong, cannot add up.
  await pause();
  const ticks = await dex.getTicks(client, p.pool);
  const inRange = ticks.filter((t) => t.tick <= state.tick).reduce((sum, t) => sum + t.liquidityNet, 0n);
  check(inRange === state.liquidity, `ticks reproduce in-range liquidity on ${poolTypeLabel(p.poolType)} ${p.pool.slice(0, 10)}`,
        `${ticks.length} ticks, ${inRange} vs ${state.liquidity}`);
  if (p.poolType === PoolType.CP) check(ticks.length <= 2, `a CP pool holds only the full range`);

  if (p.poolType === PoolType.CL && state.plugin) {
    await pause();
    const fillTick = (Math.floor(state.tick / state.tickSpacing) + 2) * state.tickSpacing;
    const batch = await dex.getOrderBatch(client, { plugin: state.plugin, fillTick, sellingToken0: true });
    check(batch.epoch >= 0, `limit-order book readable on ${p.pool.slice(0, 10)}`,
          `tick ${fillTick}: epoch ${batch.epoch}, resting ${batch.liquidity}`);
  }
}

// ---------- 3. discovery WITHOUT the indexer and WITHOUT logs
console.log("\n== discovery: offline derivation + factory confirmation ==");

// Read once; every derivation after this is pure local arithmetic.
const deployer = client.dexAddress("poolDeployer");
const hashes = await dex.getInitCodeHashes(client);
console.log(`  init code hashes: ${POOL_TYPES.map((t) => poolTypeLabel(t) + "=" + hashes[t].slice(0, 10) + "\u2026").join("  ")}`);

for (const p of pairs) {
  // Three answers that must agree: derived locally with no RPC at all, computed
  // by the deployer on-chain, and the pool the factory actually created.
  const local = dex.poolAddress(deployer, hashes, p.token0, p.token1, p.poolType);
  await pause();
  const onchain = await dex.computePoolAddress(client, p.token0, p.token1, p.poolType);
  check(
    local.toLowerCase() === onchain.toLowerCase() && local.toLowerCase() === p.pool.toLowerCase(),
    `offline derivation ${poolTypeLabel(p.poolType)}`,
    `local ${local} / onchain ${onchain} / actual ${p.pool}`
  );
}

// A pool address that does not derive from its pair is not a Lunya pool for it.
if (pairs[0]) {
  const spoofed = dex.poolAddress(deployer, hashes, pairs[0].token0, pairs[0].token1, PoolType.STABLE);
  check(spoofed.toLowerCase() !== pairs[0].pool.toLowerCase(), "a different curve derives a different address");
}

check(
  pairs.every((p) => dex.poolAddress(deployer, hashes, p.token0, p.token1, p.poolType).toLowerCase() === p.pool.toLowerCase()),
  "every discovered pool derives back to its pair"
);

// ---------- 3. native handling refuses correctly on a wrapper-less chain
console.log("\n== native handling ==");
try {
  const q = live[0] ? await dex.getBestQuote(client, live[0].token0, live[0].token1, 1000n, { directOnly: true }) : null;
  if (q) {
    try {
      dex.buildSwapFromQuote(client, q, { slippageBps: 50, fromNative: true, recipient: "0x000000000000000000000000000000000000dEaD" });
      check(false, "fromNative refused on Arc");
    } catch (e) {
      check(String(e).includes("no wrapper"), "fromNative refused on Arc", explainLunyaError(e).slice(0, 80));
    }
  }
} catch {}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
