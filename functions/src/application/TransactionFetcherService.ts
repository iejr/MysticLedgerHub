import { MoralisAdapter } from '../infra/MoralisAdapter.js';
import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { AssetTransfer } from '../infra/types.js';
import { CacheService } from '../domain/CacheService.js';
import { logger } from 'firebase-functions';
import { MoralisParser } from '../domain/MoralisParser.js';
import { AlchemyParser } from '../domain/AlchemyParser.js';
import { formatUnits } from "ethers";
import {
  UnifiedTransaction,
  NativeTransfer,
  TokenTransfer,
} from "../domain/types.js";

import { BlockService } from "../domain/BlockService.js";
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
}

export class TransactionFetcherService {
  private moralisAdapter: MoralisAdapter;
  private alchemyAdapter: AlchemyAdapter;
  private cacheService: CacheService;
  private blockService?: BlockService;
  private priceService?: PriceService;
  private configService?: ConfigService;
  private moralisParser: MoralisParser;
  private alchemyParser: AlchemyParser;

  constructor(
    moralisAdapter: MoralisAdapter,
    alchemyAdapter: AlchemyAdapter,
    cacheService: CacheService,
    blockService?: BlockService,
    priceService?: PriceService,
    configService?: ConfigService
  ) {
    this.moralisAdapter = moralisAdapter;
    this.alchemyAdapter = alchemyAdapter;
    this.cacheService = cacheService;
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
      throw new Error("walletAddress and chain are required for fetchAndCache");
    }

    logger.info(`fetchAndCache: starting for wallet=${walletAddress} chain=${chain}`, { fromBlock: options.fromBlock, toBlock: options.toBlock });

    const allTransactions: UnifiedTransaction[] = [];

    this.alchemyAdapter.setChain(chain);
    const iterator = this.alchemyAdapter.getAssetTransferIterator({
      fromAddress: walletAddress,
      fromBlock: options.fromBlock,
      toBlock: options.toBlock,
      category: ['external', 'erc20', 'erc721', 'erc1155'],
      withMetadata: true,
      excludeZeroValue: true,
    });

    for await (const batch of iterator) {
      const rawBatch = batch.map(t => t.rawData);
      const parsedBatch = this.alchemyParser.parse(rawBatch, walletAddress);
      parsedBatch.forEach((tx) => (tx.chain = chain));

      allTransactions.push(...parsedBatch);

      for (const tx of parsedBatch) {
        await this.cacheService.saveTransaction(walletAddress, tx.txHash, tx);
      }
    }

