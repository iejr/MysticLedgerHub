import { MoralisAdapter } from '../infra/MoralisAdapter.js';
import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { FirestoreAdapter } from '../infra/FirestoreAdapter.js';
import { logger } from 'firebase-functions';
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
    return this.fetchMultiWalletTransactionsTrace(options);
  }

  async fetchMultiWalletTransactionsDebug(options: FetchOptions): Promise<UnifiedTransaction[]> {
    const wallets = options.wallets || (options.walletAddress ? [{ address: options.walletAddress, label: 'Default' }] : []);
    const chains = options.chains || (options.chain ? [options.chain] : []);

    if (wallets.length === 0 || chains.length === 0) {
      throw new Error('No wallets or chains specified');
    }
    const walletSet = new Set(wallets.map((w) => w.address.toLowerCase()));

    logger.info(`Starting fetchMultiWalletTransactionsDetail for ${wallets.length} wallets and ${chains.length} chains`, {
      chains,
      wallets: wallets.map(w => w.address),
      options
    });

    let allResults: UnifiedTransaction[] = [];
    const txHashMap = new Map<string, UnifiedTransaction>(); // chain_txHash -> UnifiedTransaction

    for (const chain of chains) {
      logger.info(`Processing chain: ${chain}`);
      this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));

      // 1. Resolve block range
      const { hexFromBlock, hexToBlock } = await this.resolveBlockRange(chain, options);
      logger.info(`Resolved block range for ${chain}: ${hexFromBlock} to ${hexToBlock}`);

      // 2. Discover transaction hashes and explicit ERC20 transfers
      const discoveredTxHashes = await this.discoverTraceHashes(wallets, hexFromBlock, hexToBlock);
      logger.info(`Discovered ${discoveredTxHashes.size} unique trace hashes for ${chain}`);

      await this.discoverERC20Transfers(chain, wallets, hexFromBlock, hexToBlock, txHashMap, options);
      logger.info(`Completed ERC20 discovery for ${chain}. Current total txs: ${txHashMap.size}`);

      // 3. Fetch detailed traces and enrich
      await this.fetchAndEnrichTraceTransactions(chain, discoveredTxHashes, walletSet, txHashMap, options);
    }

    // Flatten results and filter by relevant wallets
    txHashMap.forEach((txs) => {
      // Remove rawData from the final response to save some workload
      const { rawData, ...refinedTxs } = txs;
      allResults.push(refinedTxs);
    });

    return allResults;
  }

  async fetchMultiWalletTransactionsTrace(options: FetchOptions): Promise<UnifiedTransaction[]> {
    const wallets = options.wallets || (options.walletAddress ? [{ address: options.walletAddress, label: 'Default' }] : []);
    const chains = options.chains || (options.chain ? [options.chain] : []);

    if (wallets.length === 0 || chains.length === 0) {
      throw new Error('No wallets or chains specified');
    }
    const walletSet = new Set(wallets.map((w) => w.address.toLowerCase()));

    logger.info(`Starting fetchMultiWalletTransactionsTrace for ${wallets.length} wallets and ${chains.length} chains`, {
      chains,
      wallets: wallets.map(w => w.address),
      options
    });

    let allResults: UnifiedTransaction[] = [];
    const txHashMap = new Map<string, UnifiedTransaction>(); // chain_txHash -> UnifiedTransaction

    for (const chain of chains) {
      logger.info(`Processing chain (Fast): ${chain}`);
      this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));

      // 1. Resolve block range
      const { hexFromBlock, hexToBlock } = await this.resolveBlockRange(chain, options);

      // 2. Discover transaction hashes (external + erc20)
      const discoveredTxHashes = await this.discoverAssetTransfers(chain, wallets, hexFromBlock, hexToBlock, txHashMap, options);
      logger.info(`Discovered ${discoveredTxHashes.size} unique hashes for ${chain} via Fast discovery`);

      // 3. Fetch detailed traces and enrich (merges with asset transfers already in txHashMap)
      await this.fetchAndEnrichTraceTransactions(chain, discoveredTxHashes, walletSet, txHashMap, options);
    }

    // Flatten results
    txHashMap.forEach((txs) => {
      const { rawData, ...refinedTxs } = txs;
      allResults.push(refinedTxs);
    });

    return allResults;
  }

  private async resolveBlockRange(chain: string, options: FetchOptions): Promise<{ hexFromBlock: string, hexToBlock: string }> {
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

    return {
      hexFromBlock: fromBlock ? `0x${fromBlock.toString(16)}` : '0x0',
      hexToBlock: toBlock ? `0x${toBlock.toString(16)}` : 'latest',
    };
  }

  private async discoverTraceHashes(wallets: { address: string }[], hexFromBlock: string, hexToBlock: string): Promise<Set<string>> {
    const discoveredTxHashes = new Set<string>();

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

    return discoveredTxHashes;
  }

  private async discoverERC20Transfers(
    chain: string,
    wallets: { address: string }[],
    hexFromBlock: string,
    hexToBlock: string,
    txHashMap: Map<string, UnifiedTransaction>,
    options: FetchOptions
  ): Promise<Set<string>> {
    return this.discoverAssetTransfers(chain, wallets, hexFromBlock, hexToBlock, txHashMap, options, ["erc20"]);
  }

  private async discoverAssetTransfers(
    chain: string,
    wallets: { address: string }[],
    hexFromBlock: string,
    hexToBlock: string,
    txHashMap: Map<string, UnifiedTransaction>,
    options: FetchOptions,
    categories: string[] = ["external", "erc20"]
  ): Promise<Set<string>> {
    logger.info(`Discovering asset transfers (${categories.join(",")}) for ${chain}...`);
    const discoveredHashes = new Set<string>();

    const allowedTokens = this.configService ? this.configService.getTokensForChain(chain) : [];
    const allowedTokenAddresses = new Set(
      allowedTokens
        .map((t) => {
          const addr = t.chains[chain.toLowerCase()]?.address;
          return addr ? addr.toLowerCase() : "";
        })
        .filter((a) => a !== "")
    );

    // Resolve native symbol for the chain
    let nativeSymbol = "ETH";
    if (this.configService) {
      const meta = this.configService.getChainMetadata(chain);
      if (meta) nativeSymbol = meta.nativeSymbol;
    }

    for (const wallet of wallets) {
      const fromParams = {
        fromBlock: hexFromBlock,
        toBlock: hexToBlock,
        fromAddress: wallet.address.toLowerCase(),
        category: categories,
        withMetadata: true,
      };

      const toParams = {
        fromBlock: hexFromBlock,
        toBlock: hexToBlock,
        toAddress: wallet.address.toLowerCase(),
        category: categories,
        withMetadata: true,
      };

      for (const params of [fromParams, toParams]) {
        const iterator = this.alchemyAdapter.getTransactionsIterator(params as any);
        for await (const transfers of iterator) {
          const parsedTransfers = this.alchemyParser.parse(transfers, wallet.address);
          for (const tx of parsedTransfers) {
            // Spam filtering for ERC20
            if (tx.type === "erc20") {
              if (!tx.tokenAddress || !allowedTokenAddresses.has(tx.tokenAddress.toLowerCase())) {
                continue;
              }
            }

            discoveredHashes.add(tx.txHash);
            tx.chain = chain;

            // If we already have this tx in hash map (e.g. from previous from/to params in this loop), skip enrichment but keep the hash
            if (txHashMap.has(`${chain}_${tx.txHash}`)) continue;

            const symbol = tx.type === "erc20" ? tx.tokenSymbol || nativeSymbol : nativeSymbol;
            await this.enrichTransactionWithUSD(tx, symbol);

            // We store the asset transfer summary in the hash map.
            // It will be replaced/merged if a full trace is fetched later.
            txHashMap.set(`${chain}_${tx.txHash}`, tx);
            logger.info(`Discovered and enriched ${tx.type} transfer: ${tx.txHash} (${symbol})`);
          }
        }
      }
    }
    return discoveredHashes;
  }

  private async fetchAndEnrichTraceTransactions(
    chain: string,
    discoveredTxHashes: Set<string>,
    walletSet: Set<string>,
    txHashMap: Map<string, UnifiedTransaction>,
    options: FetchOptions
  ): Promise<void> {
    const txHashesToFetch: string[] = [];

    for (const hash of discoveredTxHashes) {
      if (options.useCache !== false) {
        const cachedTransactionsObj = await this.firestoreAdapter.getCanonicalTransaction(chain, hash);
        if (cachedTransactionsObj && this.filterTransactionByAddress(cachedTransactionsObj.payload, walletSet)) {
          // If we already have asset transfer summary, we merge it with the cached trace (trace takes precedence for core fields)
          const existingSummary = txHashMap.get(`${chain}_${hash}`);
          if (existingSummary && existingSummary.type === "erc20") {
            // Keep the token information from the asset transfer summary if the trace is 'regular'
            // and the summary is 'erc20' (since traces don't easily give token info for events)
            const traceTx = cachedTransactionsObj.payload;
            if (traceTx.type === "regular") {
              traceTx.tokenSymbol = existingSummary.tokenSymbol;
              traceTx.tokenAddress = existingSummary.tokenAddress;
              traceTx.tokenDecimals = existingSummary.tokenDecimals;
              traceTx.type = "erc20";
            }
          }
          txHashMap.set(`${chain}_${hash}`, cachedTransactionsObj.payload);
          continue;
        }
      }
      txHashesToFetch.push(hash);
    }

    if (txHashesToFetch.length > 0) {
      logger.info(`Fetching ${txHashesToFetch.length} trace_transaction results for ${chain}...`);
      const batchRequests = txHashesToFetch.map((hash) => ({
        method: "trace_transaction",
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

          // Merge with existing asset transfer summary if present
          const existingSummary = txHashMap.get(`${chain}_${txHash}`);
          if (existingSummary && existingSummary.type === "erc20") {
            parsedTransaction.tokenSymbol = existingSummary.tokenSymbol;
            parsedTransaction.tokenAddress = existingSummary.tokenAddress;
            parsedTransaction.tokenDecimals = existingSummary.tokenDecimals;
            parsedTransaction.type = "erc20";
            // Also inherit USD price and value if already enriched
            if (existingSummary.usdPrice) parsedTransaction.usdPrice = existingSummary.usdPrice;
          }

          // Resolve blockTime and enrichment
          await this.enrichTraceTransaction(chain, txHash, parsedTransaction);

          logger.info(`Enriched trace transaction: ${txHash} (${parsedTransaction.blockTime})`);

          const involvedAddresses = this.extractAddressfromTransaction(parsedTransaction);
          if (options.useCache !== false) {
            await this.firestoreAdapter.saveCanonicalTransaction(chain, txHash, parsedTransaction, Array.from(involvedAddresses));
          }

          txHashMap.set(`${chain}_${txHash}`, parsedTransaction);
        }
      }
    }
  }

  private async enrichTraceTransaction(chain: string, txHash: string, parsedTransaction: UnifiedTransaction): Promise<void> {
    // Resolve blockTime if needed
    if (this.blockService) {
      try {
        const block = await this.alchemyAdapter.getBlock(`0x${parsedTransaction.blockNumber.toString(16)}`);
        if (block && block.timestamp) {
          parsedTransaction.blockTime = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
        }
      } catch (e) {
        console.warn(`Failed to fetch block timestamp for hash ${txHash}`, e);
      }
    }

    // Resolve symbol
    let symbol = parsedTransaction.tokenSymbol;
    if (!symbol && this.configService) {
      const meta = this.configService.getChainMetadata(chain);
      if (meta) symbol = meta.nativeSymbol;
    }
    if (!symbol) symbol = 'ETH';

    await this.enrichTransactionWithUSD(parsedTransaction, symbol);
  }

  private async enrichTransactionWithUSD(tx: UnifiedTransaction, symbol: string): Promise<void> {
    if (!this.priceService) return;

    try {
      const usdPrice = await this.priceService.getPriceAtTime(symbol, new Date(tx.blockTime));
      if (usdPrice !== undefined) {
        tx.usdPrice = usdPrice;
        if (tx.valueFormatted) {
          tx.usdValue = parseFloat(tx.valueFormatted) * usdPrice;
        }

        if (tx.internalTransactions) {
          for (const internal of tx.internalTransactions) {
            if (internal.valueFormatted) {
              internal.usdValue = parseFloat(internal.valueFormatted) * usdPrice;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch USD price for ${symbol} at ${tx.blockTime}`, e);
    }
  }
}
