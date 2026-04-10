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
      const fallbackTokens = this.configService.getTokensForChain(chain);

      const batchRequests: BalanceBatchRequest[] = [];
      const requestMeta: { wallet: string; token: any }[] = [];
      let cacheHits = 0;

      for (const wallet of chainWallets) {
        // Determine which tokens to query for this wallet
        const tokensForWallet = await this.resolveTokensForWallet(wallet.address, chain, requestedDate);
        const tokens = tokensForWallet.length > 0 ? tokensForWallet : fallbackTokens;

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
   * Derive tokens from transaction history. For historical queries, only include
   * tokens with firstSeen <= requested date to avoid querying tokens the wallet
   * hadn't interacted with yet.
   * Returns empty array if no wallet_tokens exist (caller falls back to system allowlist).
   */
  private async resolveTokensForWallet(wallet: string, chain: string, requestedDate?: string): Promise<TokenMetadata[]> {
    const walletTokens = await this.cacheService.getWalletTokens(wallet, chain);
    if (walletTokens.length === 0) {
      logger.info(`resolveTokensForWallet: wallet=${wallet} chain=${chain} no wallet_tokens found, falling back to system allowlist`);
      return [];
    }

    const tokens: TokenMetadata[] = [];

    // Always include native token
    const nativeToken = this.configService.getTokensForChain(chain).find(t => t.type === 'native');
    if (nativeToken) tokens.push(nativeToken);

    for (const wt of walletTokens) {
      // Filter by firstSeen for historical queries
      if (requestedDate && wt.firstSeen > requestedDate) continue;

      const tokenEntry = this.configService.getTokenEntryById(wt.tokenId);
      if (tokenEntry) tokens.push(tokenEntry);
    }

    logger.info(`resolveTokensForWallet: wallet=${wallet} chain=${chain} using wallet_tokens, tokenCount=${tokens.length}`, { requestedDate });
    return tokens;
  }
}
