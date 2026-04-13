import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { BalanceBatchRequest } from '../infra/types.js';
import { ConfigService, WalletMetadata, TokenMetadata } from '../domain/ConfigService.js';
import { UnifiedBalance } from '../domain/types.js';
import { PriceService } from '../domain/PriceService.js';
import { BlockService } from '../domain/BlockService.js';
import { CacheService } from '../domain/CacheService.js';
import { logger } from 'firebase-functions';

export interface BalanceFetchOptions {
  wallets?: WalletMetadata[];
  timestamp?: Date;
  blockNumber?: number;
  chainBlockNumbers?: Record<string, number>;
  includeUsd?: boolean;
  requestedDate?: string;
}

export class BalanceFetcherService {
  private alchemyAdapter: AlchemyAdapter;
  private configService: ConfigService;
  private priceService: PriceService;
  private blockService?: BlockService;
  private cacheService: CacheService;

  constructor(
    alchemyAdapter: AlchemyAdapter,
    configService: ConfigService,
    priceService: PriceService,
    cacheService: CacheService,
    blockService?: BlockService
  ) {
    this.alchemyAdapter = alchemyAdapter;
    this.configService = configService;
    this.priceService = priceService;
    this.cacheService = cacheService;
    this.blockService = blockService;
  }

  async fetchBalances(options: BalanceFetchOptions): Promise<UnifiedBalance[]> {
    const wallets = options.wallets || this.configService.getWallets();
    const globalIncludeUsd = options.includeUsd !== undefined ? options.includeUsd : this.configService.getGlobalIncludeUsd();

    logger.info(`fetchBalances: starting for ${wallets.length} wallets`, {
      timestamp: options.timestamp?.toISOString(),
      blockNumber: options.blockNumber,
      includeUsd: globalIncludeUsd,
    });

    // Resolve timestamp → per-chain block numbers if needed
    let chainBlockNumbers = options.chainBlockNumbers;
    let requestedDate = options.requestedDate;

    if (options.timestamp && !chainBlockNumbers) {
      if (!this.blockService) throw new Error('BlockService not initialized — required for timestamp-based queries');

      const uniqueChains = new Set<string>();
      for (const wallet of wallets) {
        this.configService.getWalletEffectiveChains(wallet).forEach(c => uniqueChains.add(c));
      }

      chainBlockNumbers = {};
      for (const chain of uniqueChains) {
        chainBlockNumbers[chain] = await this.blockService.findBlockByTimestamp(chain, options.timestamp);
      }
      requestedDate = options.timestamp.toISOString();
    }

    const allBalances: UnifiedBalance[] = [];

    // Group wallets by chain
    const chainToWallets: Record<string, WalletMetadata[]> = {};
    for (const wallet of wallets) {
      const chains = this.configService.getWalletEffectiveChains(wallet);
      for (const chain of chains) {
        if (!chainToWallets[chain]) chainToWallets[chain] = [];
        chainToWallets[chain]!.push(wallet);
      }
    }

    logger.info(`fetchBalances: querying ${Object.keys(chainToWallets).length} chains`, { chains: Object.keys(chainToWallets) });

    for (const [chain, chainWallets] of Object.entries(chainToWallets)) {
      this.alchemyAdapter.setChain(chain);
      const blockNumber = chainBlockNumbers?.[chain] || options.blockNumber;

      const batchRequests: BalanceBatchRequest[] = [];
      const requestMeta: { wallet: string; token: any }[] = [];
      let cacheHits = 0;

      for (const wallet of chainWallets) {
        // Base tokens (from tokens.yaml) are always queried.
        // Merge with wallet_tokens cache to add tokens the wallet has interacted with.
        const tokens = await this.resolveTokensForWallet(wallet.address, chain);

        for (const token of tokens) {
          const cached = await this.cacheService.getBalance(wallet.address, chain, token.id, blockNumber);
          if (cached) {
            allBalances.push({ ...cached, requestedDate });
            cacheHits++;
            continue;
          }

          if (token.type === 'native') {
            batchRequests.push({ type: 'native', walletAddress: wallet.address });
          } else {
            const contractAddress = token.chains[chain.toLowerCase()]?.address;
            if (contractAddress) {
              batchRequests.push({ type: 'erc20', walletAddress: wallet.address, contractAddress });
            }
          }
          requestMeta.push({ wallet: wallet.address, token });
        }
      }

      logger.info(`fetchBalances: chain=${chain} cacheHits=${cacheHits} toFetch=${batchRequests.length}`);
      if (batchRequests.length === 0) continue;

      const batchResults = await this.alchemyAdapter.sendBalanceBatch(batchRequests, blockNumber || 'latest');

      // Resolve block timestamp
      const block = await this.alchemyAdapter.getBlock(blockNumber || 'latest');
      const blocktime = block ? new Date(block.timestamp * 1000).toISOString() : new Date().toISOString();
      const blockTimeDate = new Date(blocktime);

      for (let j = 0; j < batchRequests.length; j++) {
        const meta = requestMeta[j]!;
        const result = batchResults[j];
        const token = meta.token;
        const balanceValue = BigInt(result === '0x' || !result ? '0' : result);
        const balanceFormatted = (Number(balanceValue) / Math.pow(10, token.decimals)).toString();

        const balance: UnifiedBalance = {
          walletAddress: meta.wallet,
          chain,
          chainName: this.configService.getChainMetadata(chain)?.name,
          tokenId: token.id,
          tokenSymbol: token.symbol,
          tokenName: token.name,
          balance: balanceValue.toString(),
          balanceFormatted,
          decimals: token.decimals,
          blockNumber: blockNumber,
          blocktime,
          requestedDate,
          updatedAt: new Date().toISOString(),
        };

        if (globalIncludeUsd) {
          const usdPrice = await this.priceService.getPriceAtTime(
            token.id,
            { symbol: token.symbol, chain, contractAddress: token.chains[chain.toLowerCase()]?.address },
            blockTimeDate
          );
          if (usdPrice !== undefined) {
            balance.usdPrice = usdPrice;
            balance.usdBalance = parseFloat(balance.balanceFormatted) * usdPrice;
          }
        }

        await this.cacheService.saveBalance(balance);
        allBalances.push(balance);
      }
    }

    logger.info(`fetchBalances: completed with ${allBalances.length} total balances`);
    return allBalances;
  }

