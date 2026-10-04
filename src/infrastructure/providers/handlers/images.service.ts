import { ProviderRegistry } from '../services';
import { ModelRegistryService, LoadBalancerService } from '../../../domain/provider';
import { ApiRequestService } from '../../../domain/request';
import { CreditService, SecurityService } from '../../../domain/user';
import { DiscountService } from '../../../domain/discount';
import { isCriticalError, getErrorType } from '../../../domain/shared';
import type { 
  ImageGenerationRequest, 
  ImageEditRequest, 
  ImageResponse, 
  AuthenticatedUser 
} from '../types';
import type { ILogger } from '../../../core/logging';
import type { ICryptoService } from '../../../core/security';

interface ImageExecution {
  readonly requestId: string;
  readonly startTime: number;
  readonly user: AuthenticatedUser;
  readonly model: string;
  readonly endpoint: string;
  readonly imageCount: number;
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
  readonly origin: string;
}

export class ImagesService {
  private static readonly MAX_RETRIES = 5;
  private static readonly MAX_PROMPT_LENGTH = 4000;
  private static readonly MIN_IMAGES = 1;
  private static readonly MAX_IMAGES = 10;
  private static readonly PROMPT_PREVIEW_LENGTH = 100;

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly requestTracker: ApiRequestService,
    private readonly billing: CreditService,
    private readonly security: SecurityService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly discountService: DiscountService,
    private readonly logger: ILogger,
    private readonly loadBalancer: LoadBalancerService,
    private readonly cryptoService: ICryptoService
  ) {}

  async generateImages(
    request: ImageGenerationRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<ImageResponse> {
    const execution = this.createGenerationExecution(request, user);
    
    this.logGenerationInitiation(execution, request);

    try {
      await this.validateGenerationRequest(request, user);
      await this.performContentCheck(request.prompt, execution, clientInfo);
      await this.authorizeImageRequest(request, execution);
      
      const apiRequest = await this.createGenerationApiRequest(request, user, clientInfo);
      await this.requestTracker.startProcessing(apiRequest.id);

      const result = await this.executeGenerationRequest(request, execution);
      await this.finalizeImageRequest(apiRequest, request, result, execution);

      this.logGenerationSuccess(execution, result);
      return this.enhanceResponse(result, execution);

    } catch (error) {
      this.logGenerationError(execution, request, error as Error);
      throw error;
    }
  }

  async editImages(
    request: ImageEditRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<ImageResponse> {
    const execution = this.createEditExecution(request, user);
    
    this.logEditInitiation(execution, request);

    try {
      await this.validateEditRequest(request, execution.user);
      await this.performContentCheck(request.prompt, execution, clientInfo);
      await this.authorizeImageRequest(request, execution);
      
      const apiRequest = await this.createEditApiRequest(request, user, clientInfo);
      await this.requestTracker.startProcessing(apiRequest.id);

      const result = await this.executeEditRequest(request, execution);
      await this.finalizeImageRequest(apiRequest, request, result, execution);

      this.logEditSuccess(execution, result);
      return this.enhanceResponse(result, execution);

    } catch (error) {
      this.logEditError(execution, request, error as Error);
      throw error;
    }
  }

  private createGenerationExecution(
    request: ImageGenerationRequest, 
    user: AuthenticatedUser
  ): ImageExecution {
    return {
      requestId: this.generateRequestId('img'),
      startTime: Date.now(),
      user,
      model: request.model,
      endpoint: '/v1/images/generations',
      imageCount: request.n || 1
    };
  }

  private createEditExecution(request: ImageEditRequest, user: AuthenticatedUser): ImageExecution {
    return {
      requestId: this.generateRequestId('img'),
      startTime: Date.now(),
      user,
      model: request.model,
      endpoint: '/v1/images/edits',
      imageCount: request.n || 1
    };
  }

  private async executeGenerationRequest(
    request: ImageGenerationRequest,
    execution: ImageExecution
  ): Promise<ImageResponse> {
    const excludedProviders: string[] = [];
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= ImagesService.MAX_RETRIES; attempt++) {
      try {
        const selection = await this.selectProvider(request.model, excludedProviders);
        
        if (!selection) {
          if (attempt < ImagesService.MAX_RETRIES) continue;
          throw new Error('No available providers for this request');
        }

        const result = await this.performGenerationRequest(request, selection, execution);
        await this.recordProviderSuccess(selection, execution);

        execution.providerId = selection.provider.id;
        execution.subProviderId = selection.subProvider?.id;
        
        return result;

      } catch (error) {
        lastError = error as Error;
        this.handleProviderAttemptFailure(error as Error, execution, attempt, excludedProviders);
        if (attempt >= ImagesService.MAX_RETRIES) break;
      }
    }

    throw lastError || new Error('All image provider attempts exhausted');
  }

  private async executeEditRequest(
    request: ImageEditRequest,
    execution: ImageExecution
  ): Promise<ImageResponse> {
    const excludedProviders: string[] = [];
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= ImagesService.MAX_RETRIES; attempt++) {
      try {
        const selection = await this.selectProvider(request.model, excludedProviders);
        
        if (!selection) {
          if (attempt < ImagesService.MAX_RETRIES) continue;
          throw new Error('No available providers for this request');
        }

        const result = await this.performEditRequest(request, selection, execution);
        await this.recordProviderSuccess(selection, execution);

        execution.providerId = selection.provider.id;
        execution.subProviderId = selection.subProvider?.id;
        
        return result;

      } catch (error) {
        lastError = error as Error;
        this.handleProviderAttemptFailure(error as Error, execution, attempt, excludedProviders);
        if (attempt >= ImagesService.MAX_RETRIES) break;
      }
    }

    throw lastError || new Error('All image edit provider attempts exhausted');
  }

  private async selectProvider(
    model: string,
    excludedProviders: string[]
  ): Promise<ProviderSelection | null> {
    const modelCost = this.modelRegistry.getBaseCost(model);
    const selection = await this.loadBalancer.select({
      model,
      estimatedTokens: modelCost,
      excludeIds: excludedProviders,
      requireHealthy: false,
      capability: 'images'
    });

    if (!selection) return null;

    const provider = await this.createProviderAdapter(selection);
    if (!provider || !provider.supportsCapability('images')) {
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

  private async performGenerationRequest(
    request: ImageGenerationRequest,
    selection: ProviderSelection,
    execution: ImageExecution
  ): Promise<ImageResponse> {
    const provider = await this.createProviderAdapter(selection);
    if (!provider) {
      throw new Error('Failed to create provider adapter');
    }

    const modelCost = this.modelRegistry.getBaseCost(request.model);
    await this.loadBalancer.recordRequestStart(selection.subProvider?.id, modelCost);

    try {
      return await provider.generateImages(request);
    } catch (error) {
      await this.handleProviderError(error as Error, selection, execution);
      throw error;
    }
  }

  private async performEditRequest(
    request: ImageEditRequest,
    selection: ProviderSelection,
    execution: ImageExecution
  ): Promise<ImageResponse> {
    const provider = await this.createProviderAdapter(selection);
    if (!provider) {
      throw new Error('Failed to create provider adapter');
    }

    const modelCost = this.modelRegistry.getBaseCost(request.model);
    await this.loadBalancer.recordRequestStart(selection.subProvider?.id, modelCost);

    try {
      return await provider.editImages(request);
    } catch (error) {
      await this.handleProviderError(error as Error, selection, execution);
      throw error;
    }
  }

  private async handleProviderError(
    error: Error,
    selection: ProviderSelection,
    execution: ImageExecution
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
      this.logger.warn('Critical error detected in image provider', {
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
    execution: ImageExecution
  ): Promise<void> {
    const modelCost = this.modelRegistry.getBaseCost(execution.model);
    await this.loadBalancer.recordRequestComplete(
      selection.provider.id,
      true,
      Date.now() - execution.startTime,
      modelCost,
      undefined,
      selection.subProvider?.id
    );
  }

  private async performContentCheck(
    prompt: string,
    execution: ImageExecution,
    clientInfo: ClientInfo
  ): Promise<void> {
    const analysis = await this.security.analyzeImageContent(
      prompt,
      execution.user.isAnonymous ? undefined : execution.user.id
    );

    if (analysis.isBlocked) {
      this.logger.warn('Image prompt blocked by security', {
        requestId: execution.requestId,
        metadata: {
          userId: execution.user.id,
          riskLevel: analysis.riskLevel,
          confidence: analysis.confidence,
          detectedCategories: analysis.detectedCategories,
          origin: clientInfo.origin,
          isImageModeration: true
        }
      });
      throw new Error('Image prompt violates content policy');
    }
  }

  private async authorizeImageRequest(request: any, execution: ImageExecution): Promise<void> {
    if (execution.user.isMasterAdmin || execution.user.isAnonymous) return;

    const credits = this.modelRegistry.getBaseCost(request.model);
    const totalCredits = credits * execution.imageCount;

    if (!execution.user.credits || execution.user.credits < totalCredits) {
      throw new Error('Insufficient credits for image generation');
    }
  }

  private async finalizeImageRequest(
    apiRequest: any,
    request: any,
    result: ImageResponse,
    execution: ImageExecution
  ): Promise<void> {
    const credits = this.modelRegistry.getBaseCost(request.model);
    const totalCredits = credits * result.data.length;
    const duration = Date.now() - execution.startTime;

    if (!execution.user.isMasterAdmin && !execution.user.isAnonymous) {
      await this.billing.deductCredits(
        execution.user.id,
        totalCredits,
        'Image generation',
        execution.endpoint
      );
    }

    await this.requestTracker.completeRequest(
      apiRequest.id,
      totalCredits,
      totalCredits,
      duration,
      JSON.stringify(result).length,
      200,
      execution.providerId,
      execution.subProviderId
    );
  }

  private async validateGenerationRequest(request: ImageGenerationRequest, user: AuthenticatedUser): Promise<void> {
    if (!request.model?.trim()) {
      throw new Error('Model required');
    }

    if (!this.modelRegistry.exists(request.model)) {
      throw new Error(`Model '${request.model}' does not exist`);
    }

    if (!this.modelRegistry.supportsEndpoint(request.model, '/v1/images/generations')) {
      throw new Error(`Model '${request.model}' does not support image generation`);
    }

    if (!user.isMasterAdmin && !this.modelRegistry.hasAccess(request.model, user.plan)) {
      // Check if user has an active, non-expired discount for this model
      const discount = await this.discountService.getUserDiscount(user.id, request.model);
      if (!discount || discount <= 1) {
        throw new Error(`Your plan does not have access to model '${request.model}'. You can only use models available in your plan or models you have an active discount for.`);
      }
    }

    this.validatePrompt(request.prompt);
    this.validateImageCount(request.n);
  }

  private async validateEditRequest(request: ImageEditRequest, user: AuthenticatedUser): Promise<void> {
    if (!request.model?.trim()) {
      throw new Error('Model required');
    }

    if (!this.modelRegistry.exists(request.model)) {
      throw new Error(`Model '${request.model}' does not exist`);
    }

    if (!this.modelRegistry.supportsEndpoint(request.model, '/v1/images/edits')) {
      throw new Error(`Model '${request.model}' does not support image editing`);
    }

    if (!user.isMasterAdmin && !this.modelRegistry.hasAccess(request.model, user.plan)) {
      // Check if user has an active, non-expired discount for this model
      const discount = await this.discountService.getUserDiscount(user.id, request.model);
      if (!discount || discount <= 1) {
        throw new Error(`Your plan does not have access to model '${request.model}'. You can only use models available in your plan or models you have an active discount for.`);
      }
    }

    if (!request.image) {
      throw new Error('Image file is required for editing');
    }

    this.validatePrompt(request.prompt);
    this.validateImageCount(request.n);
  }

  private validatePrompt(prompt?: string): void {
    if (!prompt?.trim()) {
      throw new Error('Prompt is required');
    }

    if (prompt.length > ImagesService.MAX_PROMPT_LENGTH) {
      throw new Error(`Prompt too long (max ${ImagesService.MAX_PROMPT_LENGTH} characters)`);
    }
  }

  private validateImageCount(count?: number): void {
    if (count && (count < ImagesService.MIN_IMAGES || count > ImagesService.MAX_IMAGES)) {
      throw new Error(
        `Number of images must be between ${ImagesService.MIN_IMAGES} and ${ImagesService.MAX_IMAGES}`
      );
    }
  }

  private async createGenerationApiRequest(
    request: ImageGenerationRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ) {
    return this.requestTracker.createRequest({
      userId: user.isMasterAdmin || user.isAnonymous ? undefined : user.id,
      endpoint: '/v1/images/generations',
      method: 'POST',
      model: request.model,
      ipAddress: clientInfo.ip,
      userAgent: clientInfo.userAgent,
      requestSize: JSON.stringify(request).length
    });
  }

  private async createEditApiRequest(
    request: ImageEditRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ) {
    return this.requestTracker.createRequest({
      userId: user.isMasterAdmin || user.isAnonymous ? undefined : user.id,
      endpoint: '/v1/images/edits',
      method: 'POST',
      model: request.model,
      ipAddress: clientInfo.ip,
      userAgent: clientInfo.userAgent,
      requestSize: this.calculateEditRequestSize(request)
    });
  }

  private calculateEditRequestSize(request: ImageEditRequest): number {
    let size = JSON.stringify({ ...request, image: null, mask: null }).length;
    size += request.image.size;
    if (request.mask) size += request.mask.size;
    return size;
  }

  private generateRequestId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private enhanceResponse(response: ImageResponse, execution: ImageExecution): ImageResponse {
    return {
      ...response,
      id: execution.requestId,
      provider: execution.providerId || 'image_provider'
    };
  }

  private logGenerationInitiation(execution: ImageExecution, request: ImageGenerationRequest): void {
    this.logger.info('Image generation request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        imageCount: execution.imageCount,
        promptLength: request.prompt.length
      }
    });
  }

  private logEditInitiation(execution: ImageExecution, request: ImageEditRequest): void {
    this.logger.info('Image edit request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        imageCount: execution.imageCount,
        promptLength: request.prompt.length,
        hasImage: !!request.image,
        hasMask: !!request.mask
      }
    });
  }

  private logGenerationSuccess(execution: ImageExecution, result: ImageResponse): void {
    this.logger.info('Image generation completed', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: execution.model,
        imagesGenerated: result.data.length,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logEditSuccess(execution: ImageExecution, result: ImageResponse): void {
    this.logger.info('Image editing completed', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: execution.model,
        imagesEdited: result.data.length,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logGenerationError(
    execution: ImageExecution,
    request: ImageGenerationRequest,
    error: Error
  ): void {
    this.logger.error('Image generation failed', error, {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        prompt: request.prompt.substring(0, ImagesService.PROMPT_PREVIEW_LENGTH),
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logEditError(execution: ImageExecution, request: ImageEditRequest, error: Error): void {
    this.logger.error('Image editing failed', error, {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private handleProviderAttemptFailure(
    error: Error,
    execution: ImageExecution,
    attempt: number,
    excludedProviders: string[]
  ): void {
    excludedProviders.push(execution.providerId || 'failed_provider');
    
    this.logger.warn('Image provider attempt failed', {
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