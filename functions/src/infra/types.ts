// ========================================
// Domain-friendly types (used by callers)
// ========================================

export interface DecodedBlock {
  number: number;
  timestamp: number; // Unix seconds
  hash: string;
}

export interface BalanceBatchRequest {
  type: 'native' | 'erc20';
  walletAddress: string;
  contractAddress?: string; // required for erc20
}

export interface AssetTransferParams {
  fromBlock?: number;
  toBlock?: number;
  fromAddress?: string;
  toAddress?: string;
  category?: string[];
  withMetadata?: boolean;
  excludeZeroValue?: boolean;
  maxCount?: number;
}

export interface TraceFilterParams {
  fromAddress?: string[];
  toAddress?: string[];
  fromBlock?: number;
  toBlock?: number;
}

export interface AssetTransfer {
  hash: string;
  blockNumber: number;
  category: string;
  from: string;
  to: string;
  contractAddress?: string;
  blockTimestamp?: string;
  value: string;
  rawData: any;
}

export interface HistoricalPricePoint {
  timestamp: string;
  value: string;
}

export interface HistoricalPriceResult {
  symbol: string;
  prices: HistoricalPricePoint[];
}

export interface HistoricalPriceParams {
  symbol: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  interval: '5m' | '1h' | '1d';
}

// ========================================
// Alchemy-specific types (internal to adapter)
// ========================================

export interface AlchemyGetAssetTransferParams {
  fromBlock?: string;
  toBlock?: string;
  fromAddress?: string;
  toAddress?: string;
  category?: string[];
  withMetadata?: boolean;
  excludeZeroValue?: boolean;
  maxCount?: number;
  pageKey?: string;
}

export interface AlchemyTraceFilterParams {
  fromBlock?: string;
  toBlock?: string;
  fromAddress?: string[];
  toAddress?: string[];
  after?: string;
  count?: number;
}

export interface MoralisFetchParams {
  address: string;
  chain: string;
  fromBlock?: number;
  toBlock?: number;
  order?: 'ASC' | 'DESC';
}

export interface AlchemyTokenPriceParams {
  addresses: { network: string; address: string }[];
}

export interface AlchemyTokenPriceResponse {
  data: {
    network: string;
    address: string;
    prices: { currency: string; value: string; lastUpdatedAt: string }[];
    error?: string;
  }[];
}

export interface AlchemyHistoricalPriceResponse {
  symbol: string;
  currency: string;
  data: {
    timestamp: string;
    value: string;
  }[];
}
