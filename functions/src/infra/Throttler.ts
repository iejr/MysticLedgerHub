import PQueue from 'p-queue';

export interface ThrottlerConfig {
  concurrency: number;
  interval: number;
  intervalCap: number;
}

export class Throttler {
  private queue: PQueue;

  constructor(config: ThrottlerConfig) {
    this.queue = new PQueue({
      concurrency: config.concurrency,
      interval: config.interval,
      intervalCap: config.intervalCap,
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.add(fn) as Promise<T>;
  }
}
