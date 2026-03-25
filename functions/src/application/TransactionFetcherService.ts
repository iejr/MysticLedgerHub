import { MoralisAdapter } from '../infra/MoralisAdapter.js';
import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { FirestoreAdapter } from '../infra/FirestoreAdapter.js';
import { MoralisParser } from '../domain/MoralisParser.js';
import { AlchemyParser } from '../domain/AlchemyParser.js';
import { UnifiedTransaction } from '../domain/types.js';
import { AlchemyRequestConverter } from '../domain/RequestConverters.js';

import { BlockService } from '../domain/BlockService.js';

export interface FetchOptions {
  walletAddress?: string;
  wallets?: { address: string; label: string }[];
  chain?: string;
  chains?: string[];
  startDate?: Date;
  endDate?: Date;
  fromBlock?: number;
  toBlock?: number;
  useCache?: boolean;
}

export class TransactionFetcherService {
  private moralisAdapter: MoralisAdapter;
  private alchemyAdapter: AlchemyAdapter;
  private firestoreAdapter: FirestoreAdapter;
  private blockService?: BlockService;
  private moralisParser: MoralisParser;
  private alchemyParser: AlchemyParser;

  constructor(
    moralisAdapter: MoralisAdapter,
    alchemyAdapter: AlchemyAdapter,
    firestoreAdapter: FirestoreAdapter,
    blockService?: BlockService
  ) {
    this.moralisAdapter = moralisAdapter;
    this.alchemyAdapter = alchemyAdapter;
    this.firestoreAdapter = firestoreAdapter;
    this.blockService = blockService;
    this.moralisParser = new MoralisParser();
    this.alchemyParser = new AlchemyParser();
  }

  async fetchAndCache(options: FetchOptions): Promise<UnifiedTransaction[]> {
    const walletAddress = options.walletAddress;
    const chain = options.chain;

    if (!walletAddress || !chain) {
      throw new Error('walletAddress and chain are required for fetchAndCache');
    }

    let allTransactions: UnifiedTransaction[] = [];

    // if (chain.toLowerCase() === 'what?') {
    //   // Use Moralis for Base chain
    //   const moralisParams = MoralisRequestConverter.fromFetchOptions({
    //     ...options,
    //     walletAddress,
    //     chain,
    //   });
    //   const iterator = this.moralisAdapter.getTransactionsIterator(moralisParams);

    //   for await (const batch of iterator) {
    //     const parsedBatch = this.moralisParser.parse(batch, walletAddress);
    //     allTransactions.push(...parsedBatch);

    //     for (const tx of parsedBatch) {
    //       await this.firestoreAdapter.saveTransaction(walletAddress, tx.txHash, tx);
    //     }
    //   }
    // } else {
    //   // Use Alchemy for other chains
    const alchemyParams = AlchemyRequestConverter.fromFetchOptions({
      ...options,
      walletAddress,
      chain,
    });
    const chainUrl = AlchemyRequestConverter.getChainUrl(chain);

    this.alchemyAdapter.setChain(chainUrl);
    const iterator = this.alchemyAdapter.getTransactionsIterator(alchemyParams);

    for await (const batch of iterator) {
      const parsedBatch = this.alchemyParser.parse(batch, walletAddress);
      // Alchemy parser currently sets chain to 'unknown', fix it here
      parsedBatch.forEach((tx) => (tx.chain = chain));

      allTransactions.push(...parsedBatch);

      for (const tx of parsedBatch) {
        await this.firestoreAdapter.saveTransaction(walletAddress, tx.txHash, tx);
      }
    }
    // }

    return allTransactions;
  }

  async fetchMultiWalletTransactions(options: FetchOptions): Promise<UnifiedTransaction[]> {
    const wallets = options.wallets || (options.walletAddress ? [{ address: options.walletAddress, label: 'Default' }] : []);
    const chains = options.chains || (options.chain ? [options.chain] : []);

    if (wallets.length === 0 || chains.length === 0) {
      throw new Error('No wallets or chains specified');
    }

    let allResults: UnifiedTransaction[] = [];
    const txHashMap = new Map<string, UnifiedTransaction[]>(); // chain_txHash -> UnifiedTransaction[]

    for (const chain of chains) {
      this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));

      // Resolve block range
      let fromBlock = options.fromBlock;
      let toBlock = options.toBlock;

      if (options.startDate && this.blockService) {
        fromBlock = await this.blockService.findBlockByTimestamp(chain, options.startDate);
      }
      if (options.endDate && this.blockService) {
        toBlock = await this.blockService.findBlockByTimestamp(chain, options.endDate);
      }

      const hexFromBlock = fromBlock ? `0x${fromBlock.toString(16)}` : '0x0';
      const hexToBlock = toBlock ? `0x${toBlock.toString(16)}` : 'latest';

      const discoveredTxHashes = new Set<string>();

      // Step 1: Discovery using trace_filter for each wallet
      for (const wallet of wallets) {
        const traces = await this.alchemyAdapter.fetchTraceFilterTransactions({
          fromAddress: [wallet.address.toLowerCase()],
          fromBlock: hexFromBlock,
          toBlock: hexToBlock,
        });

        if (traces.result) {
          traces.result.forEach((t: any) => {
            if (t.transactionHash) discoveredTxHashes.add(t.transactionHash);
          });
        }

        // Also check toAddress
        const tracesTo = await this.alchemyAdapter.fetchTraceFilterTransactions({
          toAddress: [wallet.address.toLowerCase()],
          fromBlock: hexFromBlock,
          toBlock: hexToBlock,
        });

        if (tracesTo.result) {
          tracesTo.result.forEach((t: any) => {
            if (t.transactionHash) discoveredTxHashes.add(t.transactionHash);
          });
        }
      }

      // Step 2 & 3: Detailed fetch and canonical caching
      const txHashesToFetch: string[] = [];
      
      for (const hash of discoveredTxHashes) {
        if (options.useCache !== false) {
          const cachedTraces = await this.firestoreAdapter.getCanonicalTransaction(chain, hash);
          if (cachedTraces) {
            txHashMap.set(`${chain}_${hash}`, this.alchemyParser.parseTrace(cachedTraces, chain));
            continue;
          }
        }
        txHashesToFetch.push(hash);
      }
      
      if (txHashesToFetch.length > 0) {
        // We can use Alchemy batching here
        const batchRequests = txHashesToFetch.map(hash => ({
          method: 'trace_transaction',
          params: [hash]
        }));

        const batchResults = await this.alchemyAdapter.sendBatch(batchRequests);

        for (let i = 0; i < batchResults.length; i++) {
          const txHash = txHashesToFetch[i];
          const res = batchResults[i];

          if (res && res.result) {
            const traces = res.result;
            const parsedTransactions = this.alchemyParser.parseTrace(traces, chain);
            
            // Save canonical
            const involvedAddresses = new Set<string>();
            traces.forEach((t: any) => {
              if (t.action?.from) involvedAddresses.add(t.action.from.toLowerCase());
              if (t.action?.to) involvedAddresses.add(t.action.to.toLowerCase());
            });

            if (options.useCache !== false) {
              await this.firestoreAdapter.saveCanonicalTransaction(chain, txHash, traces, Array.from(involvedAddresses));
            }

            txHashMap.set(`${chain}_${txHash}`, parsedTransactions);
          }
        }
      }
    }

    // Flatten results
    txHashMap.forEach((txs) => {
      allResults.push(...txs);
    });

    return allResults;
  }
}
