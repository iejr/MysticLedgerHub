import { z } from 'zod';

export const UnifiedTransactionSchema = z.object({
  txHash: z.string(),
  blockNumber: z.number(),
  timestamp: z.string(), // ISO 8601
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
  internalTransactions: z.array(z.any()).optional(),
  actualSender: z.string().optional(),
  actualReceiver: z.string().optional(),
  metadata: z.any().optional(),
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
