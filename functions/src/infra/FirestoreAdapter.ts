import { Firestore, DocumentData } from '@google-cloud/firestore';
import { UnifiedBalance } from '../domain/types.js';

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
    // Round timestamp to nearest 10 mins or something if we want broader reuse, 
    // but for monthly reports, exact match or close match is better.
    const docId = `${chain.toLowerCase()}_ts_${timestamp}`;
    await this.db.collection('block_mappings').doc(docId).set({
      chain: chain.toLowerCase(),
      timestamp,
      blockNumber,
      updatedAt: new Date(),
    });
  }

  async getBlockMapping(chain: string, timestamp: number): Promise<number | undefined> {
    // For simplicity, look for exact match. 
    // In future, could look for range +/- averageBlockTime
    const docId = `${chain.toLowerCase()}_ts_${timestamp}`;
    const doc = await this.db.collection('block_mappings').doc(docId).get();
    return doc.data()?.blockNumber;
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
}
