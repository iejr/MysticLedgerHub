import { Firestore, DocumentData } from '@google-cloud/firestore';

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
