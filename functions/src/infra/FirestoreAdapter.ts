import { Firestore, DocumentData } from '@google-cloud/firestore';
import { UnifiedBalance, UnifiedTransaction } from '../domain/types.js';

export class FirestoreAdapter {
  private db: Firestore;

  constructor(db: Firestore) {
    this.db = db;
  }

  async saveTransaction(walletAddress: string, txHash: string, data: any): Promise<void> {
    const docId = `${walletAddress.toLowerCase()}_${txHash.toLowerCase()}`;
    await this.db.collection('transactions').doc(docId).set({
      ...data,
      walletAddress: walletAddress.toLowerCase(),
      updatedAt: new Date(),
    }, { merge: true });
  }

  async getTransaction(walletAddress: string, txHash: string): Promise<DocumentData | undefined> {
    const docId = `${walletAddress.toLowerCase()}_${txHash.toLowerCase()}`;
    const doc = await this.db.collection('transactions').doc(docId).get();
    return doc.data();
  }

  // Price Caching
  async savePrice(symbol: string, timestamp: string, value: string): Promise<void> {
    const dateStr = timestamp.split('T')[0]; // Cache by date to organize
    const docId = `${symbol.toUpperCase()}_${timestamp}`;
    await this.db.collection('token_prices').doc(docId).set({
      symbol: symbol.toUpperCase(),
      timestamp,
      date: dateStr,
      value,
      updatedAt: new Date(),
    });
  }

  async getPricesInRange(symbol: string, startTime: string, endTime: string): Promise<any[]> {
    const snapshot = await this.db.collection('token_prices')
      .where('symbol', '==', symbol.toUpperCase())
      .where('timestamp', '>=', startTime)
      .where('timestamp', '<=', endTime)
      .get();
    
    return snapshot.docs.map(doc => doc.data());
  }

  // Block Mapping Caching
  async saveBlockMapping(chain: string, timestamp: number, blockNumber: number): Promise<void> {
    // 1. Save timestamp -> blockNumber mapping
    const tsDocId = `${chain.toLowerCase()}_ts_${timestamp}`;
    await this.db.collection('block_mappings').doc(tsDocId).set({
      chain: chain.toLowerCase(),
      timestamp,
      blockNumber,
      updatedAt: new Date(),
    });

    // 2. Save blockNumber -> timestamp mapping
    const blockDocId = `${chain.toLowerCase()}_num_${blockNumber}`;
    await this.db.collection('block_number_mappings').doc(blockDocId).set({
      chain: chain.toLowerCase(),
      timestamp,
      blockNumber,
      updatedAt: new Date(),
    });
  }

  async getBlockMapping(chain: string, timestamp: number): Promise<number | undefined> {
    const docId = `${chain.toLowerCase()}_ts_${timestamp}`;
    const doc = await this.db.collection('block_mappings').doc(docId).get();
    return doc.data()?.blockNumber;
  }

  async getTimestampByBlockNumber(chain: string, blockNumber: number): Promise<number | undefined> {
    const docId = `${chain.toLowerCase()}_num_${blockNumber}`;
    const doc = await this.db.collection('block_number_mappings').doc(docId).get();
    return doc.data()?.timestamp;
  }

  // Balance Caching
  async saveBalance(balance: UnifiedBalance): Promise<void> {
    const blockRef = balance.blockNumber || 'latest';
    const docId = `${balance.walletAddress.toLowerCase()}_${balance.chain.toLowerCase()}_${balance.tokenId}_${blockRef}`;
    await this.db.collection('balances').doc(docId).set({
      ...balance,
      updatedAt: new Date().toISOString(),
    });
  }

  async getBalance(walletAddress: string, chain: string, tokenId: string, blockNumber?: number): Promise<UnifiedBalance | undefined> {
    const blockRef = blockNumber || 'latest';
    const docId = `${walletAddress.toLowerCase()}_${chain.toLowerCase()}_${tokenId}_${blockRef}`;
    const doc = await this.db.collection('balances').doc(docId).get();
    return doc.exists ? (doc.data() as UnifiedBalance) : undefined;
  }

  async saveRawResponse(provider: string, endpoint: string, params: any, response: any): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.db.collection('raw_logs').add({
      provider,
      endpoint,
      params,
      response,
      timestamp,
    });
  }

  // Canonical Transaction Caching
  async saveRawTransaction(chain: string, txHash: string, source: string, rawData: any): Promise<void> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    await this.db.collection("raw_transactions").doc(docId).set({
      chain: chain.toLowerCase(),
      txHash: txHash.toLowerCase(),
      source,
      rawData,
      updatedAt: new Date().toISOString(),
    });
  }

  async getRawTransaction(chain: string, txHash: string): Promise<any | undefined> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    const doc = await this.db.collection("raw_transactions").doc(docId).get();
    return doc.exists ? doc.data() : undefined;
  }

  async saveCanonicalTransaction(chain: string, txHash: string, payload: any, addressesInvolved: string[]): Promise<void> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    await this.db.collection("canonical_transactions").doc(docId).set({
      chain: chain.toLowerCase(),
      txHash: txHash.toLowerCase(),
      payload: payload,
      addressesInvolved: addressesInvolved.map((a) => a.toLowerCase()),
      updatedAt: new Date().toISOString(),
    });
  }

  async getCanonicalTransaction(chain: string, txHash: string): Promise<any | undefined> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    const doc = await this.db.collection("canonical_transactions").doc(docId).get();
    if (!doc.exists) return undefined;

    return {
      chain: doc.data()?.chain,
      txHash: doc.data()?.txHash,
      payload: doc.data()?.payload,
      addressesInvolved: doc.data()?.addressesInvolved,
      updatedAt: doc.data()?.updatedAt,
    };
  }

  async saveDiscoveredTokenTransfers(chain: string, txHash: string, transfers: UnifiedTransaction['tokenTransfers']): Promise<void> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    await this.db.collection("discovered_token_transfers").doc(docId).set({
      chain: chain.toLowerCase(),
      txHash: txHash.toLowerCase(),
      transfers,
      updatedAt: new Date().toISOString(),
    });
  }

  async getDiscoveredTokenTransfers(chain: string, txHash: string): Promise<UnifiedTransaction['tokenTransfers'] | undefined> {
    const docId = `${chain.toLowerCase()}_${txHash.toLowerCase()}`;
    const doc = await this.db.collection("discovered_token_transfers").doc(docId).get();
    return doc.exists ? (doc.data()?.transfers as UnifiedTransaction['tokenTransfers']) : undefined;
  }
}
