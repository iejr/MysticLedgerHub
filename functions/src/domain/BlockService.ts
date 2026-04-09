import { logger } from 'firebase-functions';
import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { CacheService } from './CacheService.js';
import { ConfigService } from './ConfigService.js';

/** Threshold multiplier: if interpolation error exceeds this × averageBlockTime, switch to binary */
const INTERPOLATION_ERROR_THRESHOLD = 10;

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

    // 1. Check exact cache hit
    const cached = await this.cacheService.getBlockMapping(chain, targetTs);
    if (cached) return cached;

    // 2. Initialize bounds from provider
    this.alchemyAdapter.setChain(chain);
    const latestBlock = await this.alchemyAdapter.getBlock('latest');
    if (!latestBlock) throw new Error(`Failed to fetch latest block for ${chain}`);

    if (targetTs >= latestBlock.timestamp) return latestBlock.number;

    let low = chainMeta.startBlock;
    let high = latestBlock.number;
    let lowTs = 0;
    let highTs = latestBlock.timestamp;

    // 3. Narrow bounds from cached block mappings
    const bounds = await this.cacheService.getNearestBlockBounds(chain, targetTs);
    let boundsNarrowed = false;

    if (bounds.lower) {
      low = bounds.lower.blockNumber;
      lowTs = bounds.lower.timestamp;
      boundsNarrowed = true;
    }
    if (bounds.upper) {
      high = bounds.upper.blockNumber;
      highTs = bounds.upper.timestamp;
      boundsNarrowed = true;
    }

    // Only fetch the low block from provider if cache didn't help
    if (!boundsNarrowed) {
      const lowBlock = await this.alchemyAdapter.getBlock(low);
      lowTs = lowBlock!.timestamp;
    }

    if (boundsNarrowed) {
      logger.info(`Narrowed search bounds for ${chain} from cache: [${low}, ${high}] (range: ${high - low} blocks)`);
    }

    // 4. Determine search strategy
    let useBinarySearch = !chainMeta.linearBlockTime;

    // 5. Search loop
    let iterations = 0;
    while (low <= high && iterations < 30) {
      iterations++;

      let mid: number;
      if (useBinarySearch) {
        mid = Math.floor((low + high) / 2);
      } else {
        mid = low + Math.floor(((targetTs - lowTs) / (highTs - lowTs)) * (high - low));
        mid = Math.max(low, Math.min(high, mid));
      }

      const midBlock = await this.alchemyAdapter.getBlock(mid);
      const midTs = midBlock!.timestamp;

      // Auto-detect: if interpolation error is too large on first probe, switch to binary
      if (!useBinarySearch && iterations === 1) {
        const errorSeconds = Math.abs(midTs - targetTs);
        if (errorSeconds > INTERPOLATION_ERROR_THRESHOLD * chainMeta.averageBlockTime) {
          useBinarySearch = true;
        }
      }

      if (Math.abs(midTs - targetTs) < chainMeta.averageBlockTime) {
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

    // Fallback to high if search doesn't converge
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
    this.alchemyAdapter.setChain(chain);
    const block = await this.alchemyAdapter.getBlock(blockNumber);
    if (!block) {
      throw new Error(`Failed to fetch block ${blockNumber} for chain ${chain}`);
    }

    const ts = block.timestamp;

    // 3. Save to Cache
    await this.cacheService.saveBlockMapping(chain, ts, blockNumber);

    return new Date(ts * 1000).toISOString();
  }
}
