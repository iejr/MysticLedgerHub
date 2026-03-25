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
});

export type InternalTransaction = z.infer<typeof InternalTransactionSchema>;

export const UnifiedTransactionSchema = z.object({
  txHash: z.string(),
  blockNumber: z.number(),
  blockTime: z.string(), // ISO 8601 (Renamed from timestamp)
  chain: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  value: z.string(), // Raw value in wei
  valueFormatted: z.string(), // Formatted value
  tokenSymbol: z.string().optional(),
  tokenAddress: z.string().optional(),
  tokenDecimals: z.number().optional(),
  gasPrice: z.string().optional(),
  gasUsed: z.string().optional(),
  status: z.enum(['success', 'failed', 'pending', 'other']),
  type: z.enum(['external', 'internal', 'erc20', 'nft', 'other']),
  method: z.string().optional(),
  internalTransactions: z.array(InternalTransactionSchema).optional(),
  rawData: z.any().optional(),
});

export type UnifiedTransaction = z.infer<typeof UnifiedTransactionSchema>;

export interface TransactionParser {
  parse(rawData: any, walletAddress: string): UnifiedTransaction[];
}

export const UnifiedBalanceSchema = z.object({
  walletAddress: z.string(),
  chain: z.string(),
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
