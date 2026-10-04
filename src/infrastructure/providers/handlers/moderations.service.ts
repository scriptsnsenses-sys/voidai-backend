import { ProviderRegistry } from '../services';
import { ModelRegistryService, LoadBalancerService } from '../../../domain/provider';
import { ApiRequestService } from '../../../domain/request';
import { CreditService } from '../../../domain/user';
import { DiscountService } from '../../../domain/discount';
import { isCriticalError, getErrorType } from '../../../domain/shared';
import type { ModerationRequest, ModerationResponse, AuthenticatedUser } from '../types';
import type { ILogger } from '../../../core/logging';
import type { ICryptoService } from '../../../core/security';

interface ModerationExecution {
  readonly requestId: string;
  readonly startTime: number;
  readonly user: AuthenticatedUser;
  readonly model: string;
  readonly estimatedTokens: number;
  providerId?: string;
  subProviderId?: string;
}

interface ProviderSelection {
  readonly provider: { id: string; name: string };
  readonly subProvider?: {
    id: string;
    getDecryptedApiKey(cryptoService: ICryptoService): string;
  };
}

interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string;
}

export class ModerationsService {
  private static readonly MAX_RETRIES = 5;
  private static readonly TOKEN_RATIO = 4;
  private static readonly MAX_INPUT_LENGTH = 32768;

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly requestTracker: ApiRequestService,
    private readonly billing: CreditService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly discountService: DiscountService,
    private readonly logger: ILogger,
    private readonly loadBalancer: LoadBalancerService,
    private readonly cryptoService: ICryptoService
  ) {}

  async moderateContent(
    request: ModerationRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<ModerationResponse> {
    const execution = this.createExecution(request, user);
    
    this.logModerationInitiation(execution, request);

    try {
      await this.validateModerationRequest(request, user);
      await this.authorizeModerationRequest(request, execution);
      
      const apiRequest = await this.createApiRequest(request, user, clientInfo);
      await this.requestTracker.startProcessing(apiRequest.id);

      const result = await this.executeModerationRequest(request, execution);
      await this.finalizeModerationRequest(apiRequest, request, result, execution);

      this.logModerationSuccess(execution, result);
      return this.enhanceResponse(result, execution);

    } catch (error) {
      this.logModerationError(execution, request, error as Error);
      throw error;
    }
  }

  private createExecution(request: ModerationRequest, user: AuthenticatedUser): ModerationExecution {
    return {
      requestId: this.generateRequestId(),
      startTime: Date.now(),
      user,
      model: request.model,
      estimatedTokens: this.calculateTokenEstimate(request)
    };
  }

  private async executeModerationRequest(
    request: ModerationRequest,
    execution: ModerationExecution
  ): Promise<ModerationResponse> {
    const excludedProviders: string[] = [];
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= ModerationsService.MAX_RETRIES; attempt++) {
      try {
        const selection = await this.selectProvider(request.model, execution.estimatedTokens, excludedProviders);
        
        if (!selection) {
          if (attempt < ModerationsService.MAX_RETRIES) continue;
          throw new Error('No available providers for this request');
        }

        const result = await this.performModerationRequest(request, selection, execution);
        await this.recordProviderSuccess(selection, execution);

        execution.providerId = selection.provider.id;
        execution.subProviderId = selection.subProvider?.id;
        
        return result;

      } catch (error) {
        lastError = error as Error;
        this.handleProviderAttemptFailure(error as Error, execution, attempt, excludedProviders);
        if (attempt >= ModerationsService.MAX_RETRIES) break;
      }
    }

    throw lastError || new Error('All moderation provider attempts exhausted');
  }

  private async selectProvider(
    model: string,
    estimatedTokens: number,
    excludedProviders: string[]
  ): Promise<ProviderSelection | null> {
    const selection = await this.loadBalancer.select({
      model,
      estimatedTokens,
      excludeIds: excludedProviders,
      requireHealthy: false
    });

    if (!selection) return null;

    const provider = await this.createProviderAdapter(selection);
    if (!provider || !provider.supportsCapability('moderation')) {
      return null;
    }

    return {
      provider: selection.provider,
      subProvider: selection.subProvider || undefined
    };
  }

  private async createProviderAdapter(selection: any) {
    if (selection.subProvider) {
      const decryptedApiKey = selection.subProvider.getDecryptedApiKey(this.cryptoService);
      return this.providerRegistry.createAdapterWithApiKey(
        selection.provider.name,
        decryptedApiKey,
        selection.subProvider
      );
    }
    return this.providerRegistry.getAdapter(selection.provider.name);
  }

  private async performModerationRequest(
    request: ModerationRequest,
    selection: ProviderSelection,
    execution: ModerationExecution
  ): Promise<ModerationResponse> {
    const provider = await this.createProviderAdapter(selection);
    if (!provider) {
      throw new Error('Failed to create provider adapter');
    }

    await this.loadBalancer.recordRequestStart(
      selection.subProvider?.id,
      execution.estimatedTokens
    );

    try {
      return await provider.moderateContent(request);
    } catch (error) {
      await this.handleProviderError(error as Error, selection, execution);
      throw error;
    }
  }

  private async handleProviderError(
    error: Error,
    selection: ProviderSelection,
    execution: ModerationExecution
  ): Promise<void> {
    const errorType = getErrorType(error.message);
    const isCritical = isCriticalError(error.message);

    await this.loadBalancer.recordRequestComplete(
      selection.provider.id,
      false,
      Date.now() - execution.startTime,
      0,
      errorType,
      selection.subProvider?.id,
      error.message
    );

    if (isCritical && selection.subProvider) {
      this.logger.warn('Critical error detected in moderation provider', {
        requestId: execution.requestId,
        metadata: {
          subProviderId: selection.subProvider.id,
          providerId: selection.provider.id,
          error: error.message,
          errorType,
          isCritical
        }
      });
    }
  }

  private async recordProviderSuccess(
    selection: ProviderSelection,
    execution: ModerationExecution
  ): Promise<void> {
    await this.loadBalancer.recordRequestComplete(
      selection.provider.id,
      true,
      Date.now() - execution.startTime,
      execution.estimatedTokens,
      undefined,
      selection.subProvider?.id
    );
  }

  private async authorizeModerationRequest(
    request: ModerationRequest,
    execution: ModerationExecution
  ): Promise<void> {
    if (execution.user.isMasterAdmin || execution.user.isAnonymous) return;

    const credits = this.modelRegistry.getBaseCost(request.model);

    if (!execution.user.credits || execution.user.credits < credits) {
      throw new Error('Insufficient credits for content moderation');
    }
  }

  private async finalizeModerationRequest(
    apiRequest: any,
    request: ModerationRequest,
    result: ModerationResponse,
    execution: ModerationExecution
  ): Promise<void> {
    const credits = this.modelRegistry.getBaseCost(request.model);
    const duration = Date.now() - execution.startTime;

    if (!execution.user.isMasterAdmin && !execution.user.isAnonymous) {
      await this.billing.deductCredits(
        execution.user.id,
        credits,
        'Content moderation',
        '/v1/moderations',
        execution.estimatedTokens
      );
    }

    await this.requestTracker.completeRequest(
      apiRequest.id,
      execution.estimatedTokens,
      credits,
      duration,
      JSON.stringify(result).length,
      200,
      execution.providerId,
      execution.subProviderId
    );
  }

  private async validateModerationRequest(request: ModerationRequest, user: AuthenticatedUser): Promise<void> {
    if (!request.model?.trim()) {
      throw new Error('Model is required');
    }

    if (!this.modelRegistry.exists(request.model)) {
      throw new Error(`Model '${request.model}' does not exist`);
    }

    if (!this.modelRegistry.supportsEndpoint(request.model, '/v1/moderations')) {
      throw new Error(`Model '${request.model}' does not support content moderation`);
    }

    if (!user.isMasterAdmin && !this.modelRegistry.hasAccess(request.model, user.plan)) {
      // Check if user has an active, non-expired discount for this model
      const discount = await this.discountService.getUserDiscount(user.id, request.model);
      if (!discount || discount <= 1) {
        throw new Error(`Your plan does not have access to model '${request.model}'. You can only use models available in your plan or models you have an active discount for.`);
      }
    }

    this.validateInput(request.input);
  }

  private validateInput(input: string | string[]): void {
    if (!input) {
      throw new Error('Input is required');
    }

    if (Array.isArray(input)) {
      if (input.length === 0) {
        throw new Error('Input array cannot be empty');
      }
      
      const totalLength = input.join('').length;
      if (totalLength > ModerationsService.MAX_INPUT_LENGTH) {
        throw new Error(`Input text too long (max ${ModerationsService.MAX_INPUT_LENGTH.toLocaleString()} characters)`);
      }
    } else {
      if (typeof input === 'string' && !input.trim()) {
        throw new Error('Input text is required');
      }

      if (input.length > ModerationsService.MAX_INPUT_LENGTH) {
        throw new Error(`Input text too long (max ${ModerationsService.MAX_INPUT_LENGTH.toLocaleString()} characters)`);
      }
    }
  }

  private calculateTokenEstimate(request: ModerationRequest): number {
    if (Array.isArray(request.input)) {
      return Math.ceil(request.input.join('').length / ModerationsService.TOKEN_RATIO);
    }
    return Math.ceil(request.input.length / ModerationsService.TOKEN_RATIO);
  }

  private async createApiRequest(
    request: ModerationRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ) {
    return this.requestTracker.createRequest({
      userId: user.isMasterAdmin || user.isAnonymous ? undefined : user.id,
      endpoint: '/v1/moderations',
      method: 'POST',
      model: request.model,
      ipAddress: clientInfo.ip,
      userAgent: clientInfo.userAgent,
      requestSize: JSON.stringify(request).length
    });
  }

  private generateRequestId(): string {
    return `mod_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private enhanceResponse(
    response: ModerationResponse,
    execution: ModerationExecution
  ): ModerationResponse {
    return {
      ...response,
      id: execution.requestId,
      provider: execution.providerId || 'moderation_provider'
    };
  }

  private logModerationInitiation(execution: ModerationExecution, request: ModerationRequest): void {
    const inputLength = Array.isArray(request.input) 
      ? request.input.join('').length 
      : request.input.length;

    this.logger.info('Content moderation request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        inputLength,
        estimatedTokens: execution.estimatedTokens
      }
    });
  }

  private logModerationSuccess(execution: ModerationExecution, result: ModerationResponse): void {
    this.logger.info('Content moderation completed', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: execution.model,
        flagged: result.results?.[0]?.flagged || false,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logModerationError(
    execution: ModerationExecution,
    request: ModerationRequest,
    error: Error
  ): void {
    const inputLength = Array.isArray(request.input) 
      ? request.input.join('').length 
      : request.input?.length || 0;

    this.logger.error('Content moderation failed', error, {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        inputLength,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private handleProviderAttemptFailure(
    error: Error,
    execution: ModerationExecution,
    attempt: number,
    excludedProviders: string[]
  ): void {
    excludedProviders.push(execution.providerId || 'failed_provider');
    
    this.logger.warn('Moderation provider attempt failed', {
      requestId: execution.requestId,
      metadata: {
        attempt,
        error: error.message,
        model: execution.model,
        errorType: getErrorType(error.message),
        isCritical: isCriticalError(error.message)
      }
    });
  }
}