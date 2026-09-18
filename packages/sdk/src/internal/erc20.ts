import { encodeFunctionData, erc20Abi, type Address, type Hex, type PublicClient } from "viem";

import { InvalidArgumentError } from "../errors.js";
import type { ApprovalRequest, TransactionRequest } from "../types.js";
import { batched } from "./multicall.js";

/**
 * ERC-20, in the small amount an integration needs.
 *
 * viem ships the ABI, so what is here is the two things it does not: turning an
 * approval into the same unsigned-call shape everything else in this SDK
 * returns, and reading metadata in one round trip instead of four.
 */

export function buildApproval(approval: ApprovalRequest): TransactionRequest {
  return {
    to: approval.token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [approval.spender, approval.amount],
    }),
    value: 0n,
    description: `approve ${approval.spender} to spend ${approval.amount} of ${approval.token}`,
  };
}

export type TokenMetadata = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
};

/**
 * Read a token's metadata.
 *
 * Multicalled with `allowFailure`, and the failures are filled in rather than
 * thrown: plenty of real tokens return bytes32 for `symbol`, or nothing at all,
 * and a swap that refuses to price because a name did not decode is worse than
 * one that prices against `UNKNOWN`. `decimals` is the exception — get that
 * wrong and every amount is off by orders of magnitude — so a token that will
 * not answer it is an error.
 */
export async function readTokenMetadata(
  client: PublicClient,
  address: Address
): Promise<TokenMetadata> {
  const [symbol, name, decimals] = await batched(client, (extra) =>
    client.multicall({
      allowFailure: true,
      contracts: [
        { address, abi: erc20Abi, functionName: "symbol" },
        { address, abi: erc20Abi, functionName: "name" },
        { address, abi: erc20Abi, functionName: "decimals" },
      ],
      ...extra,
    })
  );

  if (decimals.status !== "success") {
    throw new Error(
      `${address} did not answer decimals(). Either it is not an ERC-20, or the RPC failed — ` +
        `and the two are worth telling apart before treating any amount from it as real.`
    );
  }

  return {
    address,
    symbol: symbol.status === "success" ? symbol.result : "UNKNOWN",
    name: name.status === "success" ? name.result : "Unknown token",
    decimals: Number(decimals.result),
  };
}

/** Current allowance, for deciding whether an approval is actually needed. */
export async function readAllowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

export async function readBalance(
  client: PublicClient,
  token: Address,
  owner: Address
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

/**
 * The approvals a spend actually still needs, having asked the chain.
 *
 * The builders attach approvals unconditionally, because building a call is
 * offline and cannot know. This is the checked version, for a caller that would
 * rather not put a redundant approval in front of a user.
 *
 * Nothing here approves an unlimited amount by default. That is a choice: an
 * infinite approval to a router is the standard convenience and also the
 * standard way a later router bug drains a wallet, and an SDK should not make
 * it on somebody's behalf. Pass `amount: maxUint256` if you want it.
 */
export async function pendingApprovals(
  client: PublicClient,
  owner: Address,
  approvals: readonly ApprovalRequest[]
): Promise<ApprovalRequest[]> {
  if (approvals.length === 0) return [];
  const current = await Promise.all(
    approvals.map((a) => readAllowance(client, a.token, owner, a.spender))
  );
  return approvals.filter((a, i) => current[i]! < a.amount);
}

/*//////////////////////////////////////////////////////////////
                            Permit
//////////////////////////////////////////////////////////////*/

/** The parts of EIP-2612 and EIP-5267 that viem's `erc20Abi` does not carry. */
const permitAbi = [
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type PermitTypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address; salt?: Hex };
  types: typeof PERMIT_TYPES;
  primaryType: "Permit";
  message: { owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint };
};

/**
 * The EIP-2612 permit to sign, so a spend needs no approval transaction.
 *
 * Returned for YOUR signer — `signTypedData` in viem, wagmi or ethers — and
 * never signed here, for the same reason nothing in this SDK sends. The
 * signature goes to the builder that takes one: `permit` on a swap.
 *
 * THE DOMAIN IS READ FROM THE TOKEN, NOT ASSUMED. EIP-5267's `eip712Domain()`
 * where the token answers it, `name()` and `version()` where it does not. The
 * version is the trap: USDC signs under "2", most tokens under "1", and a
 * signature under the wrong one looks fine until the token rejects it. A token
 * that answers neither needs `version` passed explicitly — guessing it here
 * would turn a clear error into a revert.
 *
 * Null for a token with no `nonces(owner)`: it does not do permits at all, and
 * the spend needs an ordinary approval.
 */
export async function buildPermitTypedData(
  client: PublicClient,
  params: {
    token: Address;
    owner: Address;
    spender: Address;
    value: bigint;
    /** Unix seconds. The permit's, not the trade's: it can outlive the swap it was signed for. */
    deadline: bigint;
    /** Only for a token that exposes neither `eip712Domain()` nor `version()`. */
    version?: string;
  }
): Promise<PermitTypedData | null> {
  const { token, owner } = params;
  const [domain, name, version, nonce] = await batched(client, (extra) =>
    client.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: permitAbi, functionName: "eip712Domain" },
        { address: token, abi: erc20Abi, functionName: "name" },
        { address: token, abi: permitAbi, functionName: "version" },
        { address: token, abi: permitAbi, functionName: "nonces", args: [owner] },
      ],
      ...extra,
    })
  );
  if (nonce.status !== "success") return null;

  let resolved: PermitTypedData["domain"];
  if (domain.status === "success") {
    const [fields, domainName, domainVersion, chainId, verifyingContract, salt] = domain.result;
    resolved = {
      name: domainName,
      version: domainVersion,
      chainId: Number(chainId),
      verifyingContract,
      // Bit 4 of EIP-5267's field mask: the domain is salted, and the salt is
      // part of what gets hashed.
      ...(Number(fields) & 0x10 ? { salt } : {}),
    };
  } else {
    if (name.status !== "success") {
      throw new InvalidArgumentError(`${token} answers nonces() but not name(), so no permit domain can be built`);
    }
    const tokenVersion = version.status === "success" ? version.result : params.version;
    if (tokenVersion === undefined) {
      throw new InvalidArgumentError(
        `${token} exposes neither eip712Domain() nor version(). Pass \`version\` after checking the ` +
          `token's source — a wrong one produces a permit the token rejects.`
      );
    }
    resolved = {
      name: name.result,
      version: tokenVersion,
      chainId: client.chain?.id ?? (await client.getChainId()),
      verifyingContract: token,
    };
  }

  return {
    domain: resolved,
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: {
      owner,
      spender: params.spender,
      value: params.value,
      nonce: nonce.result,
      deadline: params.deadline,
    },
  };
}