    logger.info(`fetchAndCache: completed for wallet=${walletAddress} chain=${chain}, txCount=${allTransactions.length}`);
    return allTransactions;
  }

  filterTransactionByAddress(transaction: UnifiedTransaction, addresses: Set<string>): boolean {
    for (const transfer of transaction.nativeTransfers) {
      if (transfer.from && addresses.has(transfer.from.toLowerCase())) return true;
      if (transfer.to && addresses.has(transfer.to.toLowerCase())) return true;
    }
    for (const transfer of transaction.tokenTransfers) {
      if (transfer.from && addresses.has(transfer.from.toLowerCase())) return true;
      if (transfer.to && addresses.has(transfer.to.toLowerCase())) return true;
    }
    return false;
  }

  extractAddressfromTransaction(transaction: UnifiedTransaction): Set<string> {
    const involvedAddresses = new Set<string>();
    for (const transfer of transaction.nativeTransfers) {
      if (transfer.from) involvedAddresses.add(transfer.from.toLowerCase());
      if (transfer.to) involvedAddresses.add(transfer.to.toLowerCase());
    }
    for (const transfer of transaction.tokenTransfers) {
      if (transfer.from) involvedAddresses.add(transfer.from.toLowerCase());
      if (transfer.to) involvedAddresses.add(transfer.to.toLowerCase());
    }
    return involvedAddresses;
  }

  filterTransactionByCallType(transaction: UnifiedTransaction): void {}

  async fetchMultiWalletTransactions(options: FetchOptions): Promise<UnifiedTransaction[]> {
    return this.fetchMultiWalletTransactionsFast(options);
  }

  async fetchMultiWalletTransactionsDetail(options: FetchOptions): Promise<UnifiedTransaction[]> {
    const wallets = options.wallets || (options.walletAddress ? [{ address: options.walletAddress, label: "Default" }] : []);
    const chains = options.chains || (options.chain ? [options.chain] : []);

    if (wallets.length === 0 || chains.length === 0) {
      throw new Error("No wallets or chains specified");
    }
    const walletSet = new Set(wallets.map((w) => w.address.toLowerCase()));

    const auxAddresses = this.configService?.getAuxiliaryAddresses() || [];
    const discoveryAddresses = [...wallets, ...auxAddresses];

    logger.info(
      `Starting fetchMultiWalletTransactionsDetail for ${wallets.length} wallets (+ ${auxAddresses.length} auxiliary) and ${chains.length} chains`,
      {
        chains,
        wallets: wallets.map((w) => w.address),
        auxAddresses: auxAddresses.map((w) => w.address),
        options,
      }
    );

    const allResults: UnifiedTransaction[] = [];
    const txHashMap = new Map<string, UnifiedTransaction>();

    for (const chain of chains) {
      logger.info(`Processing chain: ${chain}`);
      this.alchemyAdapter.setChain(chain);

      const { fromBlock, toBlock } = await this.resolveBlockRange(chain, options);
      logger.info(`Resolved block range for ${chain}: ${fromBlock} to ${toBlock}`);

      const discoveredTraceHashes = await this.discoverTraceHashes(discoveryAddresses, fromBlock, toBlock);
      logger.info(`Discovered ${discoveredTraceHashes.size} unique trace hashes for ${chain}`);

      const discoveredERC20Hashes = await this.discoverERC20Transfers(chain, discoveryAddresses, fromBlock, toBlock, options);
      logger.info(`Completed ERC20 discovery for ${chain}. Discovered ${discoveredERC20Hashes.size} hashes.`);

      const allDiscoveredHashes = new Set([...discoveredTraceHashes, ...discoveredERC20Hashes]);
      await this.fetchAndEnrichTraceTransactions(chain, allDiscoveredHashes, walletSet, txHashMap);
    }

    txHashMap.forEach((txs) => {
      allResults.push(txs);
    });

    await this.updateWalletTokens(allResults, walletSet);

    return allResults;
  }

  async fetchMultiWalletTransactionsFast(options: FetchOptions): Promise<UnifiedTransaction[]> {
    const wallets = options.wallets || (options.walletAddress ? [{ address: options.walletAddress, label: "Default" }] : []);
    const chains = options.chains || (options.chain ? [options.chain] : []);

    if (wallets.length === 0 || chains.length === 0) {
      throw new Error("No wallets or chains specified");
    }
    const walletSet = new Set(wallets.map((w) => w.address.toLowerCase()));

    const auxAddresses = this.configService?.getAuxiliaryAddresses() || [];
    const discoveryAddresses = [...wallets, ...auxAddresses];

    logger.info(
      `Starting fetchMultiWalletTransactionsFast for ${wallets.length} wallets (+ ${auxAddresses.length} auxiliary) and ${chains.length} chains`,
      {
        chains,
        wallets: wallets.map((w) => w.address),
        auxAddresses: auxAddresses.map((w) => w.address),
        options,
      }
    );

    const allResults: UnifiedTransaction[] = [];
    const txHashMap = new Map<string, UnifiedTransaction>();

    for (const chain of chains) {
      logger.info(`Processing chain (Fast): ${chain}`);
      this.alchemyAdapter.setChain(chain);

      const { fromBlock, toBlock } = await this.resolveBlockRange(chain, options);

      const discoveredTxHashes = await this.discoverAssetTransfers(chain, discoveryAddresses, fromBlock, toBlock, options);
      logger.info(`Discovered ${discoveredTxHashes.size} unique hashes for ${chain} via Fast discovery`);

      await this.fetchAndEnrichTraceTransactions(chain, discoveredTxHashes, walletSet, txHashMap);
    }

    txHashMap.forEach((txs) => {
      allResults.push(txs);
    });

    await this.updateWalletTokens(allResults, walletSet);

    return allResults;
  }

  private async resolveBlockRange(chain: string, options: FetchOptions): Promise<{ fromBlock?: number, toBlock?: number }> {
    let fromBlock = options.fromBlock;
    let toBlock = options.toBlock;

    if (!fromBlock && !toBlock) {
      if (options.startDate && this.blockService) {
        fromBlock = await this.blockService.findBlockByTimestamp(chain, options.startDate);
      }
      if (options.endDate && this.blockService) {
        toBlock = await this.blockService.findBlockByTimestamp(chain, options.endDate);
      }
    }

    return { fromBlock, toBlock };
  }

  private async discoverTraceHashes(wallets: { address: string }[], fromBlock?: number, toBlock?: number): Promise<Set<string>> {
    const discoveredTxHashes = new Set<string>();

    for (const wallet of wallets) {
      const tracesFrom = await this.alchemyAdapter.fetchTraceFilterTransactions({
        fromAddress: [wallet.address.toLowerCase()],
        fromBlock,
        toBlock,
      });

      for (const t of tracesFrom) {
        if (t.transactionHash) discoveredTxHashes.add(t.transactionHash);
      }

      const tracesTo = await this.alchemyAdapter.fetchTraceFilterTransactions({
        toAddress: [wallet.address.toLowerCase()],
        fromBlock,
        toBlock,
      });

      for (const t of tracesTo) {
        if (t.transactionHash) discoveredTxHashes.add(t.transactionHash);
      }
    }

    return discoveredTxHashes;
  }

  private async discoverERC20Transfers(
    chain: string,
    wallets: { address: string }[],
    fromBlock: number | undefined,
    toBlock: number | undefined,
    options: FetchOptions
  ): Promise<Set<string>> {
    return this.discoverAssetTransfers(chain, wallets, fromBlock, toBlock, options, ["erc20"]);
  }

  private async discoverAssetTransfers(
    chain: string,
    wallets: { address: string }[],
    fromBlock: number | undefined,
    toBlock: number | undefined,
    options: FetchOptions,
    categories: string[] = ["external", "erc20"]
  ): Promise<Set<string>> {
    logger.info(`Discovering asset transfers (${categories.join(",")}) for ${chain}...`);
    const discoveredHashes = new Set<string>();

    for (const wallet of wallets) {
      const fromParams = {
        fromBlock,
        toBlock,
        fromAddress: wallet.address.toLowerCase(),
        category: categories,
        withMetadata: true,
      };

      const toParams = {
        fromBlock,
        toBlock,
        toAddress: wallet.address.toLowerCase(),
        category: categories,
        withMetadata: true,
      };

      for (const params of [fromParams, toParams]) {
        const iterator = this.alchemyAdapter.getAssetTransferIterator(params);
        for await (const transfers of iterator) {
          const transfersByHash: Record<string, AssetTransfer[]> = {};

          for (const t of transfers) {
            // Only ERC-20 tokens recognized by the full token database (system + uniswap) pass.
            // Unknown tokens are filtered to prevent dust/spam token noise.
            if (t.category === 'erc20') {
              const tokenAddr = t.contractAddress?.toLowerCase() || '';
              if (this.configService && !this.configService.isKnownToken(chain, tokenAddr)) continue;
            }

            discoveredHashes.add(t.hash);
            if (!transfersByHash[t.hash]) transfersByHash[t.hash] = [];
            transfersByHash[t.hash].push(t);

            // Cache block metadata if present
            if (t.blockTimestamp) {
              const ts = Math.floor(new Date(t.blockTimestamp).getTime() / 1000);
              await this.cacheService.saveBlockMapping(chain, ts, t.blockNumber);
            }
          }

          // Cache token transfers for each hash
          for (const [txHash, txTransfers] of Object.entries(transfersByHash)) {
            const rawBatch = txTransfers.map(t => t.rawData);
            const parsed = this.alchemyParser.parse(rawBatch, wallet.address);
            if (parsed.length > 0 && parsed[0].tokenTransfers.length > 0) {
              await this.cacheService.saveDiscoveredTokenTransfers(chain, txHash, parsed[0].tokenTransfers);
            }
          }
        }
      }
      logger.info(`discoverAssetTransfers: wallet=${wallet.address} discovered ${discoveredHashes.size} hashes so far on ${chain}`);
    }
    return discoveredHashes;
  }

  private async fetchAndEnrichTraceTransactions(
    chain: string,
    discoveredTxHashes: Set<string>,
    walletSet: Set<string>,
    txHashMap: Map<string, UnifiedTransaction>,
  ): Promise<void> {
    const txHashesToFetch: string[] = [];

    for (const hash of discoveredTxHashes) {
      const cachedTransactionsObj = await this.cacheService.getCanonicalTransaction(chain, hash);
      if (cachedTransactionsObj && this.filterTransactionByAddress(cachedTransactionsObj.payload, walletSet)) {
        txHashMap.set(`${chain}_${hash}`, cachedTransactionsObj.payload);
        continue;
      }
      txHashesToFetch.push(hash);
    }

    const cacheHits = discoveredTxHashes.size - txHashesToFetch.length;
    logger.info(`fetchAndEnrichTraceTransactions: chain=${chain} total=${discoveredTxHashes.size} cacheHits=${cacheHits} toFetch=${txHashesToFetch.length}`);

    if (txHashesToFetch.length > 0) {
      logger.info(`Fetching ${txHashesToFetch.length} trace_transaction results for ${chain}...`);
      const batchRequests = txHashesToFetch.map((hash) => ({
        method: "trace_transaction",
        params: [hash],
      }));

      const batchResults = await this.alchemyAdapter.sendBatch(batchRequests);

      for (let i = 0; i < batchResults.length; i++) {
        const txHash = txHashesToFetch[i];
        const traces = batchResults[i];

        if (traces) {
          const distillationResult = this.alchemyParser.distillTrace(traces, chain);
          if (!distillationResult) continue;

          const { unified: parsedTransaction, raw } = distillationResult;

          // Resolve symbols/decimals for decoded transfers that are still "UNKNOWN"
          if (this.configService) {
            for (const tt of parsedTransaction.tokenTransfers) {
              if (tt.tokenSymbol === "UNKNOWN" || !tt.tokenSymbol) {
                const tokenConfig = this.configService.getTokenEntryByAddress(chain, tt.tokenAddress);
                const chainData = tokenConfig?.chains[chain.toLowerCase()];
                if (tokenConfig && chainData) {
                  const finalDecimals = chainData.decimals !== undefined ? chainData.decimals : tokenConfig.decimals;
                  tt.tokenId = tokenConfig.id;
                  tt.tokenSymbol = tokenConfig.symbol;
                  tt.tokenDecimals = finalDecimals;
                  tt.valueFormatted = formatUnits(BigInt(tt.value), tt.tokenDecimals);
                }
              }
            }
          }

          // Merge with cached token transfers from discovery
          const cachedTokenTransfers = await this.cacheService.getDiscoveredTokenTransfers(chain, txHash);
          if (cachedTokenTransfers) {
            for (const ct of cachedTokenTransfers) {
              const isDuplicate = parsedTransaction.tokenTransfers.some(
                (tt) =>
                  tt.tokenAddress.toLowerCase() === ct.tokenAddress.toLowerCase() &&
                  tt.value === ct.value &&
                  tt.to.toLowerCase() === ct.to.toLowerCase()
              );
              if (!isDuplicate) {
                parsedTransaction.tokenTransfers.push(ct);
              }
            }
          }

          if (!this.filterTransactionByAddress(parsedTransaction, walletSet)) {
            continue;
          }

          // Resolve blockTime and enrichment
          await this.enrichTraceTransaction(chain, txHash, parsedTransaction);

          const involvedAddresses = this.extractAddressfromTransaction(parsedTransaction);
          await this.cacheService.saveCanonicalTransaction(chain, txHash, parsedTransaction, Array.from(involvedAddresses));
          await this.cacheService.saveRawTransaction(chain, txHash, "alchemy_trace_transaction", traces);

          txHashMap.set(`${chain}_${txHash}`, parsedTransaction);
        }
      }

      logger.info(`fetchAndEnrichTraceTransactions: chain=${chain} completed, enriched ${txHashMap.size} transactions`);
    }
  }

  private async enrichTraceTransaction(chain: string, txHash: string, parsedTransaction: UnifiedTransaction): Promise<void> {
    if (this.blockService) {
      try {
        parsedTransaction.blockTime = await this.blockService.getBlockTime(chain, parsedTransaction.blockNumber);
      } catch (e) {
        logger.warn(`Failed to fetch block timestamp for hash ${txHash}`, e);
      }
    }

    if (this.configService) {
      parsedTransaction.chainName = this.configService.getChainMetadata(chain)?.name;

      for (const tt of parsedTransaction.tokenTransfers) {
        if (!tt.tokenId && tt.tokenAddress) {
          const tokenConfig = this.configService.getTokenByAddress(chain, tt.tokenAddress);
          if (tokenConfig) tt.tokenId = tokenConfig.id;
        }
      }
    }

    await this.enrichTransactionWithUSD(parsedTransaction);
  }

  /**
   * Extract per-wallet token interactions from enriched transactions.
   * Uses max(blockTime) as lastSeen — most-recent interaction per token.
   * lastSeen is preferred over firstSeen because firstSeen requires backfilling
   * to genesis to be accurate; a wrong firstSeen would risk mis-filtering useful tokens.
   * lastSeen is metadata only and is NOT used to filter tokens in balance fetch.
   */
  private async updateWalletTokens(transactions: UnifiedTransaction[], walletSet: Set<string>): Promise<void> {
    // Collect: { walletKey → { tokenId → latestBlockTime } }
    const walletTokenMap = new Map<string, Map<string, string>>();

    for (const tx of transactions) {
      for (const tt of tx.tokenTransfers) {
        if (!tt.tokenId) continue;

        // Check both from and to — wallet might be on either side
        const addresses = [tt.from, tt.to].filter(a => walletSet.has(a.toLowerCase()));
        for (const addr of addresses) {
          const key = `${addr.toLowerCase()}_${tx.chain}`;
          if (!walletTokenMap.has(key)) walletTokenMap.set(key, new Map());
          const tokenMap = walletTokenMap.get(key)!;
          const existing = tokenMap.get(tt.tokenId);
          if (!existing || tx.blockTime > existing) {
            tokenMap.set(tt.tokenId, tx.blockTime);
          }
        }
      }
    }

    // Save each (wallet, chain) entry
    let totalTokenEntries = 0;
    for (const [key, tokenMap] of walletTokenMap) {
      const [wallet, chain] = key.split('_');
      const tokens = Array.from(tokenMap.entries()).map(([tokenId, lastSeen]) => ({ tokenId, lastSeen }));
      totalTokenEntries += tokens.length;
      await this.cacheService.saveWalletTokens(wallet, chain, tokens);
    }

    logger.info(`updateWalletTokens: updated ${walletTokenMap.size} wallet-chain pairs with ${totalTokenEntries} total token entries`);
  }

  private async enrichTransactionWithUSD(tx: UnifiedTransaction): Promise<void> {
    if (!this.priceService) return;

    const chain = tx.chain;
    let nativeSymbol = "ETH";
    let nativeTokenId = "native-eth";
    if (this.configService) {
      const meta = this.configService.getChainMetadata(chain);
      if (meta) nativeSymbol = meta.nativeSymbol;
      const nativeToken = this.configService.getTokensForChain(chain).find(t => t.type === 'native');
      if (nativeToken) nativeTokenId = nativeToken.id;
    }

    try {
      const nativeUsdPrice = await this.priceService.getPriceAtTime(
        nativeTokenId,
        { symbol: nativeSymbol, chain },
        new Date(tx.blockTime)
      );
      if (nativeUsdPrice !== undefined) {
        tx.usdPrice = nativeUsdPrice;
        for (const nt of tx.nativeTransfers) {
          nt.usdValue = parseFloat(nt.valueFormatted) * nativeUsdPrice;
        }
      }
    } catch (e) {
      logger.warn(`Failed to fetch native USD price for ${nativeSymbol} at ${tx.blockTime}`, e);
    }

    for (const tt of tx.tokenTransfers) {
      if (tt.tokenSymbol === 'UNKNOWN' || !tt.tokenId) {
        tt.usdValue = 0;
        continue;
      }

      try {
        const tokenUsdPrice = await this.priceService.getPriceAtTime(
          tt.tokenId,
          { symbol: tt.tokenSymbol, chain, contractAddress: tt.tokenAddress },
          new Date(tx.blockTime)
        );
        if (tokenUsdPrice !== undefined) {
          tt.usdValue = parseFloat(tt.valueFormatted) * tokenUsdPrice;
        }
      } catch (e) {
        logger.warn(`Failed to fetch token USD price for ${tt.tokenSymbol} at ${tx.blockTime}`, e);
      }
    }
  }
}
