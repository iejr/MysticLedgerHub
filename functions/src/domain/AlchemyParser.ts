import { UnifiedTransaction, TransactionParser, InternalTransaction } from './types.js';

export class AlchemyParser implements TransactionParser {
  parse(rawData: any, walletAddress: string): UnifiedTransaction[] {
    const transfers = rawData as any[];
    return transfers.map((tx) => {
      return {
        txHash: tx.hash,
        blockNumber: parseInt(tx.blockNum, 16),
        blockTime: tx.metadata?.blockTimestamp || new Date().toISOString(),
        chain: 'unknown', // Should be injected or determined from adapter context
        from: tx.from,
        to: tx.to,
        value: tx.rawContract?.value || '0',
        valueFormatted: tx.value?.toString() || '0',
        tokenSymbol: tx.asset,
        tokenAddress: tx.rawContract?.address,
        status: 'success', // Alchemy asset transfers usually only include successful ones
        type: this.mapCategoryToType(tx.category),
        rawData: tx,
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
   * Transforms raw trace data into a UnifiedTransaction with internal transactions.
   */
  parseTrace(traces: any[], chain: string): UnifiedTransaction | undefined {
    if (!traces || traces.length === 0) return undefined;

    // Identify the main action (traceAddress is empty array)
    const mainTrace = traces.find((t: any) => t.traceAddress.length === 0) || traces[0];
    const txHash = mainTrace.transactionHash;
    const blockNumber = mainTrace.blockNumber;
    const now = new Date().toISOString();

    // Determine decimals for valueFormatted (default 18, adjust if needed per chain)
    const decimals = 18; // Future: could be derived from chain config

    const internalTransactions: InternalTransaction[] = traces
      .filter((t: any) => t.traceAddress.length > 0)
      .map((t: any) => ({
        from: t.action?.from,
        to: t.action?.to || t.action?.address,
        value: t.action?.value || '0x0',
        valueFormatted: t.action?.value ? (BigInt(t.action.value) / BigInt(10 ** decimals)).toString() : '0',
        type: t.type,
        gas: t.action?.gas,
        gasUsed: t.result?.gasUsed,
        input: t.action?.input,
        output: t.result?.output,
        traceAddress: t.traceAddress,
        subtraces: t.subtraces,
      }));

    const unified: UnifiedTransaction = {
      txHash,
      blockNumber,
      blockTime: now, // Will be updated by caller if block info is available
      chain,
      from: mainTrace.action?.from,
      to: mainTrace.action?.to || mainTrace.action?.address,
      value: mainTrace.action?.value || '0x0',
      valueFormatted: mainTrace.action?.value ? (BigInt(mainTrace.action.value) / BigInt(10 ** decimals)).toString() : '0',
      status: mainTrace.error ? 'failed' : 'success',
      type: 'internal',
      internalTransactions,
      rawData: traces,
    };

    return unified;
  }
}
