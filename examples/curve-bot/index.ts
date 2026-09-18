/**
 * A trading bot on the bonding curve: price every live launch, buy the ones
 * that pass a rule, and sell back out.
 *
 *   LUNYA_PRIVATE_KEY=0x… pnpm --filter curve-bot start
 *
 * Dry run by default. Use a funded testnet key; never a real one.
 *
 * This is the whole write path in one file: price off-chain, confirm on-chain,
 * build an unsigned call, send it with your own signer, and decode the revert
 * if it fails. The rule itself is deliberately trivial — it is a placeholder for
 * yours, not a strategy.
 */
import {
  buildApproval,
  createLunyaClient,
  deploymentFromEnv,
  explainLunyaError,
  launchpad,
  pendingApprovals,
} from "@lunya/sdk";
import { createWalletClient, formatUnits, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Load `.env` from the workspace root, if there is one — before anything below
 * reads a variable, or the file's values would be ignored.
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

const PRIVATE_KEY = process.env.LUNYA_PRIVATE_KEY as `0x${string}` | undefined;
if (!PRIVATE_KEY) {
  console.error("set LUNYA_PRIVATE_KEY (a funded testnet key — do not use a real one)");
  process.exit(1);
}

/** Per buy, in base units of each launch's QUOTE TOKEN — not the gas coin. */
const SPEND = BigInt(process.env.LUNYA_SPEND ?? 10n ** 16n);
const SLIPPAGE_BPS = Number(process.env.LUNYA_SLIPPAGE_BPS ?? 100);
const DRY_RUN = process.env.LUNYA_DRY_RUN !== "false";

const account = privateKeyToAccount(PRIVATE_KEY);

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

const wallet = createWalletClient({
  account,
  chain: client.chain,
  transport: http(process.env.LUNYA_RPC_URL ?? client.deployment.rpcUrl!),
}).extend(publicActions);

console.log(`curve bot as ${account.address} on ${client.deployment.name}`);
console.log(`spending ${SPEND} quote-token units per buy, ${SLIPPAGE_BPS / 100}% slippage`);
console.log(DRY_RUN ? "DRY RUN — set LUNYA_DRY_RUN=false to actually send\n" : "LIVE\n");

// One multicall, not a loop of reads. Two hundred round trips is how a public
// endpoint rate-limits you before you have priced anything.
const addresses = await launchpad.listLaunches(client, { limit: 200 });
const launches = await launchpad.getLaunches(client, addresses);

const live = launches.filter((l) => l.phase === launchpad.LaunchPhase.Trading);
console.log(`${launches.length} launches, ${live.length} still trading\n`);

// The CHAIN's time, read once. Inside a launch's anti-snipe window a buy's fee
// depends on it, and this machine's clock is not the chain's: one running ahead
// previews a smaller surcharge than the contract will charge.
const { timestamp: now } = await client.publicClient.getBlock();

for (const launch of live) {
  // Priced OFF-CHAIN, from state already in hand. The curve is closed-form and
  // this SDK's arithmetic agrees with the contract's to the wei, so scanning two
  // hundred launches costs nothing beyond the multicall that fetched them. No
  // `exempt`: this bot is nobody's listed address, so it pays any surcharge.
  const preview = launchpad.curve.quoteBuy(launch, SPEND, { now });
  if (preview.tokensOut === 0n) continue;

  const priceAfter = launchpad.curve.price({
    ...launch,
    reserve: launch.reserve + (SPEND - preview.fee),
    sold: launch.sold + preview.tokensOut,
  });
  const impactBps = Number(((priceAfter - launch.price) * 10_000n) / (launch.price || 1n));

  // Your rule goes here. This one buys anything early enough that the spend does
  // not move the price more than a percent.
  const worthBuying = launch.progress < 0.5 && impactBps < 100;
  const line =
    `  ${launch.address}  ${(launch.progress * 100).toFixed(1).padStart(5)}% sold  ` +
    `impact ${(impactBps / 100).toFixed(2).padStart(6)}%`;

  if (!worthBuying) {
    console.log(`${line}  skip`);
    continue;
  }

  // The contract's own answer, immediately before signing — FOR THIS RECIPIENT,
  // since the anti-snipe surcharge is charged on who receives the tokens. The
  // off-chain figure was computed from state that is now a few blocks old.
  const quote = await launchpad.quoteBuyFor(client, launch.address, SPEND, account.address);
  if (quote.tokensOut === 0n) {
    console.log(`${line}  no longer tradeable`);
    continue;
  }

  const tx = launchpad.buildBuy(client, {
    launch: launch.address,
    quoteToken: launch.quoteToken,
    amountIn: SPEND,
    expectedTokensOut: quote.tokensOut,
    slippageBps: SLIPPAGE_BPS,
    recipient: account.address,
  });

  console.log(`${line}  BUY ${formatUnits(quote.tokensOut, 18)} tokens`);
  if (quote.refund > 0n) {
    console.log(`      ${quote.refund} quote-token units come back — this buy completes the curve, and graduates it`);
  }
  if (DRY_RUN) continue;

  try {
    // `buy` pulls the quote token by `transferFrom`, so the approval goes first —
    // and only if it is still outstanding, so a bot that approved last round
    // does not pay for it again.
    for (const approval of await pendingApprovals(client.publicClient, account.address, tx.approvals ?? [])) {
      const approve = buildApproval(approval);
      const approveHash = await wallet.sendTransaction({
        account,
        chain: client.chain,
        to: approve.to,
        data: approve.data,
      });
      await wallet.waitForTransactionReceipt({ hash: approveHash });
    }

    const hash = await wallet.sendTransaction({
      account,
      chain: client.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    const receipt = await wallet.waitForTransactionReceipt({ hash });
    console.log(`      ${receipt.status} in block ${receipt.blockNumber} — ${hash}`);
  } catch (error) {
    // Decoded against every custom error in the protocol, so this says
    // "SlippageExceeded: the curve moved between quoting and executing" rather
    // than a bare selector.
    console.log(`      failed: ${explainLunyaError(error)}`);
  }
}

/*
 * SELLING is the asymmetric one: it moves the token in by `transferFrom`, so it
 * needs an ERC-20 approval first. The builder attaches it to the request rather
 * than sending it, because an SDK that silently signed a second transaction
 * would be doing something you did not ask for:
 *
 *   const { amountOut } = await launchpad.quoteSell(client, launch.address, amount);
 *   const tx = launchpad.buildSell(client, {
 *     launch: launch.address, token: launch.token, tokensIn: amount,
 *     expectedAmountOut: amountOut, slippageBps: SLIPPAGE_BPS, recipient: account.address,
 *   });
 *   for (const approval of tx.approvals ?? []) { … send buildApproval(approval) … }
 *
 * `pendingApprovals(publicClient, owner, tx.approvals)` asks the chain which of
 * them are actually still outstanding, so a bot that has already approved does
 * not burn gas approving again.
 */

console.log("\ndone");
