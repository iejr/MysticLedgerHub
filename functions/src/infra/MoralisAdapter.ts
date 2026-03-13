import { BaseAdapter, AdapterConfig } from './BaseAdapter.js';
import { MoralisFetchParams } from './types.js';

export class MoralisAdapter extends BaseAdapter {
  private apiKey: string;

  constructor(config: AdapterConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://deep-index.moralis.io/api/v2.2',
    });
    this.apiKey = config.apiKey;
  }

  async fetchTransactions(params: MoralisFetchParams): Promise<any> {
    const { address, ...query } = params;
    return this.fetchWithRetry({
      method: 'GET',
      url: `/wallets/${address}/history`,
      params: query,
      headers: {
        'X-API-Key': this.apiKey,
      },
    });
  }

  // Implementation for pagination using an async generator
  async *getTransactionsIterator(params: MoralisFetchParams): AsyncGenerator<any> {
    let cursor: string | undefined;
    do {
      const response: any = await this.fetchTransactions({
        ...params,
        ...(cursor ? { cursor } : {}),
      });
      
      yield response.result;
      cursor = response.cursor;
    } while (cursor);
  }
}
