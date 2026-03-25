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

  /**
   * Transforms raw trace data into a flattened list of UnifiedTransactions.
   * Note: This method does NOT filter by type, preserving all traces for future analysis.
   */
  parseTrace(traces: any[], chain: string): UnifiedTransaction[] {
    if (!traces || traces.length === 0) return [];

    const mainTrace = traces[0];
    const txHash = mainTrace.transactionHash;
    const blockNumber = mainTrace.blockNumber;

    return traces.map((t: any) => {
      return {
        txHash,
        blockNumber,
        timestamp: new Date().toISOString(),
        chain,
        from: t.action.from,
        to: t.action.to,
        value: t.action.value || '0x0',
        valueFormatted: t.action.value ? (BigInt(t.action.value) / BigInt(1e18)).toString() : '0',
        status: 'success',
        type: 'internal',
        metadata: t,
      };
    });
  }
}
