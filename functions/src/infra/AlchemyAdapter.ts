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
  private readonly CHUNK_SIZE = 50;

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

  // JSON-RPC Batching support with internal chunking and order guarantee
  async sendBatch(requests: { method: string, params: any[] }[]): Promise<any[]> {
    const allResults: any[] = new Array(requests.length);
    
    for (let i = 0; i < requests.length; i += this.CHUNK_SIZE) {
      const chunk = requests.slice(i, i + this.CHUNK_SIZE);
      const batchBody = chunk.map((req, index) => ({
        jsonrpc: '2.0',
        id: i + index, // Use global index to track position across chunks
        method: req.method,
        params: req.params,
      }));

      const results = await this.fetchWithRetry<any[]>({
        method: 'POST',
        url: '',
        data: batchBody,
      });

      // Place results into the correct position in the final array based on ID
      results.forEach((res) => {
        if (res && typeof res.id === 'number') {
          allResults[res.id] = res;
        }
      });
    }

    return allResults;
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

  async fetchTraceTransaction(txHash: string): Promise<any> {
    return this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'trace_transaction',
        params: [txHash],
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

  // Current Token Prices
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
