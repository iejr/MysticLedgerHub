import { BaseAdapter, AdapterConfig } from './BaseAdapter.js';
import { 
  AlchemyGetAssetTransferParams, 
  AlchemyTraceFilterParams, 
  AlchemyTokenPriceParams, 
  AlchemyTokenPriceResponse,
  AlchemyHistoricalPriceParams,
  AlchemyHistoricalPriceResponse
} from './types.js';

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

  // Native Balance
  async getNativeBalance(address: string, blockTag: string = 'latest'): Promise<string> {
    const response: any = await this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, blockTag],
      },
    });
    return response.result; // Hex string in wei
  }

  // ERC-20 Balance via eth_call
  async getTokenBalance(contractAddress: string, walletAddress: string, blockTag: string = 'latest'): Promise<string> {
    // balanceOf(address) selector: 0x70a08231
    const data = `0x70a08231000000000000000000000000${walletAddress.toLowerCase().replace('0x', '')}`;
    
    const response: any = await this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{
          to: contractAddress,
          data: data,
        }, blockTag],
      },
    });
    return response.result; // Hex string
  }

  // Block Info
  async getBlock(blockTag: string): Promise<any> {
    const response: any = await this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBlockByNumber',
        params: [blockTag, false],
      },
    });
    return response.result;
  }

  // Historical Token Prices
  async fetchHistoricalPrices(params: AlchemyHistoricalPriceParams): Promise<AlchemyHistoricalPriceResponse> {
    const { symbol, startTime, endTime, interval } = params;
    return this.fetchWithRetry({
      method: 'POST',
      url: `https://api.g.alchemy.com/prices/v1/${this.apiKey}/tokens/historical`,
      data: {
        symbol,
        startTime,
        endTime,
        interval,
      },
    });
  }

  // Current Token Prices (For completeness/fallback)
  async getTokenPrices(params: AlchemyTokenPriceParams): Promise<AlchemyTokenPriceResponse> {
    return this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getTokenPrices',
        params: [params],
      },
    });
  }
}
