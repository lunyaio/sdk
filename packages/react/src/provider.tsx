"use client";

import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { usePublicClient, useWalletClient } from "wagmi";
import {
  createLunyaClient,
  type Deployment,
  type LunyaClient,
  type LunyaClientConfig,
} from "@lunya/sdk";

/**
 * The client, made once and shared.
 *
 * It takes wagmi's public client rather than making its own, which is the whole
 * point of this package: one transport, one chain, one place the app's RPC
 * configuration lives. A second client built here would have its own idea of
 * which chain it was on, and the two would disagree the moment somebody
 * switched networks — which is the bug this exists to prevent.
 *
 * The wallet client is threaded through the same way, so `client.send()` works
 * for whatever wagmi has connected. Nothing in the hooks below sends anything;
 * they build calls and hand them back for `useSendTransaction` or
 * `useWriteContract` to execute, so the app keeps the confirmation UI it
 * already has.
 */

type LunyaContextValue = { client: LunyaClient };

const LunyaContext = createContext<LunyaContextValue | null>(null);

export type LunyaProviderProps = Omit<LunyaClientConfig, "publicClient" | "walletClient"> & {
  children: ReactNode;
};

export function LunyaProvider({ children, ...config }: LunyaProviderProps) {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const value = useMemo<LunyaContextValue | null>(() => {
    // `usePublicClient` is undefined before wagmi has a config for the active
    // chain. Returning null rather than falling back to the deployment's public
    // RPC is deliberate: a silent fallback means a user on the wrong network
    // sees prices from the right one, which is worse than seeing nothing.
    if (!publicClient) return null;

    const client = createLunyaClient({
      ...config,
      publicClient,
      ...(walletClient ? { walletClient } : {}),
    });

    return { client };
    // The deployment id is the only config that should rebuild the client;
    // `addresses` and `routeThrough` are compared by the caller's own
    // memoisation, as objects always are in a dependency array.
  }, [publicClient, walletClient, config.deployment]);

  return createElement(LunyaContext.Provider, { value }, children);
}

/**
 * The client, or a thrown error naming the provider that is missing.
 *
 * Throwing rather than returning null: every hook below needs it, and a
 * `client?.` chain through twelve hooks turns one missing provider into twelve
 * silent no-ops.
 */
export function useLunya(): LunyaClient {
  const value = useContext(LunyaContext);
  if (!value) {
    throw new Error(
      "useLunya must be used inside <LunyaProvider>, and inside wagmi's WagmiProvider — " +
        "the Lunya client is built from wagmi's public client, so it cannot exist before one does."
    );
  }
  return value.client;
}

/** Whether the provider is ready. For a loading state before wagmi has connected. */
export function useLunyaReady(): boolean {
  return useContext(LunyaContext) !== null;
}

export type { Deployment, LunyaClient };
