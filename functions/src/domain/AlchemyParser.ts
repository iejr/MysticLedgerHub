import { UnifiedTransaction, TransactionParser } from './types.js';

export class AlchemyParser implements TransactionParser {
  parse(rawData: any, walletAddress: string): UnifiedTransaction[] {
    const transfers = rawData as any[];
    return transfers.map((tx) => {
      return {
        txHash: tx.hash,
        blockNumber: parseInt(tx.blockNum, 16),
        timestamp: tx.metadata?.blockTimestamp || new Date().toISOString(),
        chain: 'unknown', // Should be injected or determined from adapter context
        from: tx.from,
        to: tx.to,
        value: tx.rawContract?.value || '0',
        valueFormatted: tx.value?.toString() || '0',
        tokenSymbol: tx.asset,
        tokenAddress: tx.rawContract?.address,
        status: 'success', // Alchemy asset transfers usually only include successful ones
        type: this.mapCategoryToType(tx.category),
        metadata: tx,
      };
    });
  }

  private mapCategoryToType(category: string): 'external' | 'internal' | 'erc20' | 'nft' | 'other' {
    switch (category) {
      case 'external': return 'external';
      case 'internal': return 'internal';
      case 'erc20': return 'erc20';
      case 'erc721':
      case 'erc1155': return 'nft';
      default: return 'other';
    }
  }
}
