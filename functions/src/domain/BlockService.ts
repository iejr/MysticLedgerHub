import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { CacheService } from './CacheService.js';
import { ConfigService } from './ConfigService.js';
import { AlchemyRequestConverter } from '../domain/RequestConverters.js';

export class BlockService {
  private alchemyAdapter: AlchemyAdapter;
  private cacheService: CacheService;
  private configService: ConfigService;

  constructor(alchemyAdapter: AlchemyAdapter, cacheService: CacheService, configService: ConfigService) {
    this.alchemyAdapter = alchemyAdapter;
    this.cacheService = cacheService;
    this.configService = configService;
  }

  async findBlockByTimestamp(chain: string, targetTimestamp: Date): Promise<number> {
    const targetTs = Math.floor(targetTimestamp.getTime() / 1000);
    const chainMeta = this.configService.getChainMetadata(chain);

    if (!chainMeta) throw new Error(`Chain metadata not found for ${chain}`);

    // 1. Check Cache
    const cached = await this.cacheService.getBlockMapping(chain, targetTs);
    if (cached) return cached;

    // 2. Initialize Bounds
    this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));
    const latestBlock = await this.alchemyAdapter.getBlock('latest');
    const latestNumber = parseInt(latestBlock.number, 16);
    const latestTs = parseInt(latestBlock.timestamp, 16);

    if (targetTs >= latestTs) return latestNumber;

    let low = chainMeta.startBlock;
    let high = latestNumber;

    const lowBlock = await this.alchemyAdapter.getBlock(`0x${low.toString(16)}`);
    let lowTs = parseInt(lowBlock.timestamp, 16);
    let highTs = latestTs;

    // 3. Linear Interpolation Search
    let iterations = 0;
    while (low <= high && iterations < 15) {
      iterations++;

      // Heuristic mid-point
      let mid = low + Math.floor(((targetTs - lowTs) / (highTs - lowTs)) * (high - low));

      // Safety bounds
      mid = Math.max(low, Math.min(high, mid));

      const midBlock = await this.alchemyAdapter.getBlock(`0x${mid.toString(16)}`);
      const midTs = parseInt(midBlock.timestamp, 16);

      if (Math.abs(midTs - targetTs) < chainMeta.averageBlockTime) {
        // Close enough
        await this.cacheService.saveBlockMapping(chain, targetTs, mid);
        return mid;
      }

      if (midTs < targetTs) {
        low = mid + 1;
        lowTs = midTs;
      } else {
        high = mid - 1;
        highTs = midTs;
      }
    }

    // Fallback to high if search doesn't perfectly converge
    await this.cacheService.saveBlockMapping(chain, targetTs, high);
    return high;
  }

  async getBlockTime(chain: string, blockNumber: number): Promise<string> {
    // 1. Check Cache
    const cachedTs = await this.cacheService.getTimestampByBlockNumber(chain, blockNumber);
    if (cachedTs) {
      return new Date(cachedTs * 1000).toISOString();
    }

    // 2. Fetch from Provider
    this.alchemyAdapter.setChain(AlchemyRequestConverter.getChainUrl(chain));
    const block = await this.alchemyAdapter.getBlock(`0x${blockNumber.toString(16)}`);
    if (!block || !block.timestamp) {
      throw new Error(`Failed to fetch block ${blockNumber} for chain ${chain}`);
    }

    const ts = parseInt(block.timestamp, 16);

    // 3. Save to Cache (both ways if possible, but at least block -> ts)
    await this.cacheService.saveBlockMapping(chain, ts, blockNumber);

    return new Date(ts * 1000).toISOString();
  }
}
