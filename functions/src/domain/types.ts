import { z } from 'zod';

export const InternalTransactionSchema = z.object({
  from: z.string(),
  to: z.string().nullable(),
  value: z.string(),
  valueFormatted: z.string().optional(),
  type: z.string(),
  gas: z.string().optional(),
  gasUsed: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  traceAddress: z.array(z.number()).optional(),
  subtraces: z.number().optional(),
  usdValue: z.number().optional(),
});

export type InternalTransaction = z.infer<typeof InternalTransactionSchema>;

export const NativeTransferSchema = z.object({
  from: z.string(),
  to: z.string().nullable(),
  value: z.string(),
  valueFormatted: z.string(),
  usdValue: z.number().optional(),
});

export type NativeTransfer = z.infer<typeof NativeTransferSchema>;

export const TokenTransferSchema = z.object({
  from: z.string(),
  to: z.string(),
  value: z.string(),
  valueFormatted: z.string(),
  /** Internal system token ID (e.g. "usdc", "native-eth") — preferred over symbol in code */
  tokenId: z.string().optional(),
  /** Public ticker symbol — use for display/export */
  tokenSymbol: z.string(),
  tokenAddress: z.string(),
  tokenDecimals: z.number(),
  usdValue: z.number().optional(),
});

export type TokenTransfer = z.infer<typeof TokenTransferSchema>;

export const RawTransactionSchema = z.object({
  txHash: z.string(),
  chain: z.string(),
  source: z.string(), // e.g., "alchemy_trace_transaction"
  rawData: z.any(),
});

export type RawTransaction = z.infer<typeof RawTransactionSchema>;

export const UnifiedTransactionSchema = z.object({
  txHash: z.string(),
  blockNumber: z.number(),
  blockTime: z.string(),
  /** Internal system chain ID — matches the YAML map key (e.g. "ethereum", "base") */
  chain: z.string(),
  /** Human-readable chain name — populated during enrichment for API output */
  chainName: z.string().optional(),
  status: z.enum(["success", "failed", "pending", "other"]),
  nativeTransfers: z.array(NativeTransferSchema),
  tokenTransfers: z.array(TokenTransferSchema),
  usdPrice: z.number().optional(), // Price of native asset at blockTime
});

export type UnifiedTransaction = z.infer<typeof UnifiedTransactionSchema>;

export interface TransactionParser {
  parse(rawData: any, walletAddress: string): UnifiedTransaction[];
}

export const UnifiedBalanceSchema = z.object({
  walletAddress: z.string(),
  /** Internal system chain ID */
  chain: z.string(),
  /** Human-readable chain name — for API output */
  chainName: z.string().optional(),
  /** Internal system token ID (e.g. "usdc", "native-eth") */
  tokenId: z.string(),
  tokenSymbol: z.string(),
  tokenName: z.string(),
  balance: z.string(), // Raw value
  balanceFormatted: z.string(),
  decimals: z.number(),
  blockNumber: z.number().optional(),
  blocktime: z.string(), // New: Actual block timestamp
  requestedDate: z.string().optional(), // New: User requested timestamp
  usdPrice: z.number().optional(),
  usdBalance: z.number().optional(),
  updatedAt: z.string(),
});

export type UnifiedBalance = z.infer<typeof UnifiedBalanceSchema>;
