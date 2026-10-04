import { ProviderRegistry } from '../services';
import { ModelRegistryService, LoadBalancerService } from '../../../domain/provider';
import { ApiRequestService } from '../../../domain/request';
import { CreditService } from '../../../domain/user';
import { DiscountService } from '../../../domain/discount';
import { isCriticalError, getErrorType } from '../../../domain/shared';
import type { EmbeddingRequest, EmbeddingResponse, AuthenticatedUser } from '../types';
import type { ILogger } from '../../../core/logging';
import type { ICryptoService } from '../../../core/security';

interface EmbeddingExecution {
  readonly requestId: string;
  readonly startTime: number;
  readonly user: AuthenticatedUser;
  readonly model: string;
  readonly estimatedTokens: number;
  readonly inputCount: number;
  providerId?: string;
  subProviderId?: string;
}

interface ProviderExecution {
  readonly provider: any;
  readonly subProvider: any;
  readonly providerId: string;
  readonly startTime: number;
}

interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string;
}

export class EmbeddingsService {
  private static readonly MAX_RETRIES = 5;
  private static readonly TOKEN_RATIO = 4;
  private static readonly MAX_INPUTS = 2048;

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

  async createEmbeddings(
    request: EmbeddingRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<EmbeddingResponse> {
    const execution = this.createExecution(request, user);
    
    this.logRequestInitiation(execution, request);

    try {
      await this.validateEmbeddingRequest(request, user);
      await this.authorizeEmbeddingRequest(request, execution);
      
      const apiRequest = await this.createApiRequest(request, user, clientInfo);
      await this.requestTracker.startProcessing(apiRequest.id);

      const result = await this.executeEmbeddingRequest(request, execution);
      await this.finalizeEmbeddingRequest(apiRequest, request, result, execution);

      this.logRequestSuccess(execution, result);
      return this.enhanceResponse(result, execution);

    } catch (error) {
      this.logRequestFailure(error as Error, execution);
      throw error;
    }
  }

  private createExecution(request: EmbeddingRequest, user: AuthenticatedUser): EmbeddingExecution {
    return {
      requestId: this.generateRequestId(),
      startTime: Date.now(),
      user,
      model: request.model,
      estimatedTokens: this.calculateTokenEstimate(request),
      inputCount: Array.isArray(request.input) ? request.input.length : 1
    };
  }

  private async executeEmbeddingRequest(
    request: EmbeddingRequest,
    execution: EmbeddingExecution
  ): Promise<EmbeddingResponse> {
    const excludedProviders: string[] = [];
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= EmbeddingsService.MAX_RETRIES; attempt++) {
      try {
        const providerExecution = await this.acquireProvider(
          request.model,
          execution.estimatedTokens,
          excludedProviders
        );

        if (!providerExecution) {
          if (attempt < EmbeddingsService.MAX_RETRIES) continue;
          throw new Error('No available providers for this request');
        }

        const result = await this.executeProviderRequest(request, providerExecution);
        await this.recordProviderSuccess(providerExecution, execution);

        execution.providerId = providerExecution.providerId;
        execution.subProviderId = providerExecution.subProvider?.id;
        
        return result;

      } catch (error) {
        lastError = error as Error;
        this.handleProviderAttemptFailure(error as Error, execution, attempt, excludedProviders);
        if (attempt >= EmbeddingsService.MAX_RETRIES) break;
      }
    }

    throw lastError || new Error('All embeddings provider attempts exhausted');
  }

  private async acquireProvider(
    model: string,
    estimatedTokens: number,
    excluded: string[]
  ): Promise<ProviderExecution | null> {
    const selection = await this.loadBalancer.select({
      model,
      estimatedTokens,
      excludeIds: excluded,
      requireHealthy: false
    });

    if (!selection) return null;

    const provider = selection.subProvider
      ? this.createSubProviderAdapter(selection)
      : this.providerRegistry.getAdapter(selection.provider.name);

    if (!provider || !provider.supportsCapability('embeddings')) {
      return null;
    }

    const reserved = await this.loadBalancer.recordRequestStart(
      selection.subProvider?.id,
      estimatedTokens
    );

    if (!reserved) return null;

    return {
      provider,
      subProvider: selection.subProvider,
      providerId: selection.provider.id,
      startTime: Date.now()
    };
  }

  private createSubProviderAdapter(selection: any) {
    const decryptedApiKey = selection.subProvider.getDecryptedApiKey(this.cryptoService);
    return this.providerRegistry.createAdapterWithApiKey(
      selection.provider.name,
      decryptedApiKey,
      selection.subProvider
    );
  }

  private async executeProviderRequest(
    request: EmbeddingRequest,
    providerExecution: ProviderExecution
  ): Promise<EmbeddingResponse> {
    try {
      return await providerExecution.provider.createEmbeddings(request);
    } catch (error) {
      await this.handleProviderError(error as Error, providerExecution);
      throw error;
    }
  }

