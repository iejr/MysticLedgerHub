import { MoralisAdapter } from '../infra/MoralisAdapter.js';
import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { FirestoreAdapter } from '../infra/FirestoreAdapter.js';
import { logger } from 'firebase-functions';
import { MoralisParser } from '../domain/MoralisParser.js';
import { AlchemyParser } from '../domain/AlchemyParser.js';
import {
  UnifiedTransaction,
  NativeTransfer,
  TokenTransfer,
} from "../domain/types.js";
import { AlchemyRequestConverter } from "../domain/RequestConverters.js";

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
      throw new Error("walletAddress and chain are required for fetchAndCache");
    }

    const allTransactions: UnifiedTransaction[] = [];

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
      parsedBatch.forEach((tx) => (tx.chain = chain));

      allTransactions.push(...parsedBatch);

      for (const tx of parsedBatch) {
        await this.firestoreAdapter.saveTransaction(walletAddress, tx.txHash, tx);
      }
    }

    return allTransactions;
  }

  filterTransactionByAddress(transaction: UnifiedTransaction, addresses: Set<string>): boolean {
    // Check native transfers
    for (const transfer of transaction.nativeTransfers) {
      if (transfer.from && addresses.has(transfer.from.toLowerCase())) return true;
      if (transfer.to && addresses.has(transfer.to.toLowerCase())) return true;
    }
    // Check token transfers
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
      this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));

      const { hexFromBlock, hexToBlock } = await this.resolveBlockRange(chain, options);
      logger.info(`Resolved block range for ${chain}: ${hexFromBlock} to ${hexToBlock}`);

      const discoveredTxHashes = await this.discoverTraceHashes(discoveryAddresses, hexFromBlock, hexToBlock);
      logger.info(`Discovered ${discoveredTxHashes.size} unique trace hashes for ${chain}`);

      await this.discoverERC20Transfers(chain, discoveryAddresses, hexFromBlock, hexToBlock, txHashMap, options);
      logger.info(`Completed ERC20 discovery for ${chain}. Current total txs: ${txHashMap.size}`);

      await this.fetchAndEnrichTraceTransactions(chain, discoveredTxHashes, walletSet, txHashMap, options);
    }

    txHashMap.forEach((txs) => {
      allResults.push(txs);
    });

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
      this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));

      const { hexFromBlock, hexToBlock } = await this.resolveBlockRange(chain, options);

      const discoveredTxHashes = await this.discoverAssetTransfers(chain, discoveryAddresses, hexFromBlock, hexToBlock, txHashMap, options);
      logger.info(`Discovered ${discoveredTxHashes.size} unique hashes for ${chain} via Fast discovery`);

      await this.fetchAndEnrichTraceTransactions(chain, discoveredTxHashes, walletSet, txHashMap, options);
    }

    txHashMap.forEach((txs) => {
      allResults.push(txs);
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
            const isSpam = tx.tokenTransfers.some((tt) => !allowedTokenAddresses.has(tt.tokenAddress.toLowerCase()));
            if (tx.tokenTransfers.length > 0 && isSpam) {
              continue;
            }

            discoveredHashes.add(tx.txHash);
            tx.chain = chain;

            if (txHashMap.has(`${chain}_${tx.txHash}`)) continue;

            await this.enrichTransactionWithUSD(tx);

            txHashMap.set(`${chain}_${tx.txHash}`, tx);
            logger.info(`Discovered and enriched asset transfers for: ${tx.txHash}`);
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
          const distillationResult = this.alchemyParser.distillTrace(traces, chain);
          if (!distillationResult) continue;

          const { unified: parsedTransaction, raw } = distillationResult;

          // Merge with existing asset transfer summary if present (especially to get token metadata)
          const existingSummary = txHashMap.get(`${chain}_${txHash}`);
          if (existingSummary) {
            for (const st of existingSummary.tokenTransfers) {
              if (!parsedTransaction.tokenTransfers.some((tt) => tt.tokenAddress === st.tokenAddress && tt.value === st.value)) {
                parsedTransaction.tokenTransfers.push(st);
              }
            }
          }

          // Resolve blockTime and enrichment
          await this.enrichTraceTransaction(chain, txHash, parsedTransaction);

          const involvedAddresses = this.extractAddressfromTransaction(parsedTransaction);
          if (options.useCache !== false) {
            await this.firestoreAdapter.saveCanonicalTransaction(chain, txHash, parsedTransaction, Array.from(involvedAddresses));
            // Save raw transaction
            await this.firestoreAdapter.saveRawTransaction(chain, txHash, "alchemy_trace_transaction", traces);
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

    await this.enrichTransactionWithUSD(parsedTransaction);
  }

  private async enrichTransactionWithUSD(tx: UnifiedTransaction): Promise<void> {
    if (!this.priceService) return;

    let nativeSymbol = "ETH";
    if (this.configService) {
      const meta = this.configService.getChainMetadata(tx.chain);
      if (meta) nativeSymbol = meta.nativeSymbol;
    }

    try {
      const nativeUsdPrice = await this.priceService.getPriceAtTime(nativeSymbol, new Date(tx.blockTime));
      if (nativeUsdPrice !== undefined) {
        tx.usdPrice = nativeUsdPrice;
        for (const nt of tx.nativeTransfers) {
          nt.usdValue = parseFloat(nt.valueFormatted) * nativeUsdPrice;
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch native USD price for ${nativeSymbol} at ${tx.blockTime}`, e);
    }

    for (const tt of tx.tokenTransfers) {
      try {
        const tokenUsdPrice = await this.priceService.getPriceAtTime(tt.tokenSymbol, new Date(tx.blockTime));
        if (tokenUsdPrice !== undefined) {
          tt.usdValue = parseFloat(tt.valueFormatted) * tokenUsdPrice;
        }
      } catch (e) {
        console.warn(`Failed to fetch token USD price for ${tt.tokenSymbol} at ${tx.blockTime}`, e);
      }
    }
  }
}
