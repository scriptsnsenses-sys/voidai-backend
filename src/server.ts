import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ApplicationBootstrap } from './bootstrap';
import type { ILogger } from './core/logging';

export interface ServerConfig {
  port: number;
  host: string;
}

export class ApplicationServer {
  private static readonly DEFAULTS = {
    PORT: 8080,
    HOST: '0.0.0.0',
    REQUEST_ID_LENGTH: 9,
    REQUEST_ID_RADIX: 36,
    REQUEST_ID_PREFIX: 'req',
    MAX_BODY_SIZE: 100 * 1024 * 1024
  };

  private readonly app = new Hono({ strict: false });
  private readonly config: ServerConfig;
  private logger?: ILogger;

  constructor(private readonly bootstrap: ApplicationBootstrap) {
    this.config = {
      port: parseInt(process.env.PORT || String(ApplicationServer.DEFAULTS.PORT)),
      host: process.env.HOST || ApplicationServer.DEFAULTS.HOST
    };
    this.setupMiddleware();
  }

  async start(): Promise<void> {
    await this.bootstrap.initialize();
    this.logger = this.bootstrap.getKernel().get<ILogger>('Logger');
    
    await this.setupRoutes();
    this.setupSignals();

    // Increase server-side timeouts to avoid premature disconnects while models are thinking
    const serveOptions: any = {
      port: this.config.port,
      hostname: this.config.host,
      fetch: this.app.fetch.bind(this.app),
      maxRequestBodySize: ApplicationServer.DEFAULTS.MAX_BODY_SIZE,
      // Allow long-lived SSE connections without server-side idle aborts
      idleTimeout: 255        // seconds (Bun max is 255)
    };

    Bun.serve(serveOptions);

    this.logger.info('Server started', { metadata: this.getServerMetadata() });
  }

  private setupMiddleware(): void {
    this.app.use('*', cors(), this.requestMiddleware());
    this.app.onError(this.errorHandler());
  }

  private requestMiddleware() {
    return async (c: any, next: any) => {
      const startTime = Date.now();
      const requestId = this.generateRequestId();

      c.set('startTime', startTime);
      c.set('requestId', requestId);

      this.logger?.debug('Request', { requestId, metadata: this.getRequestMetadata(c) });
      await next();
      this.logger?.info('Response', { 
        requestId, 
        duration: Date.now() - startTime,
        metadata: { ...this.getRequestMetadata(c), status: c.res.status }
      });
    };
  }

  private errorHandler() {
    return (err: Error, c: any) => {
      const duration = Date.now() - (c.get('startTime') || Date.now());
      
      this.logger?.error('Request failed', err, {
        requestId: c.get('requestId'),
        duration,
        metadata: { ...this.getRequestMetadata(c), status: 500 }
      });

      try {
        const error = JSON.parse(err.message);
        return c.json(error, error.status_code || 500);
      } catch {
        return c.json({ error: { message: err.message, type: 'api_error' } }, 500);
      }
    };
  }

  private async setupRoutes(): Promise<void> {
    this.app.get('/health', (c) => c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0'
    }));

    this.app.get('/', (c) => c.json({
      message: 'VOIAI Backend (Not affilated with VoidAI)',
      status: 'operational',
      timestamp: new Date().toISOString()
    }));

    await this.setupGlobalMiddleware();
    await this.setupApiRoutes();
  }

  private async setupGlobalMiddleware(): Promise<void> {
    const kernel = this.bootstrap.getKernel();
    const [auth, snakeCase, rateLimit] = await Promise.all([
      kernel.getAsync<any>('AuthMiddleware'),
      kernel.getAsync<any>('SnakeCaseMiddleware'),
      kernel.getAsync<any>('RateLimitMiddleware')
    ]);

    this.app.use('*', snakeCase.handle);
    this.app.use('/v1/*', rateLimit.handle);
    this.app.use('/v1/*', auth.handle);
    this.app.use('/admin/*', auth.handle);
  }

  private async setupApiRoutes(): Promise<void> {
    const kernel = this.bootstrap.getKernel();
    
    const controllers = await Promise.all([
      'ChatController', 'AudioController', 'EmbeddingsController', 'ImagesController',
      'VideosController', 'ModelsController', 'ModerationsController', 'ResponsesController',
      'SubProvidersController', 'ApiLogsController'
    ].map(name => kernel.getAsync<any>(name)));

    controllers.forEach(controller => this.app.route('/', controller.registerRoutes()));
  }

  private setupSignals(): void {
    ['SIGINT', 'SIGTERM'].forEach(signal => process.on(signal, () => process.exit(0)));
    
    process.on('uncaughtException', (error) => {
      this.logger?.error('Uncaught exception', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      this.logger?.error('Unhandled rejection', new Error(String(reason)));
    });
  }

  private generateRequestId(): string {
    const { REQUEST_ID_PREFIX, REQUEST_ID_RADIX, REQUEST_ID_LENGTH } = ApplicationServer.DEFAULTS;
    const randomPart = Math.random().toString(REQUEST_ID_RADIX).substring(2, REQUEST_ID_LENGTH);
    return `${REQUEST_ID_PREFIX}_${Date.now()}_${randomPart}`;
  }

  private getRequestMetadata(c: any) {
    return {
      method: c.req.method,
      url: c.req.url,
      userAgent: c.req.header('user-agent'),
      ip: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'
    };
  }

  private getServerMetadata() {
    return {
      port: this.config.port,
      host: this.config.host,
      environment: process.env.NODE_ENV || 'development',
      processId: process.pid,
      containerId: process.env.HOSTNAME || 'unknown'
    };
  }
}