  private async handleProviderError(error: Error, providerExecution: ProviderExecution): Promise<void> {
    const errorType = getErrorType(error.message);
    const isCritical = isCriticalError(error.message);

    await this.loadBalancer.recordRequestComplete(
      providerExecution.providerId,
      false,
      Date.now() - providerExecution.startTime,
      0,
      errorType,
      providerExecution.subProvider?.id,
      error.message
    );

    if (isCritical && providerExecution.subProvider) {
      this.logger.warn('Critical error detected in embeddings provider', {
        metadata: {
          subProviderId: providerExecution.subProvider.id,
          providerId: providerExecution.providerId,
          error: error.message,
          errorType,
          isCritical
        }
      });
    }
  }

  private async recordProviderSuccess(
    providerExecution: ProviderExecution,
    execution: EmbeddingExecution
  ): Promise<void> {
    await this.loadBalancer.recordRequestComplete(
      providerExecution.providerId,
      true,
      Date.now() - providerExecution.startTime,
      execution.estimatedTokens,
      undefined,
      providerExecution.subProvider?.id
    );
  }

  private async authorizeEmbeddingRequest(
    request: EmbeddingRequest,
    execution: EmbeddingExecution
  ): Promise<void> {
    if (execution.user.isMasterAdmin || execution.user.isAnonymous) return;

    const credits = this.modelRegistry.getBaseCost(request.model);
    const estimatedCredits = credits * execution.inputCount;

    if (!execution.user.credits || execution.user.credits < estimatedCredits) {
      throw new Error('Insufficient credits for embeddings creation');
    }
  }

  private async finalizeEmbeddingRequest(
    apiRequest: any,
    request: EmbeddingRequest,
    result: EmbeddingResponse,
    execution: EmbeddingExecution
  ): Promise<void> {
    const credits = this.modelRegistry.getBaseCost(request.model);
    const actualCredits = credits * execution.inputCount;
    const duration = Date.now() - execution.startTime;

    if (!execution.user.isMasterAdmin && !execution.user.isAnonymous) {
      await this.billing.deductCredits(
        execution.user.id,
        actualCredits,
        'Embeddings creation',
        '/v1/embeddings',
        execution.estimatedTokens
      );
    }

    await this.requestTracker.completeRequest(
      apiRequest.id,
      execution.estimatedTokens,
      actualCredits,
      duration,
      JSON.stringify(result).length,
      200,
      execution.providerId,
      execution.subProviderId
    );
  }

  private async validateEmbeddingRequest(request: EmbeddingRequest, user: AuthenticatedUser): Promise<void> {
    if (!request.model?.trim()) {
      throw new Error('Model is required');
    }

    if (!this.modelRegistry.exists(request.model)) {
      throw new Error(`Model '${request.model}' does not exist`);
    }

    if (!this.modelRegistry.supportsEndpoint(request.model, '/v1/embeddings')) {
      throw new Error(`Model '${request.model}' does not support embeddings`);
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
      if (input.length > EmbeddingsService.MAX_INPUTS) {
        throw new Error(`Too many inputs (max ${EmbeddingsService.MAX_INPUTS})`);
      }
    }
  }

  private calculateTokenEstimate(request: EmbeddingRequest): number {
    if (Array.isArray(request.input)) {
      return request.input.reduce((total, text) => {
        return total + Math.ceil(text.length / EmbeddingsService.TOKEN_RATIO);
      }, 0);
    }
    return Math.ceil(request.input.length / EmbeddingsService.TOKEN_RATIO);
  }

  private async createApiRequest(
    request: EmbeddingRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ) {
    return this.requestTracker.createRequest({
      userId: user.isMasterAdmin || user.isAnonymous ? undefined : user.id,
      endpoint: '/v1/embeddings',
      method: 'POST',
      model: request.model,
      ipAddress: clientInfo.ip,
      userAgent: clientInfo.userAgent,
      requestSize: JSON.stringify(request).length
    });
  }

  private generateRequestId(): string {
    return `emb_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private enhanceResponse(
    response: EmbeddingResponse,
    execution: EmbeddingExecution
  ): EmbeddingResponse {
    return {
      ...response,
      id: execution.requestId,
      provider: execution.providerId || 'embeddings_provider'
    };
  }

  private logRequestInitiation(execution: EmbeddingExecution, request: EmbeddingRequest): void {
    this.logger.info('Embeddings request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        inputCount: execution.inputCount,
        estimatedTokens: execution.estimatedTokens
      }
    });
  }

  private logRequestSuccess(execution: EmbeddingExecution, result: EmbeddingResponse): void {
    this.logger.info('Embeddings created successfully', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: execution.model,
        inputCount: execution.inputCount,
        embeddingDimensions: result.data[0]?.embedding?.length || 0,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logRequestFailure(error: Error, execution: EmbeddingExecution): void {
    this.logger.error('Embeddings creation failed', error, {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: execution.model,
        inputCount: execution.inputCount,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private handleProviderAttemptFailure(
    error: Error,
    execution: EmbeddingExecution,
    attempt: number,
    excludedProviders: string[]
  ): void {
    excludedProviders.push('failed_provider');
    
    this.logger.warn('Embeddings provider attempt failed', {
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