import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { ConfigService, WalletMetadata } from '../domain/ConfigService.js';
import { UnifiedBalance } from '../domain/types.js';
import { AlchemyRequestConverter } from '../domain/RequestConverters.js';
import { PriceService } from '../domain/PriceService.js';
import { BlockService } from '../domain/BlockService.js';
import { FirestoreAdapter } from '../infra/FirestoreAdapter.js';

export interface BalanceFetchOptions {
  walletAddress: string;
  chain: string;
  blockNumber?: number;
  includeUsd: boolean;
  useCache?: boolean;
}

export interface MultiWalletBalanceFetchOptions {
  wallets?: WalletMetadata[];
  chains?: string[];
  blockNumber?: number;
  chainBlockNumbers?: Record<string, number>;
  includeUsd?: boolean;
  useCache?: boolean;
  requestedDate?: string;
}

export interface MultiWalletBalanceByTimestampOptions {
  wallets?: WalletMetadata[];
  timestamp: Date;
  includeUsd?: boolean;
  useCache?: boolean;
}

export class BalanceFetcherService {
  private alchemyAdapter: AlchemyAdapter;
  private configService: ConfigService;
  private priceService: PriceService;
  private blockService?: BlockService;
  private firestoreAdapter: FirestoreAdapter;

  constructor(
    alchemyAdapter: AlchemyAdapter, 
    configService: ConfigService, 
    priceService: PriceService,
    firestoreAdapter: FirestoreAdapter,
    blockService?: BlockService
  ) {
    this.alchemyAdapter = alchemyAdapter;
    this.configService = configService;
    this.priceService = priceService;
    this.firestoreAdapter = firestoreAdapter;
    this.blockService = blockService;
  }

  async fetchBalances(options: BalanceFetchOptions): Promise<UnifiedBalance[]> {
    const { walletAddress, chain, blockNumber, includeUsd, useCache = true } = options;
    const blockTag = blockNumber ? `0x${blockNumber.toString(16)}` : 'latest';
    
    this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));
    
    const tokens = this.configService.getTokensForChain(chain);
    
    const finalBalances: UnifiedBalance[] = [];
    const tokensToFetch: any[] = [];

    // 1. Check Cache first for each token if enabled
    if (useCache) {
      for (const token of tokens) {
        const cached = await this.firestoreAdapter.getBalance(walletAddress, chain, token.id, blockNumber);
        if (cached) {
          finalBalances.push(cached);
        } else {
          tokensToFetch.push(token);
        }
      }
    } else {
      tokensToFetch.push(...tokens);
    }

    if (tokensToFetch.length === 0) return finalBalances;

    // 2. Fetch missing balances from Alchemy
    const requests = tokensToFetch.map(token => {
      if (token.type === 'native') {
        return { method: 'eth_getBalance', params: [walletAddress, blockTag] };
      } else {
        const contractAddress = token.chains[chain.toLowerCase()]?.address;
        const data = `0x70a08231000000000000000000000000${walletAddress.toLowerCase().replace('0x', '')}`;
        return { method: 'eth_call', params: [{ to: contractAddress, data }, blockTag] };
      }
    });

    const batchResults = await this.alchemyAdapter.sendBatch(requests);
    
    // Resolve block timestamp
    const block = await this.alchemyAdapter.getBlock(blockTag);
    const blocktime = block && block.timestamp ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : new Date().toISOString();
    const blockTimeDate = new Date(blocktime);

    for (let i = 0; i < tokensToFetch.length; i++) {
      const token = tokensToFetch[i]!;
      const result = batchResults[i]?.result;
      const balanceValue = BigInt(result === '0x' || !result ? '0' : result);
      const balanceFormatted = (Number(balanceValue) / Math.pow(10, token.decimals)).toString();

      const balance: UnifiedBalance = {
        walletAddress,
        chain,
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
        const usdPrice = await this.priceService.getPriceAtTime(token.symbol, blockTimeDate);
        if (usdPrice !== undefined) {
          balance.usdPrice = usdPrice;
          balance.usdBalance = parseFloat(balance.balanceFormatted) * usdPrice;
        }
      }

      // Save to cache if enabled
      if (useCache) {
        await this.firestoreAdapter.saveBalance(balance);
      }
      finalBalances.push(balance);
    }

    return finalBalances;
  }

  async fetchMultiWalletBalances(options: MultiWalletBalanceFetchOptions): Promise<UnifiedBalance[]> {
    const wallets = options.wallets || this.configService.getWallets();
    const globalIncludeUsd = options.includeUsd !== undefined ? options.includeUsd : this.configService.getGlobalIncludeUsd();
    const useCache = options.useCache !== undefined ? options.useCache : true;
    
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
      this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));
      const tokens = this.configService.getTokensForChain(chain);
      const blockNumber = options.chainBlockNumbers?.[chain] || options.blockNumber;
      const blockTag = blockNumber ? `0x${blockNumber.toString(16)}` : 'latest';

      const requests: { method: string, params: any[], meta: { wallet: string, token: any } }[] = [];
      
      for (const wallet of chainWallets) {
        for (const token of tokens) {
          if (useCache) {
            const cached = await this.firestoreAdapter.getBalance(wallet.address, chain, token.id, blockNumber);
            if (cached) {
              allBalances.push({ ...cached, requestedDate: options.requestedDate });
              continue;
            }
          }

          if (token.type === 'native') {
            requests.push({ 
              method: 'eth_getBalance', 
              params: [wallet.address, blockTag],
              meta: { wallet: wallet.address, token }
            });
          } else {
            const contractAddress = token.chains[chain.toLowerCase()]?.address;
            if (contractAddress) {
              const data = `0x70a08231000000000000000000000000${wallet.address.toLowerCase().replace('0x', '')}`;
              requests.push({ 
                method: 'eth_call', 
                params: [{ to: contractAddress, data }, blockTag],
                meta: { wallet: wallet.address, token }
              });
            }
          }
        }
      }

      if (requests.length === 0) continue;

      const batchResults = await this.alchemyAdapter.sendBatch(requests.map(r => ({ method: r.method, params: r.params })));
      
      // Resolve block timestamp
      const block = await this.alchemyAdapter.getBlock(blockTag);
      const blocktime = block && block.timestamp ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : new Date().toISOString();
      const blockTimeDate = new Date(blocktime);

      for (let j = 0; j < requests.length; j++) {
        const req = requests[j]!;
        const result = batchResults[j]?.result;
        const token = req.meta.token;
        const balanceValue = BigInt(result === '0x' || !result ? '0' : result);
        const balanceFormatted = (Number(balanceValue) / Math.pow(10, token.decimals)).toString();

        const balance: UnifiedBalance = {
          walletAddress: req.meta.wallet,
          chain,
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
          const usdPrice = await this.priceService.getPriceAtTime(token.symbol, blockTimeDate);
          if (usdPrice !== undefined) {
            balance.usdPrice = usdPrice;
            balance.usdBalance = parseFloat(balance.balanceFormatted) * usdPrice;
          }
        }

        // Save to cache if enabled
        if (useCache) {
          await this.firestoreAdapter.saveBalance(balance);
        }
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
      useCache: options.useCache,
      requestedDate: options.timestamp.toISOString(),
    });
  }
}
