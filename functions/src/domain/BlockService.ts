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

    // 1. Check Cache
    const cached = await this.cacheService.getBlockMapping(chain, targetTs);
    if (cached) return cached;

    // 2. Initialize Bounds
    this.alchemyAdapter.setChain(chain);
    const latestBlock = await this.alchemyAdapter.getBlock('latest');
    if (!latestBlock) throw new Error(`Failed to fetch latest block for ${chain}`);
    const latestNumber = latestBlock.number;
    const latestTs = latestBlock.timestamp;

    if (targetTs >= latestTs) return latestNumber;

    let low = chainMeta.startBlock;
    let high = latestNumber;

    const lowBlock = await this.alchemyAdapter.getBlock(low);
    let lowTs = lowBlock!.timestamp;
    let highTs = latestTs;

    // Determine search strategy: config says non-linear → binary from the start
    let useBinarySearch = !chainMeta.linearBlockTime;

    // 3. Search loop
    let iterations = 0;
    while (low <= high && iterations < 20) {
      iterations++;

      let mid: number;
      if (useBinarySearch) {
        mid = Math.floor((low + high) / 2);
      } else {
        // Linear interpolation
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
