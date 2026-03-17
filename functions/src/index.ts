import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Throttler } from './infra/Throttler.js';
import { MoralisAdapter } from './infra/MoralisAdapter.js';
import { AlchemyAdapter } from './infra/AlchemyAdapter.js';
import { FirestoreAdapter } from './infra/FirestoreAdapter.js';
import { TransactionFetcherService } from './application/TransactionFetcherService.js';
import { BalanceFetcherService } from './application/BalanceFetcherService.js';
import { ConfigService } from './domain/ConfigService.js';

admin.initializeApp();

const db = admin.firestore();

// Throttlers for different providers
const moralisThrottler = new Throttler({ concurrency: 1, interval: 1000, intervalCap: 1 }); // 1 QPS
const alchemyThrottler = new Throttler({ concurrency: 5, interval: 1000, intervalCap: 5 }); // Adjusted for Alchemy

export const fetchTransactions = functions.https.onRequest(async (req, res) => {
  const { walletAddress, chain, fromBlock, toBlock } = req.query;

  if (!walletAddress || !chain) {
    res.status(400).send('Missing walletAddress or chain');
    return;
  }

  try {
    const moralisAdapter = new MoralisAdapter({
      apiKey: process.env.MORALIS_API_KEY || '',
      baseUrl: '',
      throttler: moralisThrottler,
    });

    const alchemyAdapter = new AlchemyAdapter({
      apiKey: process.env.ALCHEMY_API_KEY || '',
      baseUrl: '',
      throttler: alchemyThrottler,
    });

    const firestoreAdapter = new FirestoreAdapter(db);
    const service = new TransactionFetcherService(moralisAdapter, alchemyAdapter, firestoreAdapter);

    const transactions = await service.fetchAndCache({
      walletAddress: walletAddress as string,
      chain: chain as string,
      fromBlock: fromBlock ? parseInt(fromBlock as string) : undefined,
      toBlock: toBlock ? parseInt(toBlock as string) : undefined,
    });

    res.status(200).json({
      count: transactions.length,
      message: 'Transactions fetched and cached successfully',
    });
  } catch (error: any) {
    console.error('Error fetching transactions:', error);
    res.status(500).send(error.message);
  }
});

export const fetchBalances = functions.https.onRequest(async (req, res) => {
  const { walletAddress, chain, blockNumber, includeUsd } = req.query;

  if (!walletAddress || !chain) {
    res.status(400).send('Missing walletAddress or chain');
    return;
  }

  try {
    const alchemyAdapter = new AlchemyAdapter({
      apiKey: process.env.ALCHEMY_API_KEY || '',
      baseUrl: '',
      throttler: alchemyThrottler,
    });

    const configService = new ConfigService();
    const service = new BalanceFetcherService(alchemyAdapter, configService);

    const balances = await service.fetchBalances({
      walletAddress: walletAddress as string,
      chain: chain as string,
      blockNumber: blockNumber ? parseInt(blockNumber as string) : undefined,
      includeUsd: includeUsd === 'true',
    });

    res.status(200).json({
      count: balances.length,
      balances,
    });
  } catch (error: any) {
    console.error('Error fetching balances:', error);
    res.status(500).send(error.message);
  }
});
