import { MoralisAdapter } from '../infra/MoralisAdapter.js';
import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { FirestoreAdapter } from '../infra/FirestoreAdapter.js';
import { MoralisParser } from '../domain/MoralisParser.js';
import { AlchemyParser } from '../domain/AlchemyParser.js';
import { InternalTransaction, UnifiedTransaction } from '../domain/types.js';
import { AlchemyRequestConverter } from '../domain/RequestConverters.js';

import { BlockService } from '../domain/BlockService.js';
import { PriceService } from '../domain/PriceService.js';
import { ConfigService } from '../domain/ConfigService.js';

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
  private priceService?: PriceService;
  private configService?: ConfigService;
  private moralisParser: MoralisParser;
  private alchemyParser: AlchemyParser;

  constructor(
    moralisAdapter: MoralisAdapter,
    alchemyAdapter: AlchemyAdapter,
    firestoreAdapter: FirestoreAdapter,
    blockService?: BlockService,
    priceService?: PriceService,
    configService?: ConfigService
  ) {
    this.moralisAdapter = moralisAdapter;
    this.alchemyAdapter = alchemyAdapter;
    this.firestoreAdapter = firestoreAdapter;
    this.blockService = blockService;
    this.priceService = priceService;
    this.configService = configService;
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

      // Use timestamp range if block range is not specified
      if (!fromBlock && !toBlock) {
        if (options.startDate && this.blockService) {
          fromBlock = await this.blockService.findBlockByTimestamp(chain, options.startDate);
        }
        if (options.endDate && this.blockService) {
          toBlock = await this.blockService.findBlockByTimestamp(chain, options.endDate);
        }
      }

      const hexFromBlock = fromBlock ? `0x${fromBlock.toString(16)}` : '0x0';
      const hexToBlock = toBlock ? `0x${toBlock.toString(16)}` : 'latest';

      const discoveredTxHashes = new Set<string>();
      const allowedTokens = this.configService ? this.configService.getTokensForChain(chain) : [];
      const allowedTokenAddresses = new Set(allowedTokens.map(t => {
        const addr = t.chains[chain.toLowerCase()]?.address;
        return addr ? addr.toLowerCase() : '';
      }).filter(a => a !== ''));

      // Step 1: Discovery using trace_filter and alchemy_getAssetTransfers for each wallet
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

        // Step 1b: Discovery using alchemy_getAssetTransfers for ERC20
        const assetTransferParams = {
          fromBlock: hexFromBlock,
          toBlock: hexToBlock,
          toAddress: wallet.address.toLowerCase(),
          category: ['erc20'],
          withMetadata: true,
        };

        const iterator = this.alchemyAdapter.getTransactionsIterator(assetTransferParams as any);
        for await (const transfers of iterator) {
          const parsedTransfers = this.alchemyParser.parse(transfers, wallet.address);
          for (const tx of parsedTransfers) {
            // Filter by allowed tokens to avoid spam
            if (tx.tokenAddress && allowedTokenAddresses.has(tx.tokenAddress.toLowerCase())) {
              tx.chain = chain;
              
              // Resolve symbol for pricing
              const symbol = tx.tokenSymbol || 'ETH';

              // Enrich with USD Price and Values
              if (this.priceService) {
                try {
                  const usdPrice = await this.priceService.getPriceAtTime(symbol, new Date(tx.blockTime));
                  if (usdPrice !== undefined) {
                    tx.usdPrice = usdPrice;
                    if (tx.valueFormatted) {
                      tx.usdValue = parseFloat(tx.valueFormatted) * usdPrice;
                    }
                  }
                } catch (e) {
                  console.warn(`Failed to fetch USD price for ${symbol} at ${tx.blockTime}`, e);
                }
              }

              // Save to cache/map
              if (options.useCache !== false) {
                const involvedAddresses = this.extractAddressfromTransaction(tx);
                await this.firestoreAdapter.saveCanonicalTransaction(chain, tx.txHash, tx, Array.from(involvedAddresses));
              }
              txHashMap.set(`${chain}_${tx.txHash}`, tx);
            }
          }
        }
      }

      // Step 2 & 3: Detailed fetch and canonical caching for discovered traces
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

            // Resolve symbol for pricing
            let symbol = parsedTransaction.tokenSymbol;
            if (!symbol && this.configService) {
              const meta = this.configService.getChainMetadata(chain);
              if (meta) symbol = meta.nativeSymbol;
            }
            if (!symbol) symbol = 'ETH'; // Ultimate fallback

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

            // Enrich with USD Price and Values
            if (this.priceService) {
              try {
                const usdPrice = await this.priceService.getPriceAtTime(symbol, new Date(parsedTransaction.blockTime));
                if (usdPrice !== undefined) {
                  parsedTransaction.usdPrice = usdPrice;
                  if (parsedTransaction.valueFormatted) {
                    parsedTransaction.usdValue = parseFloat(parsedTransaction.valueFormatted) * usdPrice;
                  }

                  if (parsedTransaction.internalTransactions) {
                    for (const internal of parsedTransaction.internalTransactions) {
                      if (internal.valueFormatted) {
                        internal.usdValue = parseFloat(internal.valueFormatted) * usdPrice;
                      }
                    }
                  }
                }
              } catch (e) {
                console.warn(`Failed to fetch USD price for ${symbol} at ${parsedTransaction.blockTime}`, e);
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

    // Flatten results and filter by relevant wallets
    txHashMap.forEach((txs) => {
      // Remove rawData from the final response to save some workload
      const { rawData, ...refinedTxs } = txs;
      allResults.push(refinedTxs);
    });

    return allResults;
  }
}
