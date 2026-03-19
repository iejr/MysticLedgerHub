import * as functions from 'firebase-functions';
import admin from 'firebase-admin';
import { Throttler } from './infra/Throttler.js';
import { MoralisAdapter } from './infra/MoralisAdapter.js';
import { AlchemyAdapter } from './infra/AlchemyAdapter.js';
import { FirestoreAdapter } from './infra/FirestoreAdapter.js';
import { TransactionFetcherService } from './application/TransactionFetcherService.js';
import { BalanceFetcherService } from './application/BalanceFetcherService.js';
import { ConfigService } from './domain/ConfigService.js';
import { PriceService } from './domain/PriceService.js';
import { BlockService } from './domain/BlockService.js';

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

    const firestoreAdapter = new FirestoreAdapter(db);
    const configService = new ConfigService();
    const priceService = new PriceService(alchemyAdapter, firestoreAdapter);
    
    const service = new BalanceFetcherService(alchemyAdapter, configService, priceService);

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

export const fetchMultiBalances = functions.https.onRequest(async (req, res) => {
  const { addresses, blockNumber, chainBlockNumbers, includeUsd } = req.body;

  try {
    const alchemyAdapter = new AlchemyAdapter({
      apiKey: process.env.ALCHEMY_API_KEY || '',
      baseUrl: '',
      throttler: alchemyThrottler,
    });

    const firestoreAdapter = new FirestoreAdapter(db);
    const configService = new ConfigService();
    const priceService = new PriceService(alchemyAdapter, firestoreAdapter);
    
    const service = new BalanceFetcherService(alchemyAdapter, configService, priceService);

    const options: any = {
      blockNumber: blockNumber ? parseInt(blockNumber as string) : undefined,
      chainBlockNumbers: chainBlockNumbers,
      includeUsd: includeUsd !== undefined ? includeUsd === true || includeUsd === 'true' : undefined,
    };

    if (addresses && Array.isArray(addresses)) {
      options.wallets = addresses.map(addr => ({ address: addr, label: 'Custom' }));
    }

    const balances = await service.fetchMultiWalletBalances(options);

    res.status(200).json({
      count: balances.length,
      balances,
    });
  } catch (error: any) {
    console.error('Error fetching multi balances:', error);
    res.status(500).send(error.message);
  }
});

export const fetchMultiBalancesByTimestamp = functions.https.onRequest(async (req, res) => {
  const { addresses, timestamp, includeUsd } = req.body;

  try {
    const alchemyAdapter = new AlchemyAdapter({
      apiKey: process.env.ALCHEMY_API_KEY || '',
      baseUrl: '',
      throttler: alchemyThrottler,
    });

    const firestoreAdapter = new FirestoreAdapter(db);
    const configService = new ConfigService();
    const priceService = new PriceService(alchemyAdapter, firestoreAdapter);
    const blockService = new BlockService(alchemyAdapter, firestoreAdapter, configService);
    
    const service = new BalanceFetcherService(alchemyAdapter, configService, priceService, blockService);

    let targetDate: Date | undefined;
    if (timestamp) {
      targetDate = new Date(timestamp);
      if (isNaN(targetDate.getTime())) {
        res.status(400).send('Invalid timestamp format');
        return;
      }
    }

    const options: any = {
      timestamp: targetDate,
      includeUsd: includeUsd !== undefined ? includeUsd === true || includeUsd === 'true' : undefined,
    };

    if (addresses && Array.isArray(addresses)) {
      options.wallets = addresses.map(addr => ({ address: addr, label: 'Custom' }));
    }

    // Use specific timestamp logic if provided, otherwise fallback to multi-balance latest
    const balances = targetDate 
      ? await service.fetchMultiWalletBalancesByTimestamp(options)
      : await service.fetchMultiWalletBalances(options);

    res.status(200).json({
      count: balances.length,
      balances,
    });
  } catch (error: any) {
    console.error('Error fetching balances by timestamp:', error);
    res.status(500).send(error.message);
  }
});
