import { BaseModule, type IKernel } from '../kernel';
import { createLogger, type ILogger } from './logging';
import { RedisCacheService, type ICacheService } from './cache';
import { CryptoService, RateLimiter } from './security';
import { DatabaseService, type IDatabaseService, type DatabaseConfig } from './database';

export class CoreModule extends BaseModule {
  constructor() {
    super('Core', '1.0.0', []);
  }

  async initialize(): Promise<void> {
    await this.validateDependencies();
    
    this.registerLogger();
    this.registerCacheService();
    this.registerSecurityServices();
    this.registerDatabaseService();

    const logger = this.createModuleLogger();
    logger.info('Core module initialized successfully');
    this.updateHealth('healthy');
  }

  async shutdown(): Promise<void> {
    const logger = this.createModuleLogger();
    
    const cacheService = this.kernel.get<RedisCacheService>('CacheService');
    if (cacheService?.disconnect) {
      await cacheService.disconnect();
    }

    const databaseService = await this.kernel.getAsync<IDatabaseService>('DatabaseService');
    if (databaseService.isConnected()) {
      await databaseService.disconnect();
    }

    logger.info('Core module shut down successfully');
    this.updateHealth('healthy', { shutdownComplete: true });
  }

  private registerLogger(): void {
    this.kernel.register('Logger', (kernel: IKernel) => {
      const config = kernel.get<any>('KernelConfig');
      return createLogger({
        level: config.logLevel || 'info',
        enableConsole: true
      });
    });
  }

  private registerCacheService(): void {
    this.kernel.registerAsync('CacheService', async () => {
      const logger = this.kernel.get<ILogger>('Logger');
      const redisCache = new RedisCacheService(logger, {
        defaultTtl: 3600,
        url: process.env.REDIS_URL,
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        db: parseInt(process.env.REDIS_DB || '0')
      });
        
      try {
        await redisCache.connect();
      } catch (error) {
        console.warn('Failed to connect to Redis, falling back to memory cache:', error);
      }

      return redisCache;
    });
  }

  private registerSecurityServices(): void {
    this.kernel.register('CryptoService', () => new CryptoService());

    this.kernel.registerAsync('RateLimiter', async (kernel: IKernel) => {
      const cacheService = await kernel.getAsync<ICacheService>('CacheService');
      return new RateLimiter(cacheService);
    });
  }

  private registerDatabaseService(): void {
    this.kernel.registerAsync('DatabaseService', async (kernel: IKernel) => {
      const logger = kernel.get<ILogger>('Logger');
      const config: DatabaseConfig = {
        uri: process.env.DATABASE_URL || 'postgresql://admin:password@localhost:5432/voidai',
        database: process.env.POSTGRES_DB || 'voidai',
        pool: {
          min: parseInt(process.env.DB_POOL_MIN || '2'),
          max: parseInt(process.env.DB_POOL_MAX || '10'),
          idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
          acquireTimeoutMillis: parseInt(process.env.DB_ACQUIRE_TIMEOUT || '5000'),
          createTimeoutMillis: parseInt(process.env.DB_CREATE_TIMEOUT || '10000')
        }
      };

      const databaseService = new DatabaseService(config, logger);
      await databaseService.connect();
      return databaseService;
    });
  }
}
