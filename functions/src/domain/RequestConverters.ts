import { FetchOptions } from '../application/TransactionFetcherService.js';
import { AlchemyGetAssetTransferParams, MoralisFetchParams, AlchemyTokenPriceParams } from '../infra/types.js';

export class AlchemyRequestConverter {
  static fromFetchOptions(options: FetchOptions): AlchemyGetAssetTransferParams {
    return {
      fromAddress: options.walletAddress,
      fromBlock: options.fromBlock ? `0x${options.fromBlock.toString(16)}` : undefined,
      toBlock: options.toBlock ? `0x${options.toBlock.toString(16)}` : undefined,
      category: ['external', 'erc20', 'erc721', 'erc1155'],
      withMetadata: true,
      excludeZeroValue: true,
    };
  }

  static getChainUrl(chain: string): string {
    const mapping: Record<string, string> = {
      'ethereum': 'eth-mainnet',
      'base': 'base-mainnet',
      'polygon': 'polygon-mainnet',
      'arbitrum': 'arb-mainnet',
      'optimism': 'opt-mainnet',
    };
    return mapping[chain.toLowerCase()] || `${chain.toLowerCase()}-mainnet`;
  }

  static toPriceParams(chain: string, addresses: string[]): AlchemyTokenPriceParams {
    return {
      addresses: addresses.map(addr => ({
        network: this.getChainUrl(chain),
        address: addr,
      })),
    };
  }
}
