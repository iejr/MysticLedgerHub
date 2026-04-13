import { Firestore } from '@google-cloud/firestore';
import { UnifiedBalance, UnifiedTransaction } from '../domain/types.js';

/** Firestore collection names — single source of truth */
export const Collections = {
  TRANSACTIONS: 'transactions',
  TOKEN_PRICES: 'token_prices',
  BLOCK_MAPPINGS: 'block_mappings',
  BALANCES: 'balances',
  RAW_TRANSACTIONS: 'raw_transactions',
  CANONICAL_TRANSACTIONS: 'canonical_transactions',
  DISCOVERED_TOKEN_TRANSFERS: 'discovered_token_transfers',
  WALLET_TOKENS: 'wallet_tokens',
} as const;

export class FirestoreAdapter {
  private db: Firestore;

  constructor(db: Firestore) {
    this.db = db;
  }

  // --- Per-wallet Transactions (legacy) ---

  async saveTransaction(walletAddress: string, txHash: string, data: any): Promise<void> {
    const docId = `${walletAddress.toLowerCase()}_${txHash.toLowerCase()}`;
    await this.db.collection(Collections.TRANSACTIONS).doc(docId).set({
      ...data,
      walletAddress: walletAddress.toLowerCase(),
      updatedAt: new Date(),
    }, { merge: true });
  }

  // --- Price Caching (keyed by tokenId) ---

  async savePrice(tokenId: string, timestamp: string, value: string): Promise<void> {
    const dateStr = timestamp.split('T')[0];
    const docId = `${tokenId}_${timestamp}`;
    await this.db.collection(Collections.TOKEN_PRICES).doc(docId).set({
      tokenId,
      timestamp,
      date: dateStr,
      value,
      updatedAt: new Date(),
    });
  }

  async getPricesInRange(tokenId: string, startTime: string, endTime: string): Promise<any[]> {
    const snapshot = await this.db.collection(Collections.TOKEN_PRICES)
      .where('tokenId', '==', tokenId)
      .where('timestamp', '>=', startTime)
      .where('timestamp', '<=', endTime)
      .get();

    return snapshot.docs.map(doc => doc.data());
  }

  // --- Block Mappings (bidirectional: timestamp ↔ blockNumber, single collection) ---

  async saveBlockMapping(chain: string, timestamp: number, blockNumber: number): Promise<void> {
    const lowerChain = chain.toLowerCase();
    const col = this.db.collection(Collections.BLOCK_MAPPINGS);
    const payload = { chain: lowerChain, timestamp, blockNumber, updatedAt: new Date() };

    const batch = this.db.batch();
    batch.set(col.doc(`${lowerChain}_ts_${timestamp}`), payload);
    batch.set(col.doc(`${lowerChain}_num_${blockNumber}`), payload);
    await batch.commit();
  }

  async getBlockMapping(chain: string, timestamp: number): Promise<number | undefined> {
    const docId = `${chain.toLowerCase()}_ts_${timestamp}`;
    const doc = await this.db.collection(Collections.BLOCK_MAPPINGS).doc(docId).get();
    return doc.data()?.blockNumber;
  }

  async getTimestampByBlockNumber(chain: string, blockNumber: number): Promise<number | undefined> {
    const docId = `${chain.toLowerCase()}_num_${blockNumber}`;
    const doc = await this.db.collection(Collections.BLOCK_MAPPINGS).doc(docId).get();
    return doc.data()?.timestamp;
  }

  /**
   * Find the nearest cached block bounds around a target timestamp.
   * Returns the greatest cached entry ≤ target (lower) and smallest ≥ target (upper).
   */
  async getNearestBlockBounds(chain: string, targetTimestamp: number): Promise<{
    lower?: { timestamp: number; blockNumber: number };
    upper?: { timestamp: number; blockNumber: number };
  }> {
    const lowerChain = chain.toLowerCase();
    const col = this.db.collection(Collections.BLOCK_MAPPINGS);

    const [lowerSnap, upperSnap] = await Promise.all([
      col.where('chain', '==', lowerChain)
        .where('timestamp', '<=', targetTimestamp)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get(),
      col.where('chain', '==', lowerChain)
        .where('timestamp', '>=', targetTimestamp)
        .orderBy('timestamp', 'asc')
        .limit(1)
        .get(),
    ]);

    const lower = lowerSnap.docs[0]?.data();
    const upper = upperSnap.docs[0]?.data();

    return {
      lower: lower ? { timestamp: lower.timestamp, blockNumber: lower.blockNumber } : undefined,
      upper: upper ? { timestamp: upper.timestamp, blockNumber: upper.blockNumber } : undefined,
    };
  }

  // --- Balance Caching ---

