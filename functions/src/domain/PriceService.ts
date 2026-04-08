import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { HistoricalPriceParams } from '../infra/types.js';
import { CacheService } from './CacheService.js';

export interface PriceLookupOptions {
  /** Public ticker symbol — always provided as fallback for native tokens */
  symbol: string;
  /** Internal chain ID — needed to resolve network slug for address-based queries */
  chain?: string;
  /** Token contract address on the given chain — when present, address-based query is preferred */
  contractAddress?: string;
}

export class PriceService {
  private alchemyAdapter: AlchemyAdapter;
  private cacheService: CacheService;

  constructor(alchemyAdapter: AlchemyAdapter, cacheService: CacheService) {
    this.alchemyAdapter = alchemyAdapter;
    this.cacheService = cacheService;
  }

  async getPriceAtTime(tokenId: string, options: PriceLookupOptions, targetTime: Date): Promise<number | undefined> {
    // 1. Check Cache (Look for a range of +/- 10 min around the target time)
    const startTime = new Date(targetTime.getTime() - 10 * 60 * 1000).toISOString();
    const endTime = new Date(targetTime.getTime() + 10 * 60 * 1000).toISOString();

    let cachedPrices = await this.cacheService.getPricesInRange(tokenId, startTime, endTime);

    if (cachedPrices.length === 0) {
      // 2. Fetch from provider if not in cache (fetch +/- 1 hour range to populate cache)
      const fetchStart = new Date(targetTime.getTime() - 60 * 60 * 1000).toISOString();
      const fetchEnd = new Date(targetTime.getTime() + 60 * 60 * 1000).toISOString();

      // Build query params: prefer address+network for ERC-20, fall back to symbol
      const priceParams: HistoricalPriceParams = {
        startTime: fetchStart,
        endTime: fetchEnd,
        interval: '5m',
      };

      if (options.contractAddress && options.chain) {
        priceParams.address = options.contractAddress;
        priceParams.network = AlchemyAdapter.getNetworkSlug(options.chain);
      } else {
        priceParams.symbol = options.symbol;
      }

      const response = await this.alchemyAdapter.fetchHistoricalPrices(priceParams);

      if (response && response.prices) {
        for (const p of response.prices) {
          await this.cacheService.savePrice(tokenId, p.timestamp, p.value);
        }
        cachedPrices = response.prices;
      }
    }

    if (cachedPrices.length > 0) {
      // 3. Find the closest price to the target time
      const targetTs = targetTime.getTime();
      let closestPrice = cachedPrices[0];
      let minDiff = Math.abs(new Date(closestPrice.timestamp).getTime() - targetTs);

      for (const p of cachedPrices) {
        const diff = Math.abs(new Date(p.timestamp).getTime() - targetTs);
        if (diff < minDiff) {
          minDiff = diff;
          closestPrice = p;
        }
      }
      return parseFloat(closestPrice.value);
    }

    return undefined;
  }
}