  /**
   * Resolve the list of tokens to query for a wallet on a chain.
   * Always starts from the base set in tokens.yaml (via getTokensForChain), then merges
   * any additional tokens from wallet_tokens (populated from transaction history).
   * If wallet_tokens is empty, only the base tokens are returned.
   * Note: lastSeen is not used for filtering — it's metadata only.
   */
  private async resolveTokensForWallet(wallet: string, chain: string): Promise<TokenMetadata[]> {
    // Start from base tokens in tokens.yaml
    const baseTokens = this.configService.getTokensForChain(chain);
    const tokenMap = new Map<string, TokenMetadata>();
    for (const t of baseTokens) tokenMap.set(t.id, t);

    // Merge wallet_tokens from transaction history
    const walletTokens = await this.cacheService.getWalletTokens(wallet, chain);
    let addedFromHistory = 0;
    for (const wt of walletTokens) {
      if (tokenMap.has(wt.tokenId)) continue;
      const tokenEntry = this.configService.getTokenEntryById(wt.tokenId);
      if (tokenEntry) {
        tokenMap.set(wt.tokenId, tokenEntry);
        addedFromHistory++;
      }
    }

    logger.info(
      `resolveTokensForWallet: wallet=${wallet} chain=${chain} base=${baseTokens.length} fromHistory=${addedFromHistory} total=${tokenMap.size}`
    );
    return Array.from(tokenMap.values());
  }
}
