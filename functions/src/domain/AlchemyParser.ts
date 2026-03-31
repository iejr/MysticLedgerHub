import { formatUnits } from "ethers";
import {
  UnifiedTransaction,
  TransactionParser,
  InternalTransaction,
  NativeTransfer,
  TokenTransfer,
  RawTransaction,
} from "./types.js";

export class AlchemyParser implements TransactionParser {
  parse(rawData: any, walletAddress: string): UnifiedTransaction[] {
    const transfers = rawData as any[];
    return transfers.map((tx) => {
      const category = tx.category;
      const nativeTransfers: NativeTransfer[] = [];
      const tokenTransfers: TokenTransfer[] = [];

      if (category === "external" || category === "internal") {
        nativeTransfers.push({
          from: tx.from,
          to: tx.to || null,
          value: tx.rawContract?.value || "0",
          valueFormatted: tx.value?.toString() || "0",
        });
      } else if (category === "erc20") {
        tokenTransfers.push({
          from: tx.from,
          to: tx.to,
          value: tx.rawContract?.value || "0",
          valueFormatted: tx.value?.toString() || "0",
          tokenSymbol: tx.asset,
          tokenAddress: tx.rawContract?.address,
          tokenDecimals: tx.rawContract?.decimal ? parseInt(tx.rawContract.decimal, 16) : 18,
        });
      }

      return {
        txHash: tx.hash,
        blockNumber: parseInt(tx.blockNum, 16),
        blockTime: tx.metadata?.blockTimestamp || new Date().toISOString(),
        chain: "unknown",
        status: "success",
        nativeTransfers,
        tokenTransfers,
      };
    });
  }

  /**
   * Distills raw trace data into a UnifiedTransaction by flattening traces into fund movements.
   * Also returns the RawTransaction for storage.
   */
  distillTrace(traces: any[], chain: string): { unified: UnifiedTransaction; raw: RawTransaction } | undefined {
    if (!traces || traces.length === 0) return undefined;

    const mainTrace = traces.find((t: any) => t.traceAddress.length === 0) || traces[0];
    const txHash = mainTrace.transactionHash;
    const blockNumber = mainTrace.blockNumber;
    const now = new Date().toISOString();

    const nativeTransfers: NativeTransfer[] = [];
    const tokenTransfers: TokenTransfer[] = [];

    // 1. Extract Native Transfers from traces
    // We include the main action and any internal 'call' that has a non-zero value
    for (const t of traces) {
      if (t.action?.value && BigInt(t.action.value) > 0n) {
        nativeTransfers.push({
          from: t.action.from,
          to: t.action.to || t.action.address || null,
          value: BigInt(t.action.value).toString(10),
          valueFormatted: formatUnits(BigInt(t.action.value), 18),
        });
      }
    }

    const unified: UnifiedTransaction = {
      txHash,
      blockNumber,
      blockTime: now,
      chain,
      status: mainTrace.error ? "failed" : "success",
      nativeTransfers,
      tokenTransfers,
    };

    const raw: RawTransaction = {
      txHash,
      chain,
      source: "alchemy_trace_transaction",
      rawData: traces,
    };

    return { unified, raw };
  }

  // Deprecated in favor of distillTrace, but keeping for interface compatibility if needed temporarily
  parseTrace(traces: any[], chain: string): UnifiedTransaction | undefined {
    const result = this.distillTrace(traces, chain);
    return result?.unified;
  }
}
