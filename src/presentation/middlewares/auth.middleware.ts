import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AuthService } from '../../domain/user';
import type { IDatabaseService } from '../../core/database';
import type { ILogger } from '../../core/logging';

interface AuthError {
  message: string;
  type: string;
  code: string;
  param?: string;
}

interface UserContext {
  id: string;
  name: string;
  plan: string;
  credits: number;
  enabled: boolean;
  isMasterAdmin: boolean;
  isAnonymous?: boolean;
  isOAuthToken?: boolean;
  isRPVerified?: boolean;
  rpBonusTokensExpires?: number;
}

interface AuthenticatedUser {
  id: string;
  name: string;
  plan: string;
  credits: number;
  isEnabled: boolean;
  authorizeIpAccess?: (ip: string) => boolean;
  isRPVerified?: boolean;
  rpBonusTokensExpires?: number;
}

enum AuthErrorCode {
  MISSING_HEADER = 'missing_header',
  INVALID_FORMAT = 'invalid_format',
  INVALID_KEY = 'invalid_key',
  INVALID_OAUTH_TOKEN = 'invalid_oauth_token',
  ACCOUNT_DISABLED = 'account_disabled',
  AUTHENTICATION_FAILED = 'authentication_failed',
  INTERNAL_ERROR = 'internal_error',
  IP_ACCESS_DENIED = 'ip_access_denied'
}

