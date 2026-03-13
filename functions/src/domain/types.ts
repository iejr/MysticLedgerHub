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
  internalTransactions: z.array(z.any()).optional(), // Store internal txs for complex Base txs
  actualSender: z.string().optional(), // Identified actual sender
  actualReceiver: z.string().optional(), // Identified actual receiver
  metadata: z.any().optional(), // Original provider data
});

export type UnifiedTransaction = z.infer<typeof UnifiedTransactionSchema>;

export interface TransactionParser {
  parse(rawData: any, walletAddress: string): UnifiedTransaction[];
}
