import { logger } from 'firebase-functions';
import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { BalanceBatchRequest } from '../infra/types.js';
import { ConfigService, WalletMetadata } from '../domain/ConfigService.js';
import { UnifiedBalance } from '../domain/types.js';
import { PriceService } from '../domain/PriceService.js';
import { BlockService } from '../domain/BlockService.js';
import { CacheService } from '../domain/CacheService.js';

export interface BalanceFetchOptions {
  walletAddress: string;
  chain: string;
  blockNumber?: number;
  includeUsd: boolean;
}

export interface MultiWalletBalanceFetchOptions {
  wallets?: WalletMetadata[];
  chains?: string[];
  blockNumber?: number;
  chainBlockNumbers?: Record<string, number>;
  includeUsd?: boolean;
  requestedDate?: string;
}

export interface MultiWalletBalanceByTimestampOptions {
  wallets?: WalletMetadata[];
  timestamp: Date;
  includeUsd?: boolean;
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
    const { walletAddress, chain, blockNumber, includeUsd } = options;
    logger.info(`Fetching balances for ${walletAddress} on ${chain}`, { blockNumber, includeUsd });

    this.alchemyAdapter.setChain(chain);

    const tokens = this.configService.getTokensForChain(chain);

    const finalBalances: UnifiedBalance[] = [];
    const tokensToFetch: any[] = [];

    for (const token of tokens) {
      const cached = await this.cacheService.getBalance(walletAddress, chain, token.id, blockNumber);
      if (cached) {
        logger.info(`Found cached balance for ${token.symbol}`);
        finalBalances.push(cached);
      } else {
        tokensToFetch.push(token);
      }
    }

    if (tokensToFetch.length === 0) {
      logger.info(`All balances for ${walletAddress} on ${chain} served from cache.`);
      return finalBalances;
    }

    // Fetch missing balances from provider
    logger.info(`Fetching ${tokensToFetch.length} balances for ${walletAddress} on ${chain}...`);
    const batchRequests: BalanceBatchRequest[] = tokensToFetch.map(token => {
      if (token.type === 'native') {
        return { type: 'native' as const, walletAddress };
      } else {
        return {
          type: 'erc20' as const,
          walletAddress,
          contractAddress: token.chains[chain.toLowerCase()]?.address,
        };
      }
    });

    const batchResults = await this.alchemyAdapter.sendBalanceBatch(batchRequests, blockNumber || 'latest');

    // Resolve block timestamp
    const block = await this.alchemyAdapter.getBlock(blockNumber || 'latest');
    const blocktime = block ? new Date(block.timestamp * 1000).toISOString() : new Date().toISOString();
    const blockTimeDate = new Date(blocktime);

    for (let i = 0; i < tokensToFetch.length; i++) {
      const token = tokensToFetch[i]!;
      const result = batchResults[i];
      const balanceValue = BigInt(result === '0x' || !result ? '0' : result);
      const balanceFormatted = (Number(balanceValue) / Math.pow(10, token.decimals)).toString();

      const balance: UnifiedBalance = {
        walletAddress,
        chain,
        chainName: this.configService.getChainMetadata(chain)?.name,
        tokenId: token.id,
        tokenSymbol: token.symbol,
        tokenName: token.name,
        balance: balanceValue.toString(),
        balanceFormatted,
        decimals: token.decimals,
        blockNumber,
        blocktime,
        updatedAt: new Date().toISOString(),
      };

      if (includeUsd) {
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
      finalBalances.push(balance);
    }

    logger.info(`Successfully fetched and enriched ${finalBalances.length} balances for ${walletAddress} on ${chain}`);
    return finalBalances;
  }

  async fetchMultiWalletBalances(options: MultiWalletBalanceFetchOptions): Promise<UnifiedBalance[]> {
    const wallets = options.wallets || this.configService.getWallets();
    const globalIncludeUsd = options.includeUsd !== undefined ? options.includeUsd : this.configService.getGlobalIncludeUsd();

    const allBalances: UnifiedBalance[] = [];

    const chainToWallets: Record<string, WalletMetadata[]> = {};
    for (const wallet of wallets) {
      const chains = this.configService.getWalletEffectiveChains(wallet);
      for (const chain of chains) {
        if (!chainToWallets[chain]) chainToWallets[chain] = [];
        chainToWallets[chain]!.push(wallet);
      }
    }

    for (const [chain, chainWallets] of Object.entries(chainToWallets)) {
      this.alchemyAdapter.setChain(chain);
      const tokens = this.configService.getTokensForChain(chain);
      const blockNumber = options.chainBlockNumbers?.[chain] || options.blockNumber;

      const batchRequests: BalanceBatchRequest[] = [];
      const requestMeta: { wallet: string; token: any }[] = [];

      for (const wallet of chainWallets) {
        for (const token of tokens) {
          const cached = await this.cacheService.getBalance(wallet.address, chain, token.id, blockNumber);
          if (cached) {
            allBalances.push({ ...cached, requestedDate: options.requestedDate });
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
          requestedDate: options.requestedDate,
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

    return allBalances;
  }

  async fetchMultiWalletBalancesByTimestamp(options: MultiWalletBalanceByTimestampOptions): Promise<UnifiedBalance[]> {
    if (!this.blockService) throw new Error('BlockService not initialized');

    const wallets = options.wallets || this.configService.getWallets();
    const uniqueChains = new Set<string>();
    for (const wallet of wallets) {
      this.configService.getWalletEffectiveChains(wallet).forEach(c => uniqueChains.add(c));
    }

    const chainBlockNumbers: Record<string, number> = {};
    for (const chain of uniqueChains) {
      chainBlockNumbers[chain] = await this.blockService.findBlockByTimestamp(chain, options.timestamp);
    }

    return this.fetchMultiWalletBalances({
      wallets,
      chainBlockNumbers,
      includeUsd: options.includeUsd,
      requestedDate: options.timestamp.toISOString(),
    });
  }
}
