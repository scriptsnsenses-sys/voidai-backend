import type { IRateLimiter } from './types';
import type { ICacheService } from '../cache';

export class RateLimiter implements IRateLimiter {
  private static readonly CACHE_KEY_PREFIX = 'rate_limit:';
  private cacheService: ICacheService;

  constructor(cacheService: ICacheService) {
    this.cacheService = cacheService;
  }

  async isAllowed(key: string, limit: number, windowMs: number): Promise<boolean> {
    const currentCount = await this.incrementWindowCount(key, windowMs);
    return currentCount <= limit;
  }

  async getRemainingRequests(key: string, limit: number, windowMs: number): Promise<number> {
    const currentCount = await this.incrementWindowCount(key, windowMs);
    return Math.max(0, limit - currentCount);
  }

  async reset(key: string): Promise<void> {
    const cacheKey = this.buildCacheKey(key);
    await this.cacheService.delete(cacheKey);
  }

  private async incrementWindowCount(key: string, windowMs: number): Promise<number> {
    const cacheKey = this.buildCacheKey(key);
    return this.cacheService.increment(cacheKey, Math.ceil(windowMs / 1000));
  }

  private buildCacheKey(key: string): string {
    return `${RateLimiter.CACHE_KEY_PREFIX}${key}`;
  }

}
