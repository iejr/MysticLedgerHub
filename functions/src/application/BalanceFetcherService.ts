import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { ConfigService, WalletMetadata } from '../domain/ConfigService.js';
import { UnifiedBalance } from '../domain/types.js';
import { AlchemyRequestConverter } from '../domain/RequestConverters.js';
import { PriceService } from '../domain/PriceService.js';

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
  includeUsd?: boolean;
}

export class BalanceFetcherService {
  private alchemyAdapter: AlchemyAdapter;
  private configService: ConfigService;
  private priceService: PriceService;

  constructor(alchemyAdapter: AlchemyAdapter, configService: ConfigService, priceService: PriceService) {
    this.alchemyAdapter = alchemyAdapter;
    this.configService = configService;
    this.priceService = priceService;
  }

  async fetchBalances(options: BalanceFetchOptions): Promise<UnifiedBalance[]> {
    const { walletAddress, chain, blockNumber, includeUsd } = options;
    const blockTag = blockNumber ? `0x${blockNumber.toString(16)}` : 'latest';
    
    this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));
    
    const tokens = this.configService.getTokensForChain(chain);
    
    // Use Batch for a single wallet's tokens
    const requests = tokens.map(token => {
      if (token.type === 'native') {
        return { method: 'eth_getBalance', params: [walletAddress, blockTag] };
      } else {
        const contractAddress = token.chains[chain.toLowerCase()]?.address;
        const data = `0x70a08231000000000000000000000000${walletAddress.toLowerCase().replace('0x', '')}`;
        return { method: 'eth_call', params: [{ to: contractAddress, data }, blockTag] };
      }
    });

    const batchResults = await this.alchemyAdapter.sendBatch(requests);
    const balances: UnifiedBalance[] = [];
    
    let blockTime: Date | undefined;
    if (includeUsd) {
      const block = await this.alchemyAdapter.getBlock(blockTag);
      if (block && block.timestamp) {
        blockTime = new Date(parseInt(block.timestamp, 16) * 1000);
      }
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
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
        updatedAt: new Date().toISOString(),
      };

      if (includeUsd && blockTime) {
        const usdPrice = await this.priceService.getPriceAtTime(token.symbol, blockTime);
        if (usdPrice !== undefined) {
          balance.usdPrice = usdPrice;
          balance.usdBalance = parseFloat(balance.balanceFormatted) * usdPrice;
        }
      }
      balances.push(balance);
    }

    return balances;
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
      this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));
      const tokens = this.configService.getTokensForChain(chain);
      const blockTag = options.blockNumber ? `0x${options.blockNumber.toString(16)}` : 'latest';

      const requests: { method: string, params: any[], meta: { wallet: string, token: any } }[] = [];
      for (const wallet of chainWallets) {
        for (const token of tokens) {
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
      
      let blockTime: Date | undefined;
      if (globalIncludeUsd) {
        const block = await this.alchemyAdapter.getBlock(blockTag);
        if (block && block.timestamp) {
          blockTime = new Date(parseInt(block.timestamp, 16) * 1000);
        }
      }

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
          blockNumber: options.blockNumber,
          updatedAt: new Date().toISOString(),
        };

        if (globalIncludeUsd && blockTime) {
          const usdPrice = await this.priceService.getPriceAtTime(token.symbol, blockTime);
          if (usdPrice !== undefined) {
            balance.usdPrice = usdPrice;
            balance.usdBalance = parseFloat(balance.balanceFormatted) * usdPrice;
          }
        }
        allBalances.push(balance);
      }
    }

    return allBalances;
  }
}
