import { formatUnits } from "ethers";
import { UnifiedTransaction, TransactionParser, InternalTransaction } from './types.js';

export class AlchemyParser implements TransactionParser {
  parse(rawData: any, walletAddress: string): UnifiedTransaction[] {
    const transfers = rawData as any[];
    return transfers.map((tx) => {
      const type = this.mapCategoryToType(tx.category);
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
        tokenDecimals: tx.rawContract?.decimal ? parseInt(tx.rawContract.decimal, 16) : undefined,
        status: 'success', // Alchemy asset transfers usually only include successful ones
        type,
        rawData: tx,
      };
    });
  }

  private mapCategoryToType(category: string): 'regular' | 'erc20' | 'nft' | 'other' {
    switch (category) {
      case 'external': return 'regular';
      case 'internal': return 'regular';
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
        value: BigInt(t.action?.value).toString(10) || '0x0',
        valueFormatted: t.action?.value ? (formatUnits(BigInt(t.action.value), decimals)).toString() : '0',
        type: t.action?.callType,
        gas: BigInt(t.action?.gas).toString(10),
        gasUsed: BigInt(t.result?.gasUsed).toString(10),
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
      value: BigInt(mainTrace.action?.value).toString(10) || '0x0',
      valueFormatted: mainTrace.action?.value ? (formatUnits(BigInt(mainTrace.action.value), decimals)).toString() : '0',
      gasUsed: BigInt(mainTrace.result?.gasUsed).toString(10),
      status: mainTrace.error ? 'failed' : 'success',
      type: 'regular',
      internalTransactions,
      rawData: traces,
    };

    return unified;
  }
}
