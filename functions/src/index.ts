import * as functions from 'firebase-functions/v1';
import admin from 'firebase-admin';
import { Throttler } from './infra/Throttler.js';
import { MoralisAdapter } from './infra/MoralisAdapter.js';
import { AlchemyAdapter } from './infra/AlchemyAdapter.js';
import { FirestoreAdapter } from './infra/FirestoreAdapter.js';
import { CacheService } from './domain/CacheService.js';
import { TransactionFetcherService } from './application/TransactionFetcherService.js';
import { BalanceFetcherService } from './application/BalanceFetcherService.js';
import { ConfigService } from './domain/ConfigService.js';
import { PriceService } from './domain/PriceService.js';
import { BlockService } from './domain/BlockService.js';
import { CsvService } from './domain/CsvService.js';

admin.initializeApp();

const db = admin.firestore();

// Throttlers for different providers
const moralisThrottler = new Throttler({ concurrency: 1, interval: 1000, intervalCap: 1 }); // 1 QPS
const alchemyThrottler = new Throttler({ concurrency: 50, interval: 1000, intervalCap: 50 }); // Adjusted for Alchemy

export const fetchTransactions = functions
  .runWith({ timeoutSeconds: 540, memory: '1GB' })
  .https.onRequest(async (req, res) => {
  const { walletAddress, chain, fromBlock, toBlock, exportCsv, dryRun } = req.query;
  functions.logger.info('fetchTransactions requested', { walletAddress, chain, fromBlock, toBlock, exportCsv, dryRun });

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
    const cacheService = new CacheService(firestoreAdapter, { dryRun: dryRun === 'true' });
    const configService = new ConfigService();
    const priceService = new PriceService(alchemyAdapter, cacheService);
    const service = new TransactionFetcherService(moralisAdapter, alchemyAdapter, cacheService, undefined, priceService, configService);

    const transactions = await service.fetchAndCache({
      walletAddress: walletAddress as string,
      chain: chain as string,
      fromBlock: fromBlock ? parseInt(fromBlock as string) : undefined,
      toBlock: toBlock ? parseInt(toBlock as string) : undefined,
    });

    if (exportCsv === 'true') {
      const csvService = new CsvService(configService);
      const csv = csvService.generateTransactionCsv(transactions);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=transactions_${walletAddress}_${chain}.csv`);
      res.status(200).send(csv);
    } else {
      res.status(200).json({
        count: transactions.length,
        message: 'Transactions fetched and cached successfully',
      });
    }
  } catch (error: any) {
    console.error('Error fetching transactions:', error);
    res.status(500).send(error.message);
  }
});

export const fetchBalances = functions.https.onRequest(async (req, res) => {
  const { addresses, timestamp, blockNumber, chainBlockNumbers, includeUsd, exportCsv, useCache, dryRun } = req.body;
  functions.logger.info('fetchBalances requested', { addresses, timestamp, blockNumber, includeUsd, exportCsv, useCache, dryRun });

  try {
    const alchemyAdapter = new AlchemyAdapter({
      apiKey: process.env.ALCHEMY_API_KEY || '',
      baseUrl: '',
      throttler: alchemyThrottler,
    });

    const firestoreAdapter = new FirestoreAdapter(db);
    const cacheService = new CacheService(firestoreAdapter, {
      useCache: useCache !== false,
      dryRun: dryRun === true || dryRun === 'true',
    });
    const configService = new ConfigService();
    const priceService = new PriceService(alchemyAdapter, cacheService);
    const blockService = new BlockService(alchemyAdapter, cacheService, configService);

    const service = new BalanceFetcherService(alchemyAdapter, configService, priceService, cacheService, blockService);

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
      blockNumber: blockNumber ? parseInt(blockNumber as string) : undefined,
      chainBlockNumbers,
      includeUsd: includeUsd !== undefined ? includeUsd === true || includeUsd === 'true' : undefined,
    };

    if (addresses && Array.isArray(addresses)) {
      options.wallets = addresses.map(addr => ({ address: addr, label: 'Custom' }));
    }

    const balances = await service.fetchBalances(options);

    if (exportCsv === true || exportCsv === 'true') {
      const csvService = new CsvService(configService);
      const csv = csvService.generateBalanceCsv(balances);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=balances.csv');
      res.status(200).send(csv);
    } else {
      res.status(200).json({
        count: balances.length,
        balances,
      });
    }
  } catch (error: any) {
    console.error('Error fetching balances:', error);
    res.status(500).send(error.message);
  }
});

export const fetchMultiTransactions = functions
  .runWith({ timeoutSeconds: 540, memory: '1GB' })
  .https.onRequest(async (req, res) => {
  const { addresses, chains, startDate, endDate, fromBlock, toBlock, useCache, exportCsv, dryRun } = req.body;
  functions.logger.info('fetchMultiTransactions requested', { addresses, chains, startDate, endDate, fromBlock, toBlock, useCache, exportCsv, dryRun });

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
    const cacheService = new CacheService(firestoreAdapter, {
      useCache: useCache !== false,
      dryRun: dryRun === true || dryRun === 'true',
    });
    const configService = new ConfigService();
    const priceService = new PriceService(alchemyAdapter, cacheService);
    const blockService = new BlockService(alchemyAdapter, cacheService, configService);

    const service = new TransactionFetcherService(moralisAdapter, alchemyAdapter, cacheService, blockService, priceService, configService);

    const options: any = {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      fromBlock: fromBlock ? parseInt(fromBlock) : undefined,
      toBlock: toBlock ? parseInt(toBlock) : undefined,
      chains: chains || configService.getGlobalChains(),
    };

    if (addresses && Array.isArray(addresses)) {
      options.wallets = addresses.map(addr => ({ address: addr, label: 'Custom' }));
    } else {
      options.wallets = configService.getWallets();
    }

    const transactions = await service.fetchMultiWalletTransactions(options);

    if (exportCsv === true || exportCsv === 'true') {
      const csvService = new CsvService(configService);
      const csv = csvService.generateTransactionCsv(transactions, options.wallets);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=multi_transactions.csv');
      res.status(200).send(csv);
    } else {
      res.status(200).json({
        count: transactions.length,
        transactions,
      });
    }
  } catch (error: any) {
    console.error('Error fetching multi transactions:', error);
    res.status(500).send(error.message);
  }
});
