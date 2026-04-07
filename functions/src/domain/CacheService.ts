import { FirestoreAdapter } from '../infra/FirestoreAdapter.js';
import { UnifiedBalance, UnifiedTransaction } from './types.js';

export interface CacheOptions {
  /** Gate reads — when false, all get* return undefined (force re-fetch). Default true. */
  useCache?: boolean;
  /** Gate writes (and reads) — when true, cache is fully protected. Default false. */
  dryRun?: boolean;
}

export class CacheService {
  private firestoreAdapter: FirestoreAdapter;
  private readEnabled: boolean;
  private writeEnabled: boolean;

  constructor(firestoreAdapter: FirestoreAdapter, options: CacheOptions = {}) {
    this.firestoreAdapter = firestoreAdapter;
    const useCache = options.useCache ?? true;
    const dryRun = options.dryRun ?? false;
    this.readEnabled = useCache && !dryRun;
    this.writeEnabled = !dryRun;
  }

  // --- Canonical Transactions ---

  async getCanonicalTransaction(chain: string, txHash: string): Promise<any | undefined> {
    if (!this.readEnabled) return undefined;
    return this.firestoreAdapter.getCanonicalTransaction(chain, txHash);
  }

  async saveCanonicalTransaction(chain: string, txHash: string, payload: any, addressesInvolved: string[]): Promise<void> {
    if (!this.writeEnabled) return;
    await this.firestoreAdapter.saveCanonicalTransaction(chain, txHash, payload, addressesInvolved);
  }

  // --- Raw Transactions ---

  async saveRawTransaction(chain: string, txHash: string, source: string, rawData: any): Promise<void> {
    if (!this.writeEnabled) return;
    await this.firestoreAdapter.saveRawTransaction(chain, txHash, source, rawData);
  }

  // --- Discovered Token Transfers ---

  async getDiscoveredTokenTransfers(chain: string, txHash: string): Promise<UnifiedTransaction['tokenTransfers'] | undefined> {
    if (!this.readEnabled) return undefined;
    return this.firestoreAdapter.getDiscoveredTokenTransfers(chain, txHash);
  }

  async saveDiscoveredTokenTransfers(chain: string, txHash: string, transfers: UnifiedTransaction['tokenTransfers']): Promise<void> {
    if (!this.writeEnabled) return;
    await this.firestoreAdapter.saveDiscoveredTokenTransfers(chain, txHash, transfers);
  }

  // --- Block Mappings ---

  async getBlockMapping(chain: string, timestamp: number): Promise<number | undefined> {
    if (!this.readEnabled) return undefined;
    return this.firestoreAdapter.getBlockMapping(chain, timestamp);
  }

  async getTimestampByBlockNumber(chain: string, blockNumber: number): Promise<number | undefined> {
    if (!this.readEnabled) return undefined;
    return this.firestoreAdapter.getTimestampByBlockNumber(chain, blockNumber);
  }

  async saveBlockMapping(chain: string, timestamp: number, blockNumber: number): Promise<void> {
    if (!this.writeEnabled) return;
    await this.firestoreAdapter.saveBlockMapping(chain, timestamp, blockNumber);
  }

  // --- Balances ---

  async getBalance(walletAddress: string, chain: string, tokenId: string, blockNumber?: number): Promise<UnifiedBalance | undefined> {
    if (!this.readEnabled) return undefined;
    return this.firestoreAdapter.getBalance(walletAddress, chain, tokenId, blockNumber);
  }

  async saveBalance(balance: UnifiedBalance): Promise<void> {
    if (!this.writeEnabled) return;
    await this.firestoreAdapter.saveBalance(balance);
  }

  // --- Prices ---

  async getPricesInRange(symbol: string, startTime: string, endTime: string): Promise<any[]> {
    if (!this.readEnabled) return [];
    return this.firestoreAdapter.getPricesInRange(symbol, startTime, endTime);
  }

  async savePrice(symbol: string, timestamp: string, value: string): Promise<void> {
    if (!this.writeEnabled) return;
    await this.firestoreAdapter.savePrice(symbol, timestamp, value);
  }

  // --- Legacy per-wallet transactions ---

  async saveTransaction(walletAddress: string, txHash: string, data: any): Promise<void> {
    if (!this.writeEnabled) return;
    await this.firestoreAdapter.saveTransaction(walletAddress, txHash, data);
  }
}
