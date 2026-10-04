export interface ICacheService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  mget<T>(keys: string[]): Promise<(T | null)[]>;
  mset<T>(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void>;
}

export interface CacheOptions {
  defaultTtl?: number;
  maxSize?: number;
  checkPeriod?: number;
}