  async saveBalance(balance: UnifiedBalance): Promise<void> {
    const blockRef = balance.blockNumber || 'latest';
    const docId = `${balance.walletAddress.toLowerCase()}_${balance.chain.toLowerCase()}_${balance.tokenId}_${blockRef}`;
    await this.db.collection(Collections.BALANCES).doc(docId).set({
      ...balance,
      updatedAt: new Date().toISOString(),
    });
  }

  async getBalance(walletAddress: string, chain: string, tokenId: string, blockNumber?: number): Promise<UnifiedBalance | undefined> {
    const blockRef = blockNumber || 'latest';
    const docId = `${walletAddress.toLowerCase()}_${chain.toLowerCase()}_${tokenId}_${blockRef}`;
    const doc = await this.db.collection(Collections.BALANCES).doc(docId).get();
    return doc.exists ? (doc.data() as UnifiedBalance) : undefined;
  }

  // --- Raw Transactions ---

  async saveRawTransaction(chain: string, txHash: string, source: string, rawData: any): Promise<void> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    await this.db.collection(Collections.RAW_TRANSACTIONS).doc(docId).set({
      chain: chain.toLowerCase(),
      txHash: txHash.toLowerCase(),
      source,
      rawData,
      updatedAt: new Date().toISOString(),
    });
  }

  // --- Canonical Transactions ---

  async saveCanonicalTransaction(chain: string, txHash: string, payload: any, addressesInvolved: string[]): Promise<void> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    await this.db.collection(Collections.CANONICAL_TRANSACTIONS).doc(docId).set({
      chain: chain.toLowerCase(),
      txHash: txHash.toLowerCase(),
      payload,
      addressesInvolved: addressesInvolved.map((a) => a.toLowerCase()),
      updatedAt: new Date().toISOString(),
    });
  }

  async getCanonicalTransaction(chain: string, txHash: string): Promise<any | undefined> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    const doc = await this.db.collection(Collections.CANONICAL_TRANSACTIONS).doc(docId).get();
    if (!doc.exists) return undefined;

    const data = doc.data()!;
    return {
      chain: data.chain,
      txHash: data.txHash,
      payload: data.payload,
      addressesInvolved: data.addressesInvolved,
      updatedAt: data.updatedAt,
    };
  }

  // --- Discovered Token Transfers ---

  async saveDiscoveredTokenTransfers(chain: string, txHash: string, transfers: UnifiedTransaction['tokenTransfers']): Promise<void> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    await this.db.collection(Collections.DISCOVERED_TOKEN_TRANSFERS).doc(docId).set({
      chain: chain.toLowerCase(),
      txHash: txHash.toLowerCase(),
      transfers,
      updatedAt: new Date().toISOString(),
    });
  }

  async getDiscoveredTokenTransfers(chain: string, txHash: string): Promise<UnifiedTransaction['tokenTransfers'] | undefined> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    const doc = await this.db.collection(Collections.DISCOVERED_TOKEN_TRANSFERS).doc(docId).get();
    return doc.exists ? (doc.data()?.transfers as UnifiedTransaction['tokenTransfers']) : undefined;
  }

  // --- Wallet Tokens (which ERC-20s each wallet has interacted with per chain) ---

  async saveWalletTokens(wallet: string, chain: string, tokens: { tokenId: string; lastSeen: string }[]): Promise<void> {
    const docId = `${wallet.toLowerCase()}_${chain.toLowerCase()}`;
    const doc = await this.db.collection(Collections.WALLET_TOKENS).doc(docId).get();

    const existing: Record<string, string> = {}; // tokenId → lastSeen
    if (doc.exists) {
      const data = doc.data();
      for (const t of (data?.tokens || [])) {
        // Back-compat: older entries used `firstSeen`; treat them as lastSeen for merge purposes
        existing[t.tokenId] = t.lastSeen || t.firstSeen;
      }
    }

    // Merge: keep max(lastSeen) for each tokenId
    for (const t of tokens) {
      if (!existing[t.tokenId] || t.lastSeen > existing[t.tokenId]) {
        existing[t.tokenId] = t.lastSeen;
      }
    }

    const merged = Object.entries(existing).map(([tokenId, lastSeen]) => ({ tokenId, lastSeen }));

    await this.db.collection(Collections.WALLET_TOKENS).doc(docId).set({
      wallet: wallet.toLowerCase(),
      chain: chain.toLowerCase(),
      tokens: merged,
      updatedAt: new Date().toISOString(),
    });
  }

  async getWalletTokens(wallet: string, chain: string): Promise<{ tokenId: string; lastSeen: string }[]> {
    const docId = `${wallet.toLowerCase()}_${chain.toLowerCase()}`;
    const doc = await this.db.collection(Collections.WALLET_TOKENS).doc(docId).get();
    if (!doc.exists) return [];
    // Back-compat: older entries used `firstSeen`
    return (doc.data()?.tokens || []).map((t: any) => ({
      tokenId: t.tokenId,
      lastSeen: t.lastSeen || t.firstSeen,
    }));
  }
}
