/**
 * @lunya/sdk-react — wagmi + TanStack Query bindings for @lunya/sdk.
 *
 * ```tsx
 * <WagmiProvider config={wagmi}>
 *   <QueryClientProvider client={queryClient}>
 *     <LunyaProvider deployment="testnet">
 *       <App />
 *     </LunyaProvider>
 *   </QueryClientProvider>
 * </WagmiProvider>
 * ```
 *
 * NO HOOK HERE SENDS A TRANSACTION. The builders return an unsigned
 * `{ to, data, value }` and the app passes it to wagmi's `useSendTransaction`,
 * so the confirmation UI, the pending state and the error surface stay where
 * the app already handles them.
 */

export {
  LunyaProvider,
  useLunya,
  useLunyaReady,
  type LunyaProviderProps,
} from "./provider.js";

export {
  usePairPools,
  usePoolState,
  useQuote,
  useQuoteExactOut,
  useFindPools,
  useTicks,
  useCurrentFee,
  useOrder,
  useSwapBuilder,
} from "./dex.js";

export {
  useLaunch,
  useLaunchByToken,
  useLaunches,
  useCurveQuote,
  useContractQuote,
  useLaunchpadBuilder,
  useSnipeStatus,
  useWatchLaunches,
  useWatchTrades,
  type CurveQuote,
  type ContractQuote,
} from "./launchpad.js";

/** Re-exported so an app needs one dependency, not two, for the common path. */
export {
  PoolType,
  LaunchPhase,
  poolTypeLabel,
  launchPhaseLabel,
  explainLunyaError,
  decodeLunyaRevert,
  type TransactionRequest,
  type Quote,
  type Launch,
  type Deployment,
} from "@lunya/sdk";
