import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { CacheService } from './CacheService.js';

export class PriceService {
  private alchemyAdapter: AlchemyAdapter;
  private cacheService: CacheService;

  constructor(alchemyAdapter: AlchemyAdapter, cacheService: CacheService) {
    this.alchemyAdapter = alchemyAdapter;
    this.cacheService = cacheService;
  }

  async getPriceAtTime(symbol: string, targetTime: Date): Promise<number | undefined> {
    const targetISO = targetTime.toISOString();

    // 1. Check Cache (Look for a range of +/- 10 min around the target time)
    const startTime = new Date(targetTime.getTime() - 10 * 60 * 1000).toISOString();
    const endTime = new Date(targetTime.getTime() + 10 * 60 * 1000).toISOString();

    let cachedPrices = await this.cacheService.getPricesInRange(symbol, startTime, endTime);

    if (cachedPrices.length === 0) {
      // 2. Fetch from Alchemy if not in cache (fetch +/- 1 hour range to populate cache)
      const fetchStart = new Date(targetTime.getTime() - 60 * 60 * 1000).toISOString();
      const fetchEnd = new Date(targetTime.getTime() + 60 * 60 * 1000).toISOString();

      const response = await this.alchemyAdapter.fetchHistoricalPrices({
        symbol,
        startTime: fetchStart,
        endTime: fetchEnd,
        interval: '5m', // Use 5 min interval for accuracy
      });

      if (response) {
        // Save all fetched prices to cache
        for (const p of response.data) {
          await this.cacheService.savePrice(response.symbol, p.timestamp, p.value);
        }
        cachedPrices = response.data;
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
