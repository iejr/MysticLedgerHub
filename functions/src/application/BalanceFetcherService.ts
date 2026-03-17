import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { ConfigService, TokenMetadata } from '../domain/ConfigService.js';
import { UnifiedBalance } from '../domain/types.js';
import { AlchemyRequestConverter } from '../domain/RequestConverters.js';

export interface BalanceFetchOptions {
  walletAddress: string;
  chain: string;
  blockNumber?: number;
  includeUsd: boolean;
}

export class BalanceFetcherService {
  private alchemyAdapter: AlchemyAdapter;
  private configService: ConfigService;

  constructor(alchemyAdapter: AlchemyAdapter, configService: ConfigService) {
    this.alchemyAdapter = alchemyAdapter;
    this.configService = configService;
  }

  async fetchBalances(options: BalanceFetchOptions): Promise<UnifiedBalance[]> {
    const { walletAddress, chain, blockNumber, includeUsd } = options;
    const blockTag = blockNumber ? `0x${blockNumber.toString(16)}` : 'latest';
    
    this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));
    
    const tokens = this.configService.getTokensForChain(chain);
    const balances: UnifiedBalance[] = [];
    
    const tokenAddressesForPrice: string[] = [];

    for (const token of tokens) {
      let rawBalance = '0x0';
      if (token.type === 'native') {
        rawBalance = await this.alchemyAdapter.getNativeBalance(walletAddress, blockTag);
        tokenAddressesForPrice.push('0x0000000000000000000000000000000000000000'); // Alchemy use null or zero for native? Check docs.
      } else {
        const contractAddress = token.chains[chain.toLowerCase()]?.address;
        if (contractAddress) {
          rawBalance = await this.alchemyAdapter.getTokenBalance(contractAddress, walletAddress, blockTag);
          tokenAddressesForPrice.push(contractAddress);
        }
      }

      const balanceValue = BigInt(rawBalance === '0x' ? '0x0' : rawBalance);
      const balanceFormatted = (Number(balanceValue) / Math.pow(10, token.decimals)).toString();

      balances.push({
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
      });
    }

    if (includeUsd && tokenAddressesForPrice.length > 0) {
      try {
        const priceParams = AlchemyRequestConverter.toPriceParams(chain, tokenAddressesForPrice);
        const priceResponse = await this.alchemyAdapter.getTokenPrices(priceParams);
        
        balances.forEach((balance, index) => {
          const token = tokens[index];
          if (!token) return;

          const addr = token.type === 'native' ? '0x0000000000000000000000000000000000000000' : token.chains[chain.toLowerCase()]?.address;
          const priceData = priceResponse.data.find(d => d.address.toLowerCase() === addr?.toLowerCase());
          
          if (priceData && priceData.prices && priceData.prices.length > 0) {
            const usdPrice = parseFloat(priceData.prices[0]?.value || '0');
            balance.usdPrice = usdPrice;
            balance.usdBalance = parseFloat(balance.balanceFormatted) * usdPrice;
          }
        });
      } catch (error) {
        console.warn('Failed to fetch token prices:', error);
      }
    }

    return balances;
  }
}
