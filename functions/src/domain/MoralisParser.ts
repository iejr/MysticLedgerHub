import { UnifiedTransaction, TransactionParser } from './types.js';

export class MoralisParser implements TransactionParser {
  parse(rawData: any, walletAddress: string): UnifiedTransaction[] {
    const history = rawData as any[];
    return history.map((tx) => {
      // Moralis wallet history already aggregates a lot of data.
      // For complex transactions, we can look at internal_transactions if available
      // or the primary move of value.
      
      const isSender = tx.from_address.toLowerCase() === walletAddress.toLowerCase();
      
      // Basic mapping
      const unified: UnifiedTransaction = {
        txHash: tx.hash,
        blockNumber: parseInt(tx.block_number),
        timestamp: tx.block_timestamp,
        chain: tx.chain || 'base',
        from: tx.from_address,
        to: tx.to_address,
        value: tx.value,
        valueFormatted: tx.value_decimal,
        status: tx.receipt_status === '1' ? 'success' : 'failed',
        type: this.determineType(tx),
        method: tx.method_label || tx.input?.slice(0, 10),
        metadata: tx,
      };

      // Special handling for "actual" sender/receiver in complex transactions
      // In Moralis history, for simple transfers it's clear.
      // For proxy/complex txs, we might need to drill into tx.erc20_transfers or tx.nft_transfers
      if (tx.erc20_transfers && tx.erc20_transfers.length > 0) {
        // Find the transfer involving our wallet
        const relevantTransfer = tx.erc20_transfers.find((t: any) => 
          t.from_address.toLowerCase() === walletAddress.toLowerCase() || 
          t.to_address.toLowerCase() === walletAddress.toLowerCase()
        );
        if (relevantTransfer) {
          unified.actualSender = relevantTransfer.from_address;
          unified.actualReceiver = relevantTransfer.to_address;
          unified.tokenSymbol = relevantTransfer.symbol;
          unified.tokenAddress = relevantTransfer.address;
          unified.tokenDecimals = parseInt(relevantTransfer.decimals);
          unified.valueFormatted = relevantTransfer.value_decimal;
        }
      }

      return unified;
    });
  }

  private determineType(tx: any): 'external' | 'internal' | 'erc20' | 'nft' | 'other' {
    if (tx.erc20_transfers && tx.erc20_transfers.length > 0) return 'erc20';
    if (tx.nft_transfers && tx.nft_transfers.length > 0) return 'nft';
    // If it's a native transfer with value but no contract call
    if (tx.value !== '0' && (!tx.input || tx.input === '0x')) return 'external';
    return 'other';
  }
}
