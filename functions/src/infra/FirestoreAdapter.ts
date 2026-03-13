import { Firestore, DocumentData, CollectionReference } from '@google-cloud/firestore';

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

  async saveRawResponse(provider: string, endpoint: string, params: any, response: any): Promise<void> {
    // Optional: save raw responses for debugging or audit trail
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
