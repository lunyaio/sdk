"use client";

/**
 * A swap widget in one file, using @lunya/sdk-react.
 *
 * Deliberately unstyled: the point is the shape of the integration, not the CSS.
 * What it shows is the division of labour this SDK is built around —
 *
 *   the SDK   quotes, and builds an unsigned { to, data, value }
 *   wagmi     signs and sends it
 *   your app  owns every piece of UI in between
 *
 * The approval is the part worth copying. A swap that spends an ERC-20 needs
 * one, the SDK attaches it to the request, and nothing sends it for you — so
 * the widget checks whether it is actually outstanding and shows one button or
 * two. `pendingApprovals` is what asks the chain; the attached list is what the
 * call would need if nothing were approved.
 */

import { useState } from "react";
import { useAccount, usePublicClient, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits, formatUnits, type Address } from "viem";
import {
  useLunya,
  useQuote,
  useSwapBuilder,
  explainLunyaError,
  poolTypeLabel,
} from "@lunya/sdk-react";
import { pendingApprovals, buildApproval } from "@lunya/sdk";

const SLIPPAGE_BPS = 50; // 0.5%

export function SwapWidget({
  tokenIn,
  tokenOut,
  decimalsIn,
  decimalsOut,
}: {
  tokenIn: Address;
  tokenOut: Address;
  decimalsIn: number;
  decimalsOut: number;
}) {
  const client = useLunya();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const swap = useSwapBuilder();

  const [input, setInput] = useState("");
  const [needsApproval, setNeedsApproval] = useState<Address | null>(null);

  // Parsed once, and only when it parses. A malformed amount should show no
  // quote rather than a quote for zero, which reads as "no liquidity".
  const amountIn = safeParse(input, decimalsIn);

  const { data: quote, isFetching, error } = useQuote({ tokenIn, tokenOut, amountIn });

  const { sendTransaction, data: hash, isPending, error: sendError } = useSendTransaction();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  async function onSwap() {
    if (!quote || !address || !publicClient) return;

    const tx = swap.exactIn(quote, { slippageBps: SLIPPAGE_BPS, recipient: address });

    // The attached approvals say what the call NEEDS; this asks the chain what
    // is actually still outstanding, so a user who already approved is not
    // shown a redundant transaction.
    const outstanding = await pendingApprovals(publicClient, address, tx.approvals ?? []);
    if (outstanding.length > 0) {
      const approval = buildApproval(outstanding[0]!);
      setNeedsApproval(outstanding[0]!.token);
      sendTransaction({ to: approval.to, data: approval.data, value: approval.value });
      return;
    }

    setNeedsApproval(null);
    sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  }

  const busy = isPending || isConfirming;

  return (
    <div>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="0.0"
        inputMode="decimal"
      />

      <div>
        {isFetching && "quoting…"}
        {error && `no route: ${explainLunyaError(error)}`}
        {quote && (
          <>
            <div>
              {formatUnits(quote.amountOut, decimalsOut)} out
              {" · "}
              min {formatUnits(minOut(quote.amountOut), decimalsOut)} at {SLIPPAGE_BPS / 100}%
            </div>
            <div>
              route: {quote.hops.map((h) => poolTypeLabel(h.poolType)).join(" → ")}
              {" · "}
              fee {quote.feeAmount / 10_000}%
            </div>
          </>
        )}
      </div>

      <button onClick={onSwap} disabled={!quote || !address || busy}>
        {!address
          ? "Connect a wallet"
          : busy
            ? needsApproval
              ? "Approving…"
              : "Swapping…"
            : needsApproval
              ? "Approve"
              : "Swap"}
      </button>

      {sendError && <div>{explainLunyaError(sendError)}</div>}
      {isSuccess && !needsApproval && <div>Done — {hash}</div>}
      {isSuccess && needsApproval && <div>Approved. Press swap again.</div>}

      {/* A deployment without a wrapper cannot take the gas coin by value. Say
          so rather than offering a "use ETH" toggle that would revert. */}
      {!client.deployment.native.hasWrapper && (
        <small>
          {client.deployment.native.symbol} on {client.deployment.chainName} has no wrapper — every
          trade is an ERC-20 trade.
        </small>
      )}
    </div>
  );
}

const minOut = (amount: bigint) => (amount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;

function safeParse(value: string, decimals: number): bigint | undefined {
  const trimmed = value.trim();
  if (!trimmed || !/^\d*\.?\d*$/.test(trimmed)) return undefined;
  try {
    const parsed = parseUnits(trimmed, decimals);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}
