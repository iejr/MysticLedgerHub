import { MoralisAdapter } from '../infra/MoralisAdapter.js';
import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { FirestoreAdapter } from '../infra/FirestoreAdapter.js';
import { MoralisParser } from '../domain/MoralisParser.js';
import { AlchemyParser } from '../domain/AlchemyParser.js';
import { InternalTransaction, UnifiedTransaction } from '../domain/types.js';
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

  filterTransactionByAddress(transaction: UnifiedTransaction, addresses: Set<string>): boolean {
    if (transaction?.from && addresses.has(transaction.from)) return true;
    if (transaction?.to && addresses.has(transaction.to)) return true; 
    if (transaction?.internalTransactions) {
      transaction.internalTransactions.forEach((internal: InternalTransaction) => {
        if (internal.from && addresses.has(internal.from)) return true;
        if (internal.to && addresses.has(internal.to)) return true;
      })
    }
    return false;
  }

  extractAddressfromTransaction(transaction: UnifiedTransaction): Set<string> {
    let involvedAddresses = new Set<string>();
    if (transaction?.from) involvedAddresses.add(transaction.from.toLowerCase());
    if (transaction?.to) involvedAddresses.add(transaction.to.toLowerCase());
    if (transaction?.internalTransactions) {
      transaction.internalTransactions.forEach((internal: any) => {
        involvedAddresses.add(internal.from.toLowerCase(0));
        involvedAddresses.add(internal.to.toLowerCase());
      })
    }

    return involvedAddresses;
  }

  async fetchMultiWalletTransactions(options: FetchOptions): Promise<UnifiedTransaction[]> {
    const wallets = options.wallets || (options.walletAddress ? [{ address: options.walletAddress, label: 'Default' }] : []);
    const chains = options.chains || (options.chain ? [options.chain] : []);

    if (wallets.length === 0 || chains.length === 0) {
      throw new Error('No wallets or chains specified');
    }
    const walletSet = new Set(wallets.map((w) => w.address.toLowerCase()));

    let allResults: UnifiedTransaction[] = [];
    const txHashMap = new Map<string, UnifiedTransaction>(); // chain_txHash -> UnifiedTransaction

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
        const tracesFrom = await this.alchemyAdapter.fetchTraceFilterTransactions({
          fromAddress: [wallet.address.toLowerCase()],
          fromBlock: hexFromBlock,
          toBlock: hexToBlock,
        });

        if (tracesFrom.result) {
          tracesFrom.result.forEach((t: any) => {
            if (t.transactionHash) discoveredTxHashes.add(t.transactionHash);
          });
        }

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
          const cachedTransactionsObj = await this.firestoreAdapter.getCanonicalTransaction(chain, hash);
          if (cachedTransactionsObj && this.filterTransactionByAddress(cachedTransactionsObj.payload, walletSet)) {
            txHashMap.set(`${chain}_${hash}`, cachedTransactionsObj.payload);
            continue;
          }
        }
        txHashesToFetch.push(hash);
      }

      if (txHashesToFetch.length > 0) {
        const batchRequests = txHashesToFetch.map((hash) => ({
          method: 'trace_transaction',
          params: [hash],
        }));

        const batchResults = await this.alchemyAdapter.sendBatch(batchRequests);

        for (let i = 0; i < batchResults.length; i++) {
          const txHash = txHashesToFetch[i];
          const res = batchResults[i];

          if (res && res.result) {
            const traces = res.result;
            const parsedTransaction = this.alchemyParser.parseTrace(traces, chain);
            if (!parsedTransaction) continue;

            console.log("Naforuke debug: showing parsedTransaciton =>");
            console.log(parsedTransaction);

            // Update blockTime if block info is available
            if (this.blockService) {
              try {
                const txBlockNumber = parsedTransaction.blockNumber;
                // Note: Ideally we'd have a bulk getBlock for the whole batch
                const block = await this.alchemyAdapter.getBlock(`0x${txBlockNumber.toString(16)}`);
                if (block && block.timestamp) {
                  const blockTime = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
                  parsedTransaction.blockTime = blockTime;
                }
              } catch (e) {
                console.warn(`Failed to fetch block timestamp for hash ${txHash}`, e);
              }
            }

            // Save canonical
            const involvedAddresses = this.extractAddressfromTransaction(parsedTransaction);
            if (options.useCache !== false) {
              await this.firestoreAdapter.saveCanonicalTransaction(chain, txHash, parsedTransaction, Array.from(involvedAddresses));
            }

            txHashMap.set(`${chain}_${txHash}`, parsedTransaction);
          }
        }
      }
    }

    // // Flatten results and filter by relevant wallets
    // const walletSet = new Set(wallets.map((w) => w.address.toLowerCase()));
    txHashMap.forEach((txs) => {
      allResults.push(txs);
    });

    return allResults;
  }
}
