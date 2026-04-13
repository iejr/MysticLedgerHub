import { ConfigService, WalletMetadata } from './ConfigService.js';
import { UnifiedBalance, UnifiedTransaction } from './types.js';

export class CsvService {
  private configService: ConfigService;

  constructor(configService: ConfigService) {
    this.configService = configService;
  }

  private escapeCsvField(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private buildWalletLabelMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const w of this.configService.getWallets()) {
      if (w.label) map.set(w.address.toLowerCase(), w.label);
    }
    return map;
  }

  private formatAddress(address: string | null, labelMap: Map<string, string>): string {
    if (!address) return '';
    const label = labelMap.get(address.toLowerCase());
    return label ? `${label} (${address})` : address;
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
      const chainId = chainMeta?.id || b.chain;
      const tokenMeta = this.configService.getTokenById(b.tokenId);
      
      const tokenAddress = b.tokenId.includes('native') ? '0x0000000000000000000000000000000000000000' : tokenMeta?.chains[b.chain.toLowerCase()]?.address || '';

      const row = [
        b.requestedDate || b.blocktime,      // 'date',                       
        b.walletAddress,                     // 'address',
        wallet?.label || '',                 // 'label',
        chainId,                             // 'network',
        tokenAddress,                        // 'token_address',
        b.tokenSymbol,                       // 'symbol',
        b.tokenId,                           // 'name',
        b.balanceFormatted,                  // 'balance',
        b.usdBalance?.toFixed(2) || '',      // 'usd_value',
        '',                                  // 'possible_spam',
        '',                                  // 'verified_contract',
        '',                                  // 'security_score',
        b.blocktime,                         // 'blocktime',
        b.blockNumber || ''                  // 'blockNumber'        
      ];
      return row.map(v => this.escapeCsvField(String(v))).join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  generateTransactionCsv(transactions: UnifiedTransaction[], wallets?: WalletMetadata[]): string {
    const headers = [
      'txHash',
      'docTimestamp',
      'chainName',
      'category',
      'fromAddress',
      'toAddress',
      'coinName',
      'coinId',
      'contractName',
      'amount',
      'requestedAmount',
      'netAmount',
      'tokenUsdPrice',
      'usdAmount',
      'gasUsed',
      'gasPrice',
      'networkFee',
      'serviceFee',
      'memo',
      'content',
      'sourceType',
      'source',
      'nonce',
      'originalFromAddress',
      'originalToAddress',
      'txStatus',
    ];

    const walletList = wallets || this.configService.getWallets();
    const ownedAddresses = new Set(walletList.map(w => w.address.toLowerCase()));
    const labelMap = this.buildWalletLabelMap();

    const rows: string[] = [];

    for (const tx of transactions) {
      const chainMeta = this.configService.getChainMetadata(tx.chain);
      const chainId = chainMeta?.id || tx.chain;

      // Look up native token from token config for this chain
      const nativeToken = this.configService.getTokensForChain(tx.chain).find(t => t.type === 'native');

      // Native transfers
      for (const nt of tx.nativeTransfers) {
        const isReceive = nt.to ? ownedAddresses.has(nt.to.toLowerCase()) : false;

        const row = [
          tx.txHash,
          tx.blockTime,
          chainId,
          isReceive ? 'Receive' : 'Send',
          this.formatAddress(nt.from, labelMap),
          this.formatAddress(nt.to, labelMap),
          nativeToken?.name || chainMeta?.nativeSymbol || 'ETH', // coinName
          nativeToken?.id || '',                                  // coinId
          '',                                 // contractName
          nt.valueFormatted,                  // amount
          nt.valueFormatted,                  // requestedAmount
          nt.valueFormatted,                  // netAmount
          tx.usdPrice?.toString() || '',      // tokenUsdPrice
          nt.usdValue?.toFixed(2) || '',      // usdAmount
          '',                                 // gasUsed
          '',                                 // gasPrice
          '',                                 // networkFee
          '',                                 // serviceFee
          '',                                 // memo
          '',                                 // content
          'normal',                           // sourceType
          '',                                 // source
          '',                                 // nonce
          nt.from.toLowerCase() || '',                      // originalFromAddress
          nt.to?.toLowerCase() || '',                        // originalToAddress
          tx.status,                          // txStatus
        ];
        rows.push(row.map(v => this.escapeCsvField(String(v))).join(','));
      }

      // Token transfers
      for (const tt of tx.tokenTransfers) {
        const isReceive = ownedAddresses.has(tt.to.toLowerCase());
        const tokenMeta = tt.tokenId ? this.configService.getTokenById(tt.tokenId) : undefined;

        const row = [
          tx.txHash,
          tx.blockTime,
          chainId,
          isReceive ? 'Receive' : 'Send',
          this.formatAddress(tt.from, labelMap),
          this.formatAddress(tt.to, labelMap),
          tokenMeta?.name || tt.tokenSymbol,  // coinName
          tt.tokenId || '',                   // coinId
          '',                                 // contractName
          tt.valueFormatted,                  // amount
          tt.valueFormatted,                  // requestedAmount
          tt.valueFormatted,                  // netAmount
          tt.usdValue && parseFloat(tt.valueFormatted) !== 0
            ? (tt.usdValue / parseFloat(tt.valueFormatted)).toFixed(6)
            : '',                             // tokenUsdPrice
          tt.usdValue?.toFixed(2) || '',      // usdAmount
          '',                                 // gasUsed
          '',                                 // gasPrice
          '',                                 // networkFee
          '',                                 // serviceFee
          '',                                 // memo
          '',                                 // content
          'erc20',                            // sourceType
          '',                                 // source
          '',                                 // nonce
          tt.from.toLowerCase(),                            // originalFromAddress
          tt.to.toLowerCase(),                              // originalToAddress
          tx.status,                          // txStatus
        ];
        rows.push(row.map(v => this.escapeCsvField(String(v))).join(','));
      }
    }

    return [headers.join(','), ...rows].join('\n');
  }
}
