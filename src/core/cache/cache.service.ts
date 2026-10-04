import type { ICacheService, CacheOptions } from './types';
import type { ILogger } from '../logging';

interface RedisOptions extends CacheOptions {
  url?: string;
  host?: string;
  port?: number;
  db?: number;
}

interface CacheEntry<T> {
  key: string;
  value: T;
  ttl?: number;
}

export class RedisCacheService implements ICacheService {
  private static readonly DEFAULT_TTL = 3600;
  private static readonly DEFAULT_HOST = 'localhost';
  private static readonly DEFAULT_PORT = 6379;
  private static readonly DEFAULT_DB = 0;

  private redis!: Bun.RedisClient;
  private connected: boolean;
  private logger: ILogger;
  private options: RedisOptions;

  constructor(logger: ILogger, options: RedisOptions) {
    this.logger = logger;
    this.options = options;
    this.connected = false;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      const url = this.buildRedisUrl();
      this.redis = new Bun.RedisClient(url);
      this.connected = true;
      this.logger.info('Connected to Redis successfully');
    } catch (error) {
      this.logger.error('Failed to connect to Redis', error as Error);
      throw error;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    await this.ensureConnected();
    
    try {
      const value = await this.redis.get(key);
      return this.deserializeValue<T>(value);
    } catch (error) {
      this.logger.error('Cache GET error', error as Error);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    await this.ensureConnected();
    
    try {
      const serialized = this.serializeValue(value);
      const finalTtl = this.resolveTtl(ttl);
      
      await this.setWithTtl(key, serialized, finalTtl);
    } catch (error) {
      this.logger.error('Cache SET error', error as Error);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.ensureConnected();
    
    try {
      await this.redis.del(key);
    } catch (error) {
      this.logger.error('Cache DELETE error', error as Error);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureConnected();
    
    try {
      return await this.redis.exists(key);
    } catch (error) {
      this.logger.error('Cache EXISTS error', error as Error);
      return false;
    }
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    await this.ensureConnected();

    const count = await this.redis.incr(key);
    if (count === 1 && ttlSeconds > 0) {
      await this.redis.expire(key, ttlSeconds);
    }
    return count;
  }

  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    await this.ensureConnected();
    
    try {
      const values = await this.redis.mget(...keys);
      return this.deserializeValues<T>(values);
    } catch (error) {
      this.logger.error('Cache MGET error', error as Error);
      return keys.map(() => null);
    }
  }

  async mset<T>(entries: CacheEntry<T>[]): Promise<void> {
    await this.ensureConnected();
    
    try {
      await this.setMultipleEntries(entries);
    } catch (error) {
      this.logger.error('Cache MSET error', error as Error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      this.connected = false;
      this.logger.info('Disconnected from Redis successfully');
    } catch (error) {
      this.logger.error('Error disconnecting from Redis', error as Error);
      throw error;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private buildRedisUrl(): string {
    if (this.options.url) {
      return this.options.url;
    }

    const host = this.options.host || RedisCacheService.DEFAULT_HOST;
    const port = this.options.port || RedisCacheService.DEFAULT_PORT;
    const db = this.options.db || RedisCacheService.DEFAULT_DB;
    
    return `redis://${host}:${port}/${db}`;
  }

  private serializeValue<T>(value: T): string {
    return JSON.stringify(value);
  }

  private deserializeValue<T>(value: string | null): T | null {
    return value ? JSON.parse(value) : null;
  }

  private deserializeValues<T>(values: (string | null)[]): (T | null)[] {
    return values.map(value => this.deserializeValue<T>(value));
  }

  private resolveTtl(ttl?: number): number {
    return ttl ?? this.options.defaultTtl ?? RedisCacheService.DEFAULT_TTL;
  }

  private async setWithTtl(key: string, value: string, ttl: number): Promise<void> {
    if (ttl > 0) {
      await this.redis.set(key, value, 'EX', ttl);
    } else {
      await this.redis.set(key, value);
    }
  }

  private async setMultipleEntries<T>(entries: CacheEntry<T>[]): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.ttl);
    }
  }
}