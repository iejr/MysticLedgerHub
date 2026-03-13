import * as functions from 'firebase-functions';
import admin from 'firebase-admin';
import { Throttler } from './infra/Throttler.js';
import { MoralisAdapter } from './infra/MoralisAdapter.js';
import { AlchemyAdapter } from './infra/AlchemyAdapter.js';
import { FirestoreAdapter } from './infra/FirestoreAdapter.js';
import { TransactionFetcherService } from './application/TransactionFetcherService.js';

// admin.initializeApp();
if (!admin.apps.length) {
  console.log("initializing admin");
  admin.initializeApp();
}

const db = admin.firestore();

// Throttlers for different providers
const moralisThrottler = new Throttler({ concurrency: 1, interval: 1000, intervalCap: 1 }); // 1 QPS
const alchemyThrottler = new Throttler({ concurrency: 5, interval: 1000, intervalCap: 5 }); // Adjusted for Alchemy

export const fetchTransactions = functions.https.onRequest(async (req, res) => {
  const { walletAddress, chain, fromBlock, toBlock } = req.query;

  // console.log("Request arguments: ");
  // console.log(req.query);
  // res.status(200).json({result: 'ok'});
  // return;

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
