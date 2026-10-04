import type { Context, Next } from 'hono';
import type { IRateLimiter } from '../../core/security';
import type { ILogger } from '../../core/logging';

interface RateLimitConfig {
  requestsPerMinute: number;
  windowMs: number;
}

interface RateLimitError {
  message: string;
  type: string;
  code: string;
}

export class RateLimitMiddleware {
  private readonly config: RateLimitConfig = {
    requestsPerMinute: 8,
    windowMs: 60 * 1000
  };

  constructor(
    private readonly rateLimiter: IRateLimiter,
    private readonly logger: ILogger,
    config?: Partial<RateLimitConfig>
  ) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  public readonly handle = async (c: Context, next: Next): Promise<Response | void> => {
    const key = this.generateRateLimitKey(c);
    const rateLimitKey = `${key}:minute`;

    let isAllowed: boolean;
    try {
      isAllowed = await this.rateLimiter.isAllowed(
        rateLimitKey,
        this.config.requestsPerMinute,
        this.config.windowMs
      );
    } catch (error) {
      this.logRateLimitError(error as Error, key);
      return c.json({
        error: {
          message: 'Rate limiting is temporarily unavailable.',
          type: 'service_unavailable',
          code: 'rate_limit_unavailable'
        }
      }, 503);
    }

    if (!isAllowed) {
      this.logRateLimitExceeded(key);
      return this.createRateLimitResponse(c);
    }

    await next();
  };

  private generateRateLimitKey(c: Context): string {
    const clientIp = this.extractClientIp(c);
    return `ip:${clientIp}`;
  }

  private extractClientIp(c: Context): string {
    return (
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      c.env?.ip ||
      'unknown'
    );
  }

  private logRateLimitExceeded(key: string): void {
    this.logger.warn('Rate limit exceeded', {
      metadata: {
        key,
        requestsPerMinute: this.config.requestsPerMinute,
        windowMs: this.config.windowMs
      }
    });
  }

  private logRateLimitError(error: Error, key: string): void {
    this.logger.error('Rate limiting error', error, {
      metadata: { key }
    });
  }

  private createRateLimitResponse(c: Context): Response {
    const errorResponse: RateLimitError = {
      message: 'Rate limit exceeded. Please try again later.',
      type: 'rate_limit_exceeded',
      code: 'too_many_requests'
    };

    return c.json({ error: errorResponse }, 429);
  }
}