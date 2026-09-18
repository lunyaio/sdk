# next-widget

A swap widget as a single component, for dropping into an existing Next.js or
Vite app. It is not a runnable app of its own — wiring up wagmi, a chain and a
wallet connector is your app's job, and duplicating it here would only teach the
version that was current when this was written.

## What to copy

`SwapWidget.tsx`, and the provider wrapping below it.

## Providers

`LunyaProvider` builds its client from **wagmi's** public client, so it has to
sit inside `WagmiProvider`, and inside `QueryClientProvider` because every read
hook is a TanStack query.

```tsx
import { WagmiProvider, createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LunyaProvider } from "@lunya/sdk-react";
import { chainOf, testnetDeployments } from "@lunya/sdk";

const deployment = testnetDeployments()[0]!;
const chain = chainOf(deployment);

const wagmi = createConfig({
  chains: [chain],
  transports: { [chain.id]: http(process.env.NEXT_PUBLIC_RPC_URL) },
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmi}>
      <QueryClientProvider client={queryClient}>
        <LunyaProvider deployment="testnet">{children}</LunyaProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

`chainOf` is worth knowing about: it turns a deployment into a viem `Chain`, so
you do not hand-write one for a chain your wallet library has never heard of.

## Why the widget does not send anything itself

The SDK builds an unsigned `{ to, data, value }` and wagmi's `useSendTransaction`
sends it. That keeps the confirmation modal, the pending state and the error
toast in your app, where you already have opinions about all three — and it is
the only shape that works for the other integrations, which sign with a KMS or
propose to a Safe rather than opening a wallet.
