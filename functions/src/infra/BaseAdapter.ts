import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import pRetry from 'p-retry';
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
            console.warn(
              `Attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`
            );
          },
        }
      )
    );
  }

  abstract fetchTransactions(params: any): Promise<any>;
}
