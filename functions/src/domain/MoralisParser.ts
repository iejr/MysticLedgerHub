import {
  UnifiedTransaction,
  TransactionParser,
  NativeTransfer,
  TokenTransfer,
} from "./types.js";

export class MoralisParser implements TransactionParser {
  parse(rawData: any, walletAddress: string): UnifiedTransaction[] {
    const history = rawData as any[];
    return history.map((tx) => {
      const nativeTransfers: NativeTransfer[] = [];
      const tokenTransfers: TokenTransfer[] = [];

      // Map native transfer if value > 0
      if (tx.value && tx.value !== "0") {
        nativeTransfers.push({
          from: tx.from_address,
          to: tx.to_address || null,
          value: tx.value,
          valueFormatted: tx.value_decimal,
        });
      }

      // Map ERC20 transfers
      if (tx.erc20_transfers && tx.erc20_transfers.length > 0) {
        for (const t of tx.erc20_transfers) {
          tokenTransfers.push({
            from: t.from_address,
            to: t.to_address,
            value: t.value,
            valueFormatted: t.value_decimal,
            tokenSymbol: t.symbol,
            tokenAddress: t.address,
            tokenDecimals: parseInt(t.decimals),
          });
        }
      }

      return {
        txHash: tx.hash,
        blockNumber: parseInt(tx.block_number),
        blockTime: tx.block_timestamp,
        chain: tx.chain || "base",
        status: tx.receipt_status === "1" ? "success" : "failed",
        nativeTransfers,
        tokenTransfers,
      };
    });
  }

  private determineType(tx: any): 'regular' | 'erc20' | 'nft' | 'other' {
    if (tx.erc20_transfers && tx.erc20_transfers.length > 0) return 'erc20';
    if (tx.nft_transfers && tx.nft_transfers.length > 0) return 'nft';
    // If it's a native transfer with value but no contract call
    if (tx.value !== '0' && (!tx.input || tx.input === '0x')) return 'regular';
    return 'other';
  }
}
