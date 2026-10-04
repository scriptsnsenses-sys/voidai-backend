import { Kernel, type IKernel } from './kernel';
import { CoreModule, type IDatabaseService, type ILogger } from './core';

export interface BootstrapConfig {
  environment?: 'development' | 'production' | 'test';
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

interface ServiceDefinition {
  name: string;
  factory: (kernel: IKernel, logger: ILogger) => Promise<any>;
}

export class ApplicationBootstrap {
  private readonly kernel: IKernel;
  private logger?: ILogger;

  constructor(config: BootstrapConfig = {}) {
    this.kernel = new Kernel({
      environment: config.environment || 'development',
      logLevel: config.logLevel || 'info',
      gracefulShutdownTimeout: 30000
    });
  }

  async initialize(): Promise<void> {
    try {
      this.kernel.registerModule(new CoreModule());
      await this.kernel.initialize();
      
      this.logger = this.kernel.get<ILogger>('Logger');
      this.logger.info('Application bootstrap initialization started');

      const serviceGroups = [
        this.getRepositoryDefinitions(),
        this.getDomainServiceDefinitions(),
        this.getInfrastructureServiceDefinitions(),
        this.getHandlerServiceDefinitions(),
        this.getPresentationComponentDefinitions()
      ];

      for (const services of serviceGroups) {
        this.registerServices(services);
      }

      await this.initializeProviders();
      this.logger.info('Application bootstrap initialization completed');

    } catch (error) {
      console.error('Bootstrap initialization failed:', error);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    try {
      this.logger?.info('Application shutdown initiated');
      await this.kernel.shutdown();
      this.logger?.info('Application shutdown completed');
    } catch (error) {
      console.error('Error during shutdown:', error);
      throw error;
    }
  }

  getKernel(): IKernel {
    return this.kernel;
  }

  private registerServices(services: ServiceDefinition[]): void {
    services.forEach(({ name, factory }) => {
      this.kernel.registerAsync(name, (kernel) => {
        const logger = kernel.get<ILogger>('Logger');
        return factory(kernel, logger);
      });
    });
  }

  private getRepositoryDefinitions(): ServiceDefinition[] {
    return [
      {
        name: 'UserRepository',
        factory: async (kernel, logger) => {
          const { UserRepository } = await import('./infrastructure/repositories');
          const databaseService = await kernel.getAsync<IDatabaseService>('DatabaseService');
          return new UserRepository(databaseService, logger);
        }
      },
      {
        name: 'ApiKeyRepository',
        factory: async (kernel, logger) => {
          const { ApiKeyRepository } = await import('./infrastructure/repositories');
          const databaseService = await kernel.getAsync<IDatabaseService>('DatabaseService');
          return new ApiKeyRepository(databaseService, logger);
        }
      },
      {
        name: 'OAuthTokenRepository',
        factory: async (kernel, logger) => {
          const { OAuthTokenRepository } = await import('./infrastructure/repositories/oauth-token.repository');
          const databaseService = await kernel.getAsync<IDatabaseService>('DatabaseService');
          return new OAuthTokenRepository(databaseService.getPrisma(), logger);
        }
      },
      {
        name: 'ProviderRepository',
        factory: async (kernel, logger) => {
          const { ProviderRepository } = await import('./infrastructure/repositories');
          const databaseService = await kernel.getAsync<IDatabaseService>('DatabaseService');
          return new ProviderRepository(databaseService, logger);
        }
      },
      {
        name: 'SubProviderRepository',
        factory: async (kernel, logger) => {
          const { SubProviderRepository } = await import('./infrastructure/repositories');
          const databaseService = await kernel.getAsync<IDatabaseService>('DatabaseService');
          return new SubProviderRepository(databaseService, logger);
        }
      },
      {
        name: 'ApiRequestRepository',
        factory: async (kernel, logger) => {
          const { ApiRequestRepository } = await import('./infrastructure/repositories');
          const databaseService = await kernel.getAsync<IDatabaseService>('DatabaseService');
          return new ApiRequestRepository(databaseService, logger);
        }
      },
      {
        name: 'VideoJobRepository',
        factory: async (kernel, logger) => {
          const { VideoJobRepository } = await import('./infrastructure/repositories');
          const databaseService = await kernel.getAsync<IDatabaseService>('DatabaseService');
          return new VideoJobRepository(databaseService, logger);
        }
      },
      {
        name: 'UserDiscountRepository',
        factory: async (kernel) => {
          const { UserDiscountRepository } = await import('./infrastructure/repositories');
          const databaseService = await kernel.getAsync<IDatabaseService>('DatabaseService');
          return new UserDiscountRepository(databaseService.getPrisma());
        }
      }
    ];
  }

  private getDomainServiceDefinitions(): ServiceDefinition[] {
    return [
      {
        name: 'UserService',
        factory: async (kernel, logger) => {
          const { UserService } = await import('./domain/user');
          const userRepository = await kernel.getAsync<any>('UserRepository');
          const apiKeyRepository = await kernel.getAsync<any>('ApiKeyRepository');
          const cryptoService = kernel.get<any>('CryptoService');
          return new UserService(userRepository, apiKeyRepository, logger, cryptoService);
        }
      },
      {
        name: 'CreditService',
        factory: async (kernel, logger) => {
          const { CreditService } = await import('./domain/user');
          const userRepository = await kernel.getAsync<any>('UserRepository');
          return new CreditService(userRepository, logger);
        }
      },
      {
        name: 'SecurityService',
        factory: async (kernel, logger) => {
          const { SecurityService } = await import('./domain/user');
          const userRepository = await kernel.getAsync<any>('UserRepository');
          const cacheService = await kernel.getAsync<any>('CacheService');
          const loadBalancer = await kernel.getAsync<any>('LoadBalancerService');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const cryptoService = kernel.get<any>('CryptoService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');

          return new SecurityService(
            userRepository,
            cacheService,
            loadBalancer,
            providerRegistry,
            cryptoService,
            modelRegistry,
            logger
          );
        }
      },
      {
        name: 'AuthService',
        factory: async (kernel, logger) => {
          const { AuthService } = await import('./domain/user');
          const userRepository = await kernel.getAsync<any>('UserRepository');
          const apiKeyRepository = await kernel.getAsync<any>('ApiKeyRepository');
          const oauthTokenRepository = await kernel.getAsync<any>('OAuthTokenRepository');
          const cryptoService = kernel.get<any>('CryptoService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          const authService = new AuthService(userRepository, apiKeyRepository, logger, cryptoService, modelRegistry);
          authService.setOAuthTokenRepository(oauthTokenRepository);
          return authService;
        }
      },
      {
        name: 'ProviderService',
        factory: async (kernel, logger) => {
          const { ProviderService } = await import('./domain/provider');
          const providerRepository = await kernel.getAsync<any>('ProviderRepository');
          return new ProviderService(providerRepository, logger);
        }
      },
      {
        name: 'SubProviderService',
        factory: async (kernel, logger) => {
          const { SubProviderService } = await import('./domain/provider');
          const subProviderRepository = await kernel.getAsync<any>('SubProviderRepository');
          const cryptoService = kernel.get<any>('CryptoService');
          return new SubProviderService(subProviderRepository, logger, cryptoService);
        }
      },
      {
        name: 'LoadBalancerService',
        factory: async (kernel, logger) => {
          const { LoadBalancerService } = await import('./domain/provider');
          const subProviderRepository = await kernel.getAsync<any>('SubProviderRepository');
          const providerRepository = await kernel.getAsync<any>('ProviderRepository');
          const subProviderService = await kernel.getAsync<any>('SubProviderService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          return new LoadBalancerService(subProviderRepository, logger, providerRepository, subProviderService, modelRegistry);
        }
      },
      {
        name: 'HealthMonitorService',
        factory: async (kernel, logger) => {
          const { HealthMonitorService } = await import('./domain/provider');
          const providerRepository = await kernel.getAsync<any>('ProviderRepository');
          const subProviderRepository = await kernel.getAsync<any>('SubProviderRepository');
          return new HealthMonitorService(providerRepository, subProviderRepository, logger);
        }
      },
      {
        name: 'ModelRegistryService',
        factory: async () => {
          const { ModelRegistryService } = await import('./domain/provider');
          return new ModelRegistryService();
        }
      },
      {
        name: 'ApiRequestService',
        factory: async (kernel, logger) => {
          const { ApiRequestService } = await import('./domain/request');
          const apiRequestRepository = await kernel.getAsync<any>('ApiRequestRepository');
          return new ApiRequestService(apiRequestRepository, logger);
        }
      },
      {
        name: 'DiscountService',
        factory: async (kernel, logger) => {
          const { DiscountService } = await import('./domain/discount');
          const discountRepository = await kernel.getAsync<any>('UserDiscountRepository');
          const userRepository = await kernel.getAsync<any>('UserRepository');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          return new DiscountService(discountRepository, userRepository, modelRegistry, logger);
        }
      }
    ];
  }

  private getInfrastructureServiceDefinitions(): ServiceDefinition[] {
    return [
      {
        name: 'ProviderRegistry',
        factory: async (_, logger) => {
          const { ProviderRegistry } = await import('./infrastructure/providers/services');
          return new ProviderRegistry(logger);
        }
      },
      {
        name: 'ProviderInitializationService',
        factory: async (kernel, logger) => {
          const { ProviderInitializationService } = await import('./infrastructure/providers/services');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const providerService = await kernel.getAsync<any>('ProviderService');
          return new ProviderInitializationService(providerRegistry, logger, providerService);
        }
      }
    ];
  }

  private getHandlerServiceDefinitions(): ServiceDefinition[] {
    return [
      {
        name: 'ChatService',
        factory: async (kernel, logger) => {
          const { ChatService } = await import('./infrastructure/providers/handlers');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const loadBalancer = await kernel.getAsync<any>('LoadBalancerService');
          const requestTracker = await kernel.getAsync<any>('ApiRequestService');
          const billing = await kernel.getAsync<any>('CreditService');
          const security = await kernel.getAsync<any>('SecurityService');
          const authorization = await kernel.getAsync<any>('AuthService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          const discountService = await kernel.getAsync<any>('DiscountService');
          const cryptoService = kernel.get<any>('CryptoService');

          return new ChatService(
            providerRegistry,
            loadBalancer,
            requestTracker,
            billing,
            security,
            authorization,
            modelRegistry,
            discountService,
            logger,
            cryptoService
          );
        }
      },
      {
        name: 'ImagesService',
        factory: async (kernel, logger) => {
          const { ImagesService } = await import('./infrastructure/providers/handlers');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const requestTracker = await kernel.getAsync<any>('ApiRequestService');
          const billing = await kernel.getAsync<any>('CreditService');
          const security = await kernel.getAsync<any>('SecurityService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          const discountService = await kernel.getAsync<any>('DiscountService');
          const loadBalancer = await kernel.getAsync<any>('LoadBalancerService');
          const cryptoService = kernel.get<any>('CryptoService');

          return new ImagesService(
            providerRegistry,
            requestTracker,
            billing,
            security,
            modelRegistry,
            discountService,
            logger,
            loadBalancer,
            cryptoService
          );
        }
      },
      {
        name: 'AudioService',
        factory: async (kernel, logger) => {
          const { AudioService } = await import('./infrastructure/providers/handlers');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const requestTracker = await kernel.getAsync<any>('ApiRequestService');
          const billing = await kernel.getAsync<any>('CreditService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          const discountService = await kernel.getAsync<any>('DiscountService');
          const loadBalancer = await kernel.getAsync<any>('LoadBalancerService');
          const cryptoService = kernel.get<any>('CryptoService');

          return new AudioService(
            providerRegistry,
            requestTracker,
            billing,
            modelRegistry,
            discountService,
            logger,
            loadBalancer,
            cryptoService
          );
        }
      },
      {
        name: 'EmbeddingsService',
        factory: async (kernel, logger) => {
          const { EmbeddingsService } = await import('./infrastructure/providers/handlers');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const requestTracker = await kernel.getAsync<any>('ApiRequestService');
          const billing = await kernel.getAsync<any>('CreditService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          const discountService = await kernel.getAsync<any>('DiscountService');
          const loadBalancer = await kernel.getAsync<any>('LoadBalancerService');
          const cryptoService = kernel.get<any>('CryptoService');

          return new EmbeddingsService(
            providerRegistry,
            requestTracker,
            billing,
            modelRegistry,
            discountService,
            logger,
            loadBalancer,
            cryptoService
          );
        }
      },
      {
        name: 'ModerationsService',
        factory: async (kernel, logger) => {
          const { ModerationsService } = await import('./infrastructure/providers/handlers');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const requestTracker = await kernel.getAsync<any>('ApiRequestService');
          const billing = await kernel.getAsync<any>('CreditService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          const discountService = await kernel.getAsync<any>('DiscountService');
          const loadBalancer = await kernel.getAsync<any>('LoadBalancerService');
          const cryptoService = kernel.get<any>('CryptoService');

          return new ModerationsService(
            providerRegistry,
            requestTracker,
            billing,
            modelRegistry,
            discountService,
            logger,
            loadBalancer,
            cryptoService
          );
        }
      },
      {
        name: 'ResponsesService',
        factory: async (kernel, logger) => {
          const { ResponsesService } = await import('./infrastructure/providers/handlers');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const loadBalancer = await kernel.getAsync<any>('LoadBalancerService');
          const requestTracker = await kernel.getAsync<any>('ApiRequestService');
          const billing = await kernel.getAsync<any>('CreditService');
          const security = await kernel.getAsync<any>('SecurityService');
          const authorization = await kernel.getAsync<any>('AuthService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          const discountService = await kernel.getAsync<any>('DiscountService');
          const cryptoService = kernel.get<any>('CryptoService');

          return new ResponsesService(
            providerRegistry,
            loadBalancer,
            requestTracker,
            billing,
            security,
            authorization,
            modelRegistry,
            discountService,
            logger,
            cryptoService
          );
        }
      },
      {
        name: 'VideosService',
        factory: async (kernel, logger) => {
          const { VideosService } = await import('./infrastructure/providers/handlers');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const requestTracker = await kernel.getAsync<any>('ApiRequestService');
          const billing = await kernel.getAsync<any>('CreditService');
          const security = await kernel.getAsync<any>('SecurityService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          const discountService = await kernel.getAsync<any>('DiscountService');
          const loadBalancer = await kernel.getAsync<any>('LoadBalancerService');
          const cryptoService = kernel.get<any>('CryptoService');
          const videoJobRepository = await kernel.getAsync<any>('VideoJobRepository');

          return new VideosService(
            providerRegistry,
            requestTracker,
            billing,
            security,
            modelRegistry,
            discountService,
            logger,
            loadBalancer,
            cryptoService,
            videoJobRepository
          );
        }
      },
      {
        name: 'ModelsService',
        factory: async (kernel, logger) => {
          const { ModelsService } = await import('./infrastructure/providers/handlers');
          const providerRegistry = await kernel.getAsync<any>('ProviderRegistry');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');

          return new ModelsService(providerRegistry, modelRegistry, logger);
        }
      }
    ];
  }

  private getPresentationComponentDefinitions(): ServiceDefinition[] {
    return [
      {
        name: 'RateLimiter',
        factory: async (kernel) => {
          const { RateLimiter } = await import('./core');
          const cacheService = await kernel.getAsync<any>('CacheService');
          return new RateLimiter(cacheService);
        }
      },
      {
        name: 'AuthMiddleware',
        factory: async (kernel, logger) => {
          const { AuthMiddleware } = await import('./presentation/middlewares');
          const authService = await kernel.getAsync<any>('AuthService');
          const databaseService = await kernel.getAsync<IDatabaseService>('DatabaseService');
          return new AuthMiddleware(authService, databaseService, logger);
        }
      },
      {
        name: 'RateLimitMiddleware',
        factory: async (kernel, logger) => {
          const { RateLimitMiddleware } = await import('./presentation/middlewares');
          const rateLimiter = await kernel.getAsync<any>('RateLimiter');
          return new RateLimitMiddleware(rateLimiter, logger);
        }
      },
      {
        name: 'SnakeCaseMiddleware',
        factory: async () => {
          const { SnakeCaseMiddleware } = await import('./presentation/middlewares');
          return new SnakeCaseMiddleware();
        }
      },
      {
        name: 'ChatController',
        factory: async (kernel, logger) => {
          const { ChatController } = await import('./presentation/controllers');
          const chatService = await kernel.getAsync<any>('ChatService');
          return new ChatController(chatService, logger);
        }
      },
      {
        name: 'ImagesController',
        factory: async (kernel, logger) => {
          const { ImagesController } = await import('./presentation/controllers');
          const imagesService = await kernel.getAsync<any>('ImagesService');
          return new ImagesController(imagesService, logger);
        }
      },
      {
        name: 'AudioController',
        factory: async (kernel, logger) => {
          const { AudioController } = await import('./presentation/controllers');
          const audioService = await kernel.getAsync<any>('AudioService');
          return new AudioController(audioService, logger);
        }
      },
      {
        name: 'EmbeddingsController',
        factory: async (kernel, logger) => {
          const { EmbeddingsController } = await import('./presentation/controllers');
          const embeddingsService = await kernel.getAsync<any>('EmbeddingsService');
          return new EmbeddingsController(embeddingsService, logger);
        }
      },
      {
        name: 'ModerationsController',
        factory: async (kernel, logger) => {
          const { ModerationsController } = await import('./presentation/controllers');
          const moderationsService = await kernel.getAsync<any>('ModerationsService');
          return new ModerationsController(moderationsService, logger);
        }
      },
      {
        name: 'ResponsesController',
        factory: async (kernel, logger) => {
          const { ResponsesController } = await import('./presentation/controllers');
          const responsesService = await kernel.getAsync<any>('ResponsesService');
          return new ResponsesController(responsesService, logger);
        }
      },
      {
        name: 'VideosController',
        factory: async (kernel, logger) => {
          const { VideosController } = await import('./presentation/controllers');
          const videosService = await kernel.getAsync<any>('VideosService');
          return new VideosController(videosService, logger);
        }
      },
      {
        name: 'ModelsController',
        factory: async (kernel, logger) => {
          const { ModelsController } = await import('./presentation/controllers');
          const modelsService = await kernel.getAsync<any>('ModelsService');
          return new ModelsController(modelsService, logger);
        }
      },
      {
        name: 'UsersController',
        factory: async (kernel, logger) => {
          const { UsersController } = await import('./presentation/controllers');
          const userService = await kernel.getAsync<any>('UserService');
          const creditService = await kernel.getAsync<any>('CreditService');
          const discountService = await kernel.getAsync<any>('DiscountService');
          return new UsersController(userService, creditService, discountService, logger);
        }
      },
      {
        name: 'SubProvidersController',
        factory: async (kernel, logger) => {
          const { SubProvidersController } = await import('./presentation/controllers');
          const subProviderService = await kernel.getAsync<any>('SubProviderService');
          const healthMonitorService = await kernel.getAsync<any>('HealthMonitorService');
          const providerService = await kernel.getAsync<any>('ProviderService');
          return new SubProvidersController(subProviderService, healthMonitorService, providerService, logger);
        }
      },
      {
        name: 'ApiLogsController',
        factory: async (kernel, logger) => {
          const { ApiLogsController } = await import('./presentation/controllers');
          const apiRequestService = await kernel.getAsync<any>('ApiRequestService');
          return new ApiLogsController(apiRequestService, logger);
        }
      },
      {
        name: 'DiscountsController',
        factory: async (kernel, logger) => {
          const { DiscountsController } = await import('./presentation/controllers');
          const discountService = await kernel.getAsync<any>('DiscountService');
          const modelRegistry = await kernel.getAsync<any>('ModelRegistryService');
          return new DiscountsController(discountService, modelRegistry, logger);
        }
      }
    ];
  }

  private async initializeProviders(): Promise<void> {
    const [providerInitService, healthMonitorService] = await Promise.all([
      this.kernel.getAsync<any>('ProviderInitializationService'),
      this.kernel.getAsync<any>('HealthMonitorService')
    ]);

    await providerInitService.initializeProviders();
    healthMonitorService.startMonitoring();

    this.logger?.info('All services initialized successfully');
  }
}
