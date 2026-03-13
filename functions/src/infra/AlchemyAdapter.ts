import { BaseAdapter, AdapterConfig } from './BaseAdapter.js';
import { AlchemyGetAssetTransferParams, AlchemyTraceFilterParams } from './types.js';

export class AlchemyAdapter extends BaseAdapter {
  private apiKey: string;

  constructor(config: AdapterConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || `https://eth-mainnet.g.alchemy.com/v2/${config.apiKey}`,
    });
    this.apiKey = config.apiKey;
  }

  // Update base URL based on chain
  setChain(chain: string) {
    this.client.defaults.baseURL = `https://${chain}.g.alchemy.com/v2/${this.apiKey}`;
  }

  async fetchAssetTransferTransactions(params: AlchemyGetAssetTransferParams): Promise<any> {
    return this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [params],
      },
    });
  }

  async fetchTraceFilterTransactions(params: AlchemyTraceFilterParams): Promise<any> {
    return this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'trace_filter',
        params: [params],
      },
    });
  }

  async fetchTransactions(params: AlchemyGetAssetTransferParams): Promise<any> {
    return this.fetchAssetTransferTransactions(params);
  }

  async *getTransactionsIterator(params: AlchemyGetAssetTransferParams): AsyncGenerator<any> {
    let pageKey: string | undefined;
    do {
      const response: any = await this.fetchAssetTransferTransactions({
        ...params,
        ...(pageKey ? { pageKey } : {}),
      });
      
      yield response.result.transfers;
      pageKey = response.result.pageKey;
    } while (pageKey);
  }
}
