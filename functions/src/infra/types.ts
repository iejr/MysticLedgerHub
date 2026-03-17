export interface AlchemyGetAssetTransferParams {
  fromBlock?: string;
  toBlock?: string;
  fromAddress?: string;
  toAddress?: string;
  category?: string[];
  withMetadata?: boolean;
  excludeZeroValue?: boolean;
  maxCount?: number;
}

export interface AlchemyTraceFilterParams {
  fromBlock?: string;
  toBlock?: string;
  fromAddress?: [];
  toAddress?: [];
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
