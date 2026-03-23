import { ConfigService } from './ConfigService.js';
import { UnifiedBalance } from './types.js';

export class CsvService {
  private configService: ConfigService;

  constructor(configService: ConfigService) {
    this.configService = configService;
  }

  generateBalanceCsv(balances: UnifiedBalance[]): string {
    const headers = [
      'date',
      'address',
      'label',
      'network',
      'token_address',
      'symbol',
      'name',
      'balance',
      'usd_value',
      'possible_spam',
      'verified_contract',
      'security_score',
      'blocktime',
      'blockNumber'
    ];

    const rows = balances.map(b => {
      const wallet = this.configService.getWallets().find(w => w.address.toLowerCase() === b.walletAddress.toLowerCase());
      const chainMeta = this.configService.getChainMetadata(b.chain);
      const tokenMeta = this.configService.getTokenById(b.tokenId);
      
      const tokenAddress = b.tokenId.includes('native') ? '0x0000000000000000000000000000000000000000' : tokenMeta?.chains[b.chain.toLowerCase()]?.address || '';

      const row = [
        b.requestedDate || b.blocktime, // User requested date or fallback to blocktime
        b.walletAddress,
        wallet?.label || '',
        chainMeta?.name || b.chain,
        tokenAddress,
        b.tokenSymbol,
        b.tokenName,
        b.balanceFormatted,
        b.usdBalance?.toFixed(2) || '',
        '', // possible_spam
        '', // verified_contract
        '', // security_score
        b.blocktime, // Actual block timestamp
        b.blockNumber || ''
      ];
      return row.join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }
}
