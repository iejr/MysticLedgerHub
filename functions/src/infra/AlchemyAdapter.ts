import { logger } from 'firebase-functions';
import { BaseAdapter, AdapterConfig } from './BaseAdapter.js';
import {
  AlchemyGetAssetTransferParams,
  AlchemyTraceFilterParams,
  AlchemyTokenPriceParams,
  AlchemyTokenPriceResponse,
  AlchemyHistoricalPriceResponse,
  DecodedBlock,
  BalanceBatchRequest,
  AssetTransferParams,
  TraceFilterParams,
  AssetTransfer,
  HistoricalPriceParams,
  HistoricalPriceResult,
} from './types.js';

// Maps our internal chain IDs to Alchemy-specific URL slugs.
// Chains not listed here fall back to `{chain}-mainnet`.
const CHAIN_SLUGS: Record<string, string> = {
  'ethereum': 'eth-mainnet',
  'base': 'base-mainnet',
  'polygon': 'polygon-mainnet',
  'arbitrum': 'arb-mainnet',
  'optimism': 'opt-mainnet',
};

/** Convert decimal block number to hex string for Alchemy JSON-RPC. */
function toHexBlock(block?: number | 'latest'): string {
  if (block === undefined || block === 'latest') return 'latest';
  return `0x${block.toString(16)}`;
}

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

  /** Resolve internal chain ID to Alchemy network slug (e.g. "ethereum" → "eth-mainnet") */
  static getNetworkSlug(chain: string): string {
    return CHAIN_SLUGS[chain.toLowerCase()] || `${chain.toLowerCase()}-mainnet`;
  }

  /** Set the target chain for subsequent API calls. Accepts internal chain ID. */
  setChain(chain: string) {
    const slug = CHAIN_SLUGS[chain.toLowerCase()] || `${chain.toLowerCase()}-mainnet`;
    this.client.defaults.baseURL = `https://${slug}.g.alchemy.com/v2/${this.apiKey}`;
  }

  /**
   * Send a batch of JSON-RPC requests with automatic chunking.
   * Returns unwrapped `.result` from each response, preserving order.
   */
  async sendBatch(requests: { method: string, params: any[] }[]): Promise<any[]> {
    const allResults: any[] = new Array(requests.length);
    const totalChunks = Math.ceil(requests.length / this.CHUNK_SIZE);
    logger.info(`sendBatch: ${requests.length} requests in ${totalChunks} chunk(s)`);

    for (let i = 0; i < requests.length; i += this.CHUNK_SIZE) {
      const chunk = requests.slice(i, i + this.CHUNK_SIZE);
      const batchBody = chunk.map((req, index) => ({
        jsonrpc: '2.0',
        id: i + index,
        method: req.method,
        params: req.params,
      }));

      const results = await this.fetchWithRetry<any[]>({
        method: 'POST',
        url: '',
        data: batchBody,
      });

      results.forEach((res) => {
        if (res && typeof res.id === 'number') {
          allResults[res.id] = res.result ?? null;
        }
      });
    }

    logger.info(`sendBatch: completed ${requests.length} requests`);
    return allResults;
  }

  /**
   * Batch balance requests using domain-level types.
   * Encodes ERC-20 balanceOf(address) calldata (selector 0x70a08231) internally.
   */
  async sendBalanceBatch(requests: BalanceBatchRequest[], blockNumber: number | 'latest' = 'latest'): Promise<string[]> {
    logger.info(`sendBalanceBatch: ${requests.length} balance requests at block ${blockNumber}`);
    const blockTag = toHexBlock(blockNumber);

    const rpcRequests = requests.map(req => {
      if (req.type === 'native') {
        return { method: 'eth_getBalance', params: [req.walletAddress, blockTag] };
      } else {
        // ERC-20 balanceOf(address): selector 0x70a08231 + ABI-encoded address
        const data = `0x70a08231000000000000000000000000${req.walletAddress.toLowerCase().replace('0x', '')}`;
        return { method: 'eth_call', params: [{ to: req.contractAddress, data }, blockTag] };
      }
    });

    return this.sendBatch(rpcRequests);
  }

  /** Required by BaseAdapter abstract contract */
  async fetchTransactions(params: AssetTransferParams): Promise<any> {
    const iterator = this.getAssetTransferIterator(params);
    const first = await iterator.next();
    return first.value || [];
  }

  /** Trace filter — accepts decimal block numbers, returns unwrapped trace array */
  async fetchTraceFilterTransactions(params: TraceFilterParams): Promise<{ transactionHash: string }[]> {
    const alchemyParams: AlchemyTraceFilterParams = {
      fromAddress: params.fromAddress,
      toAddress: params.toAddress,
      fromBlock: params.fromBlock !== undefined ? toHexBlock(params.fromBlock) : undefined,
      toBlock: params.toBlock !== undefined ? toHexBlock(params.toBlock) : undefined,
    };

    logger.info(`fetchTraceFilter: ${params.fromAddress || params.toAddress}`);
    const response: any = await this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'trace_filter',
        params: [alchemyParams],
      },
    });

    const traces = response.result || [];
    logger.info(`fetchTraceFilter: returned ${traces.length} traces`);
    return traces;
  }

  /** Trace a single transaction — returns raw trace array */
  async fetchTraceTransaction(txHash: string): Promise<any> {
    const response: any = await this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'trace_transaction',
        params: [txHash],
      },
    });
    return response.result;
  }

  /**
   * Paginated asset transfer iterator.
   * Accepts domain params (decimal block numbers), yields decoded AssetTransfer[] per page.
   * Handles Alchemy pagination internally via pageKey.
   */
  async *getAssetTransferIterator(params: AssetTransferParams): AsyncGenerator<AssetTransfer[]> {
    let pageKey: string | undefined;
    let pageCount = 0;
    const alchemyParams: AlchemyGetAssetTransferParams = {
      fromBlock: params.fromBlock !== undefined ? toHexBlock(params.fromBlock) : undefined,
      toBlock: params.toBlock !== undefined ? toHexBlock(params.toBlock) : undefined,
      fromAddress: params.fromAddress,
      toAddress: params.toAddress,
      category: params.category,
      withMetadata: params.withMetadata,
      excludeZeroValue: params.excludeZeroValue,
      maxCount: params.maxCount,
    };

    do {
      pageCount++;
      const response: any = await this.fetchWithRetry({
        method: 'POST',
        url: '',
        data: {
          jsonrpc: '2.0',
          id: 1,
          method: 'alchemy_getAssetTransfers',
          params: [{ ...alchemyParams, ...(pageKey ? { pageKey } : {}) }],
        },
      });

      const rawTransfers = response.result.transfers || [];
      const decoded: AssetTransfer[] = rawTransfers.map((t: any) => ({
        hash: t.hash,
        blockNumber: parseInt(t.blockNum, 16),
        category: t.category,
        from: t.from,
        to: t.to || null,
        contractAddress: t.rawContract?.address || undefined,
        blockTimestamp: t.metadata?.blockTimestamp || undefined,
        value: t.value?.toString() || '0',
        rawData: t,
      }));

      yield decoded;
      pageKey = response.result.pageKey;
    } while (pageKey);

    logger.info(`getAssetTransferIterator: completed ${pageCount} page(s) for ${params.fromAddress || params.toAddress}`);
  }

  /** Block info — accepts decimal block number, returns decoded block */
  async getBlock(blockNumber: number | 'latest'): Promise<DecodedBlock | null> {
    const blockTag = toHexBlock(blockNumber);
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

    const result = response.result;
    if (!result) return null;
    return {
      number: parseInt(result.number, 16),
      timestamp: parseInt(result.timestamp, 16),
      hash: result.hash,
    };
  }

  /** Native balance — accepts decimal block number */
  async getNativeBalance(address: string, blockNumber: number | 'latest' = 'latest'): Promise<string> {
    const blockTag = toHexBlock(blockNumber);
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
    return response.result;
  }

  /** ERC-20 balance — accepts decimal block number, encodes balanceOf calldata internally */
  async getTokenBalance(contractAddress: string, walletAddress: string, blockNumber: number | 'latest' = 'latest'): Promise<string> {
    const blockTag = toHexBlock(blockNumber);
    const data = `0x70a08231000000000000000000000000${walletAddress.toLowerCase().replace('0x', '')}`;

    const response: any = await this.fetchWithRetry({
      method: 'POST',
      url: '',
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: contractAddress, data }, blockTag],
      },
    });
    return response.result;
  }

  /**
   * Historical token prices.
   * Uses address+network when available (more precise for ERC-20), falls back to symbol (native tokens).
   */
  async fetchHistoricalPrices(params: HistoricalPriceParams): Promise<HistoricalPriceResult> {
    const { symbol, address, network, startTime, endTime, interval } = params;

    const body: any = { startTime, endTime, interval };
    if (address && network) {
      body.address = address;
      body.network = network;
    } else if (symbol) {
      body.symbol = symbol;
    }

    const raw: AlchemyHistoricalPriceResponse = await this.fetchWithRetry({
      method: 'POST',
      url: `https://api.g.alchemy.com/prices/v1/${this.apiKey}/tokens/historical`,
      data: body,
    });

    return {
      symbol: raw.symbol,
      prices: raw.data,
    };
  }

  /** Current token prices */
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
