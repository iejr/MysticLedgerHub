import { MoralisAdapter } from '../infra/MoralisAdapter.js';
import { AlchemyAdapter } from '../infra/AlchemyAdapter.js';
import { FirestoreAdapter } from '../infra/FirestoreAdapter.js';
import { MoralisParser } from '../domain/MoralisParser.js';
import { AlchemyParser } from '../domain/AlchemyParser.js';
import { UnifiedTransaction } from '../domain/types.js';
import { AlchemyRequestConverter, MoralisRequestConverter } from '../domain/RequestConverters.js';

export interface FetchOptions {
  walletAddress: string;
  chain: string;
  startDate?: Date;
  endDate?: Date;
  fromBlock?: number;
  toBlock?: number;
}

export class TransactionFetcherService {
  private moralisAdapter: MoralisAdapter;
  private alchemyAdapter: AlchemyAdapter;
  private firestoreAdapter: FirestoreAdapter;
  private moralisParser: MoralisParser;
  private alchemyParser: AlchemyParser;

  constructor(
    moralisAdapter: MoralisAdapter,
    alchemyAdapter: AlchemyAdapter,
    firestoreAdapter: FirestoreAdapter
  ) {
    this.moralisAdapter = moralisAdapter;
    this.alchemyAdapter = alchemyAdapter;
    this.firestoreAdapter = firestoreAdapter;
    this.moralisParser = new MoralisParser();
    this.alchemyParser = new AlchemyParser();
  }

  async fetchAndCache(options: FetchOptions): Promise<UnifiedTransaction[]> {
    const { walletAddress, chain } = options;
    let allTransactions: UnifiedTransaction[] = [];

    if (chain.toLowerCase() === 'what?') {
      // Use Moralis for Base chain
      const moralisParams = MoralisRequestConverter.fromFetchOptions(options);
      const iterator = this.moralisAdapter.getTransactionsIterator(moralisParams);

      for await (const batch of iterator) {
        const parsedBatch = this.moralisParser.parse(batch, walletAddress);
        allTransactions.push(...parsedBatch);
        
        for (const tx of parsedBatch) {
          await this.firestoreAdapter.saveTransaction(walletAddress, tx.txHash, tx);
        }
      }
    } else {
      // Use Alchemy for other chains
      const alchemyParams = AlchemyRequestConverter.fromFetchOptions(options);
      const chainUrl = AlchemyRequestConverter.getChainUrl(chain);
      
      this.alchemyAdapter.setChain(chainUrl);
      const iterator = this.alchemyAdapter.getTransactionsIterator(alchemyParams);

      for await (const batch of iterator) {
        const parsedBatch = this.alchemyParser.parse(batch, walletAddress);
        // Alchemy parser currently sets chain to 'unknown', fix it here
        parsedBatch.forEach(tx => tx.chain = chain);
        
        allTransactions.push(...parsedBatch);

        for (const tx of parsedBatch) {
          await this.firestoreAdapter.saveTransaction(walletAddress, tx.txHash, tx);
        }
      }
    }

    return allTransactions;
  }
}