export class AuthMiddleware {
  private static readonly AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
    [AuthErrorCode.MISSING_HEADER]:
      'You didn\'t provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY).',
    [AuthErrorCode.INVALID_FORMAT]:
      'Invalid authorization header format. Expected: Authorization: Bearer YOUR_KEY',
    [AuthErrorCode.INVALID_KEY]:
      'Incorrect API key provided. You can find your API key at your dashboard.',
    [AuthErrorCode.INVALID_OAUTH_TOKEN]:
      'Invalid or expired OAuth token. Please sign in again.',
    [AuthErrorCode.ACCOUNT_DISABLED]:
      'Your account has been disabled. Please contact support for assistance.',
    [AuthErrorCode.AUTHENTICATION_FAILED]:
      'Authentication failed. Please check your API key and try again.',
    [AuthErrorCode.INTERNAL_ERROR]:
      'An internal error occurred during authentication. Please try again later.',
    [AuthErrorCode.IP_ACCESS_DENIED]:
      'Access denied: Your IP address is not authorized to access this API.'
  };

  private static readonly API_KEY_PREFIX = 'sk-voidai-';

  private static readonly BEARER_PREFIX = 'Bearer ';
  private static readonly KEY_PREFIX_LENGTH = 8;
  private static readonly ADMIN_PATH_PATTERN = /^\/admin\/([^\/]+)/;

  constructor(
    private readonly authService: AuthService,
    private readonly databaseService: IDatabaseService,
    private readonly logger: ILogger
  ) {}

  public readonly handle = async (c: Context, next: Next): Promise<Response | void> => {
    const startTime = Date.now();
    const requestId = c.get('requestId') || this.generateRequestId();

    try {
      if (c.req.path.startsWith('/admin/')) {
        const authorization = c.req.header('authorization');
        const token = authorization?.startsWith(AuthMiddleware.BEARER_PREFIX)
          ? authorization.slice(AuthMiddleware.BEARER_PREFIX.length).trim()
          : '';
        if (!this.isMasterAdmin(token)) {
          return c.json({
            error: {
              message: 'A valid admin key is required.',
              type: 'authentication_error',
              code: 'invalid_admin_key'
            }
          }, 401);
        }

        this.setMasterAdminContext(c);
        await next();
        return;
      }

      c.set('user', {
        id: 'anonymous',
        name: 'Anonymous',
        plan: 'free',
        credits: Number.MAX_SAFE_INTEGER,
        enabled: true,
        isMasterAdmin: false,
        isAnonymous: true
      });
      await next();
      return;

      await this.ensureDatabaseConnection(requestId);

      const token = this.extractApiKey(c);

      if (this.isMasterAdmin(token)) {
        this.setMasterAdminContext(c);
        await next();
        return;
      }

      // Determine if this is an API key or OAuth token
      const isApiKey = token.startsWith(AuthMiddleware.API_KEY_PREFIX);

      let authResult;
      if (isApiKey) {
        authResult = await this.authService.authenticateApiKey(token);

        if (!authResult.isAuthenticated || !authResult.user) {
          this.logAuthenticationFailure(
            authResult.reason || 'Authentication failed',
            token,
            requestId,
            startTime
          );
          this.throwAuthError(AuthErrorCode.INVALID_KEY);
        }
      } else {
        // Treat as OAuth token
        authResult = await this.authService.authenticateOAuthToken(token);

        if (!authResult.isAuthenticated || !authResult.user) {
          this.logAuthenticationFailure(
            authResult.reason || 'OAuth token authentication failed',
            token,
            requestId,
            startTime
          );
          this.throwAuthError(AuthErrorCode.INVALID_OAUTH_TOKEN);
        }
      }

      const user = authResult.user;
      this.validateUserAccess(user, c, requestId);
      this.validateAdminAccess(user, c, token, requestId, startTime);

      this.logAuthenticationSuccess(user, requestId, startTime);
      this.setUserContext(c, user, authResult.isOAuthToken);

      await next();
    } catch (error) {
      this.handleAuthError(error as Error, requestId, startTime);
    }
  };

  private async ensureDatabaseConnection(requestId: string): Promise<void> {
    if (this.databaseService.isConnected()) {
      return;
    }

    this.logger.warn('Database not connected, attempting reconnection', {
      metadata: { requestId }
    });
    
    try {
      await this.databaseService.connect();
    } catch (error) {
      this.logger.error('Database reconnection failed', error as Error, {
        metadata: { requestId }
      });
      this.throwAuthError(AuthErrorCode.INTERNAL_ERROR, 500);
    }
  }

  private extractApiKey(c: Context): string {
    const authHeader = c.req.header('authorization');
    
    if (!authHeader) {
      this.throwAuthError(AuthErrorCode.MISSING_HEADER);
    }

    if (!authHeader.startsWith(AuthMiddleware.BEARER_PREFIX)) {
      this.throwAuthError(AuthErrorCode.INVALID_FORMAT);
    }

    const apiKey = authHeader.substring(AuthMiddleware.BEARER_PREFIX.length).trim();
    
    if (!apiKey) {
      this.throwAuthError(AuthErrorCode.INVALID_KEY);
    }

    return apiKey;
  }

  private isMasterAdmin(apiKey: string): boolean {
    const masterKey = process.env.MASTER_ADMIN_KEY;
    return Boolean(masterKey && apiKey === masterKey);
  }

  private validateUserAccess(user: AuthenticatedUser, c: Context, requestId: string): void {
    if (!user.isEnabled) {
      this.logger.warn('Authentication failed: Account disabled', {
        metadata: { userId: user.id, requestId }
      });
      this.throwAuthError(AuthErrorCode.ACCOUNT_DISABLED, 403);
    }

    const ipAddress = this.extractIpAddress(c);
    if (user.authorizeIpAccess && !user.authorizeIpAccess(ipAddress)) {
      this.logger.warn('Authentication failed: IP address not authorized', {
        metadata: { userId: user.id, requestId, ipAddress }
      });
      this.throwAuthError(AuthErrorCode.IP_ACCESS_DENIED, 403);
    }
  }

  private validateAdminAccess(
    user: AuthenticatedUser, 
    c: Context, 
    apiKey: string, 
    requestId: string, 
    startTime: number
  ): void {
    const adminResource = this.getAdminResourceFromPath(c.req.path);
    
    if (adminResource && user.plan !== 'admin') {
      this.logAuthenticationFailure(
        'Admin access required', 
        apiKey, 
        requestId, 
        startTime
      );
      this.throwAuthError(AuthErrorCode.INVALID_KEY);
    }
  }

  private extractIpAddress(c: Context): string {
    const forwardedFor = c.req.header('x-forwarded-for');
    return (
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      forwardedFor?.split(',')[0].trim() ||
      'unknown'
    );
  }

  private setMasterAdminContext(c: Context): void {
    const masterAdminContext: UserContext = {
      id: 'master-admin',
      name: 'Master Administrator',
      plan: 'unlimited',
      credits: Number.MAX_SAFE_INTEGER,
      enabled: true,
      isMasterAdmin: true
    };

    c.set('user', masterAdminContext);
  }

  private setUserContext(c: Context, user: AuthenticatedUser, isOAuthToken?: boolean): void {
    const userContext: UserContext = {
      id: user.id,
      name: user.name,
      plan: user.plan,
      credits: user.credits,
      enabled: user.isEnabled,
      isMasterAdmin: false,
      isOAuthToken: isOAuthToken || false,
      isRPVerified: user.isRPVerified || false,
      rpBonusTokensExpires: user.rpBonusTokensExpires
    };

    c.set('user', userContext);
  }

  private getAdminResourceFromPath(path: string): string | null {
    const match = path.match(AuthMiddleware.ADMIN_PATH_PATTERN);
    return match?.[1] || null;
  }

  private createAuthError(message: string, code: string): AuthError {
    return {
      message,
      type: 'authentication_error',
      code
    };
  }

  private throwAuthError(errorCode: AuthErrorCode, status: 401 | 403 | 500 = 401): never {
    const message = AuthMiddleware.AUTH_ERROR_MESSAGES[errorCode];
    const error = this.createAuthError(message, errorCode);
    
    throw new HTTPException(status, {
      message: JSON.stringify({ error })
    });
  }

  private handleAuthError(error: Error, requestId: string, startTime: number): never {
    if (error instanceof HTTPException) {
      throw error;
    }

    this.logger.error('Unexpected authentication error', error, {
      metadata: {
        requestId,
        duration: Date.now() - startTime
      }
    });
    
    this.throwAuthError(AuthErrorCode.INTERNAL_ERROR, 500);
  }

  private logAuthenticationFailure(
    reason: string, 
    apiKey: string, 
    requestId: string, 
    startTime: number
  ): void {
    this.logger.warn(`Authentication failed: ${reason}`, {
      metadata: {
        requestId,
        keyPrefix: this.getKeyPrefix(apiKey),
        duration: Date.now() - startTime
      }
    });
  }

  private logAuthenticationSuccess(
    user: AuthenticatedUser, 
    requestId: string, 
    startTime: number
  ): void {
    this.logger.info('User authenticated successfully', {
      metadata: {
        userId: user.id,
        requestId,
        plan: user.plan,
        isRPVerified: user.isRPVerified,
        duration: Date.now() - startTime
      }
    });
  }

  private getKeyPrefix(apiKey: string): string {
    return `${apiKey.substring(0, AuthMiddleware.KEY_PREFIX_LENGTH)}...`;
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}