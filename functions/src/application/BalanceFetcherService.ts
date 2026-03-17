import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { ConfigService } from '../domain/ConfigService.js';
import { UnifiedBalance } from '../domain/types.js';
import { AlchemyRequestConverter } from '../domain/RequestConverters.js';
import { PriceService } from '../domain/PriceService.js';

export interface BalanceFetchOptions {
  walletAddress: string;
  chain: string;
  blockNumber?: number;
  includeUsd: boolean;
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
    const balances: UnifiedBalance[] = [];
    
    // 1. Get Block Timestamp if USD is needed
    let blockTime: Date | undefined;
    if (includeUsd) {
      const block = await this.alchemyAdapter.getBlock(blockTag);
      if (block && block.timestamp) {
        blockTime = new Date(parseInt(block.timestamp, 16) * 1000);
      }
    }

    // 2. Fetch Balances
    for (const token of tokens) {
      let rawBalance = '0x0';
      if (token.type === 'native') {
        rawBalance = await this.alchemyAdapter.getNativeBalance(walletAddress, blockTag);
      } else {
        const contractAddress = token.chains[chain.toLowerCase()]?.address;
        if (contractAddress) {
          rawBalance = await this.alchemyAdapter.getTokenBalance(contractAddress, walletAddress, blockTag);
        }
      }

      const balanceValue = BigInt(rawBalance === '0x' || !rawBalance ? '0' : rawBalance);
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

      // 3. Get Price if requested
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
}
