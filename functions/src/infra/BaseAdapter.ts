import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import pRetry from 'p-retry';
import { logger } from 'firebase-functions';
import { Throttler } from './Throttler.js';

export interface AdapterConfig {
  baseUrl: string;
  apiKey: string;
  throttler: Throttler;
}

export abstract class BaseAdapter {
  protected client: AxiosInstance;
  protected throttler: Throttler;

  constructor(config: AdapterConfig) {
    this.client = axios.create({
      baseURL: config.baseUrl,
    });
    this.throttler = config.throttler;
  }

  protected async fetchWithRetry<T>(config: AxiosRequestConfig): Promise<T> {
    return this.throttler.run(() =>
      pRetry(
        async () => {
          const response = await this.client.request<T>(config);
          return response.data;
        },
        {
          retries: 3,
          onFailedAttempt: (error) => {
            logger.warn(
              `Attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`,
              { url: config.url, method: config.method }
            );
          },
        }
      )
    );
  }

  abstract fetchTransactions(params: any): Promise<any>;
}
