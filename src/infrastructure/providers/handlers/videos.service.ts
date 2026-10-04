import { ProviderRegistry } from '../services';
import { VideoJobRepository } from '../../repositories';
import type { BaseProviderAdapter } from '../base';
import { ModelRegistryService, LoadBalancerService } from '../../../domain/provider';
import { ApiRequestService } from '../../../domain/request';
import { CreditService, SecurityService } from '../../../domain/user';
import { DiscountService } from '../../../domain/discount';
import { isCriticalError, getErrorType } from '../../../domain/shared';
import type { 
  VideoCreateRequest,
  VideoRemixRequest,
  VideoResponse,
  VideoListResponse,
  VideoVariant,
  AuthenticatedUser 
} from '../types';
import type { ILogger } from '../../../core/logging';
import type { ICryptoService } from '../../../core/security';

interface VideoExecution {
  readonly requestId: string;
  readonly startTime: number;
  readonly user: AuthenticatedUser;
  readonly model: string;
  readonly endpoint: string;
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

export class VideosService {
  private static readonly MAX_RETRIES = 5;
  private static readonly MAX_PROMPT_LENGTH = 4000;
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
    private readonly cryptoService: ICryptoService,
    private readonly videoJobs: VideoJobRepository
  ) {}

  async createVideo(
    request: VideoCreateRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<VideoResponse> {
    const execution = this.createVideoExecution(request, user);
    
    this.logVideoInitiation(execution, request);

    try {
      await this.validateVideoRequest(request, user);
      await this.performContentCheck(request.prompt, execution, clientInfo);
      await this.authorizeVideoRequest(request, execution);
      
      const apiRequest = await this.createVideoApiRequest(request, user, clientInfo);
      await this.requestTracker.startProcessing(apiRequest.id);

      const result = await this.executeVideoRequest(request, execution);
      await this.finalizeVideoRequest(apiRequest, request, result, execution);

      this.logVideoSuccess(execution, result);
      return this.enhanceResponse(result, execution);

    } catch (error) {
      this.logVideoError(execution, request, error as Error);
      throw error;
    }
  }

  async getVideoStatus(
    videoId: string,
    user: AuthenticatedUser
  ): Promise<VideoResponse> {
    const execution = this.createStatusExecution(videoId, user);
    
    try {
      // Try stored provider mapping first
      const mapped = await this.videoJobs.findById(videoId);
      if (mapped?.provider_name) {
        const provider = this.providerRegistry.getAdapter(mapped.provider_name);
        if (provider) {
          let result = await provider.getVideoStatus(videoId);

          // If provider status appears stuck but content is retrievable, consider it completed
          if ((result.status === 'queued' || result.status === 'in_progress')) {
            const ready = await this.isContentReadyWithProvider(provider, videoId);
            if (ready) {
              result = { ...result, status: 'completed', progress: 100 } as VideoResponse;
            }
          }
          return this.enhanceResponse(result, execution);
        }
      }

      // Fallback to load balancer
      const primarySelection = await this.selectProvider('sora-2', []);
      if (primarySelection) {
        const primaryProvider = await this.createProviderAdapter(primarySelection);
        if (primaryProvider) {
          let result = await primaryProvider.getVideoStatus(videoId);
          if ((result.status === 'queued' || result.status === 'in_progress')) {
            const ready = await this.isContentReadyWithProvider(primaryProvider, videoId);
            if (ready) {
              result = { ...result, status: 'completed', progress: 100 } as VideoResponse;
            }
          }
          return this.enhanceResponse(result, execution);
        }
      }

      // Fallback across adapters
      const adapters = await this.getAllVideoAdaptersForModel('sora-2');
      let result = await this.tryProvidersSequentially(adapters, (p) => p.getVideoStatus(videoId));
      if ((result.status === 'queued' || result.status === 'in_progress')) {
        for (const p of adapters) {
          const ready = await this.isContentReadyWithProvider(p, videoId);
          if (ready) {
            result = { ...result, status: 'completed', progress: 100 } as VideoResponse;
            break;
          }
        }
      }
      return this.enhanceResponse(result, execution);

    } catch (error) {
      this.logger.error('Video status check failed', error as Error, {
        requestId: execution.requestId,
        metadata: { videoId, userId: user.id }
      });
      throw error;
    }
  }

  async downloadVideo(
    videoId: string,
    variant: VideoVariant,
    user: AuthenticatedUser
  ): Promise<ArrayBuffer> {
    const execution = this.createDownloadExecution(videoId, user);
    
    try {
      // Primary attempt via selected provider
      const primarySelection = await this.selectProvider('sora-2', []);
      if (primarySelection) {
        const primaryProvider = await this.createProviderAdapter(primarySelection);
        if (primaryProvider) {
          try {
            return await primaryProvider.downloadVideo(videoId, variant);
          } catch {}
        }
      }

      // Fallback across all adapters
      const adapters = await this.getAllVideoAdaptersForModel('sora-2');
      return await this.tryProvidersSequentially(adapters, (p) => p.downloadVideo(videoId, variant));

    } catch (error) {
      this.logger.error('Video download failed', error as Error, {
        requestId: execution.requestId,
        metadata: { videoId, variant, userId: user.id }
      });
      throw error;
    }
  }

  async listVideos(
    params: { limit?: number; after?: string; order?: 'asc' | 'desc' },
    user: AuthenticatedUser
  ): Promise<VideoListResponse> {
    const execution = this.createListExecution(user);
    
    try {
      const selection = await this.selectProvider('sora-2', []);
      if (!selection) {
        throw new Error('No available providers for video listing');
      }

      const provider = await this.createProviderAdapter(selection);
      if (!provider) {
        throw new Error('Failed to create provider adapter');
      }

      return await provider.listVideos(params);

    } catch (error) {
      this.logger.error('Video listing failed', error as Error, {
        requestId: execution.requestId,
        metadata: { userId: user.id, params }
      });
      throw error;
    }
  }

  async deleteVideo(
    videoId: string,
    user: AuthenticatedUser
  ): Promise<void> {
    const execution = this.createDeleteExecution(videoId, user);
    
    try {
      // Auto-deletion disabled: no cancellation needed

      // Prefer stored provider mapping
      const mapped = await this.videoJobs.findById(videoId);
      let deleted = false;
      if (mapped?.provider_name) {
        const provider = this.providerRegistry.getAdapter(mapped.provider_name);
        if (provider) {
          await provider.deleteVideo(videoId);
          deleted = true;
        }
      }

      // Primary attempt via selected provider if not deleted yet
      if (!deleted) {
        const primarySelection = await this.selectProvider('sora-2', []);
        if (primarySelection) {
          const primaryProvider = await this.createProviderAdapter(primarySelection);
          if (primaryProvider) {
            await primaryProvider.deleteVideo(videoId);
            deleted = true;
          }
        }
      }

      if (!deleted) {
        // Fallback across all adapters
        const adapters = await this.getAllVideoAdaptersForModel('sora-2');
        await this.tryProvidersSequentially(adapters, (p) => p.deleteVideo(videoId));
      }
      
      this.logger.info('Video deleted successfully', {
        requestId: execution.requestId,
        metadata: { videoId, userId: user.id }
      });

    } catch (error) {
      this.logger.error('Video deletion failed', error as Error, {
        requestId: execution.requestId,
        metadata: { videoId, userId: user.id }
      });
      throw error;
    }
  }

  async remixVideo(
    videoId: string,
    request: VideoRemixRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<VideoResponse> {
    const execution = this.createRemixExecution(videoId, user);
    
    this.logRemixInitiation(execution, request);

    try {
      this.validateRemixRequest(request);
      await this.performContentCheck(request.prompt, execution, clientInfo);
      
      // Prefer stored provider mapping
      const mapped = await this.videoJobs.findById(videoId);
      let result: VideoResponse | null = null;
      if (mapped?.provider_name) {
        const provider = this.providerRegistry.getAdapter(mapped.provider_name);
        if (provider) {
          result = await provider.remixVideo(videoId, request);
        }
      }

      // Primary attempt via selected provider
      if (!result) {
        const primarySelection = await this.selectProvider('sora-2', []);
        if (primarySelection) {
          const primaryProvider = await this.createProviderAdapter(primarySelection);
          if (primaryProvider) {
            result = await primaryProvider.remixVideo(videoId, request);
          }
        }
      }

      if (!result) {
        // Fallback across all adapters
        const adapters = await this.getAllVideoAdaptersForModel('sora-2');
        result = await this.tryProvidersSequentially(adapters, (p) => p.remixVideo(videoId, request));
      }
      
      // Automatic deletion disabled for remixed videos

      this.logRemixSuccess(execution, result);
      return this.enhanceResponse(result, execution);

    } catch (error) {
      this.logRemixError(execution, request, error as Error);
      throw error;
    }
  }

  // Auto-deletion disabled

  private createVideoExecution(request: VideoCreateRequest, user: AuthenticatedUser): VideoExecution {
    return {
      requestId: this.generateRequestId('vid'),
      startTime: Date.now(),
      user,
      model: request.model,
      endpoint: '/v1/videos'
    };
  }

  private createStatusExecution(videoId: string, user: AuthenticatedUser): VideoExecution {
    return {
      requestId: this.generateRequestId('vid'),
      startTime: Date.now(),
      user,
      model: 'sora-2',
      endpoint: `/v1/videos/${videoId}`
    };
  }

  private createDownloadExecution(videoId: string, user: AuthenticatedUser): VideoExecution {
    return {
      requestId: this.generateRequestId('vid'),
      startTime: Date.now(),
      user,
      model: 'sora-2',
      endpoint: `/v1/videos/${videoId}/content`
    };
  }

  private createListExecution(user: AuthenticatedUser): VideoExecution {
    return {
      requestId: this.generateRequestId('vid'),
      startTime: Date.now(),
      user,
      model: 'sora-2',
      endpoint: '/v1/videos'
    };
  }

  private createDeleteExecution(videoId: string, user: AuthenticatedUser): VideoExecution {
    return {
      requestId: this.generateRequestId('vid'),
      startTime: Date.now(),
      user,
      model: 'sora-2',
      endpoint: `/v1/videos/${videoId}`
    };
  }

  private createRemixExecution(videoId: string, user: AuthenticatedUser): VideoExecution {
    return {
      requestId: this.generateRequestId('vid'),
      startTime: Date.now(),
      user,
      model: 'sora-2',
      endpoint: `/v1/videos/${videoId}/remix`
    };
  }

  private async executeVideoRequest(
    request: VideoCreateRequest,
    execution: VideoExecution
  ): Promise<VideoResponse> {
    const excludedProviders: string[] = [];
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= VideosService.MAX_RETRIES; attempt++) {
      try {
        const selection = await this.selectProvider(request.model, excludedProviders);
        
        if (!selection) {
          if (attempt < VideosService.MAX_RETRIES) continue;
          throw new Error('No available providers for this request');
        }

        // Capture provider identifiers before performing the request so failures can be excluded correctly
        execution.providerId = selection.provider.id;
        execution.subProviderId = selection.subProvider?.id;

        const result = await this.performVideoRequest(request, selection, execution);
        await this.recordProviderSuccess(selection, execution);

        return result;

      } catch (error) {
        lastError = error as Error;
        this.handleProviderAttemptFailure(error as Error, execution, attempt, excludedProviders);
        if (attempt >= VideosService.MAX_RETRIES) break;
      }
    }

    throw lastError || new Error('All video provider attempts exhausted');
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
      capability: 'videos'
    });

    if (!selection) return null;

    const provider = await this.createProviderAdapter(selection);
    if (!provider || !provider.supportsCapability('videos')) {
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

  private async performVideoRequest(
    request: VideoCreateRequest,
    selection: ProviderSelection,
    execution: VideoExecution
  ): Promise<VideoResponse> {
    const provider = await this.createProviderAdapter(selection);
    if (!provider) {
      throw new Error('Failed to create provider adapter');
    }

    const modelCost = this.modelRegistry.getBaseCost(request.model);
    await this.loadBalancer.recordRequestStart(selection.subProvider?.id, modelCost);

    try {
      const result = await provider.createVideo(request);
      // Persist job mapping (video id -> provider)
      try {
        await this.videoJobs.upsert({
          id: result.id,
          created_at: Date.now(),
          updated_at: Date.now(),
          user_id: execution.user.isMasterAdmin || execution.user.isAnonymous ? undefined : execution.user.id,
          model: request.model,
          provider_name: selection.provider.name,
          sub_provider_id: selection.subProvider?.id,
          status: result.status,
          seconds: request.seconds,
          size: request.size
        });
      } catch (e) {
        this.logger.warn('Failed to persist video job mapping', { metadata: { error: (e as Error).message, videoId: (result as any)?.id } } as any);
      }
      return result;
    } catch (error) {
      await this.handleProviderError(error as Error, selection, execution);
      throw error;
    }
  }

  private async handleProviderError(
    error: Error,
    selection: ProviderSelection,
    execution: VideoExecution
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
      this.logger.warn('Critical error detected in video provider', {
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
    execution: VideoExecution
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
    execution: VideoExecution,
    clientInfo: ClientInfo
  ): Promise<void> {
    const analysis = await this.security.analyzeImageContent(
      prompt,
      execution.user.isAnonymous ? undefined : execution.user.id
    );

    if (analysis.isBlocked) {
      this.logger.warn('Video prompt blocked by security', {
        requestId: execution.requestId,
        metadata: {
          userId: execution.user.id,
          riskLevel: analysis.riskLevel,
          confidence: analysis.confidence,
          detectedCategories: analysis.detectedCategories,
          origin: clientInfo.origin,
          isVideoModeration: true
        }
      });
      throw new Error('Video prompt violates content policy');
    }
  }

  private async authorizeVideoRequest(request: VideoCreateRequest, execution: VideoExecution): Promise<void> {
    if (execution.user.isMasterAdmin || execution.user.isAnonymous) return;

    const credits = this.modelRegistry.getBaseCost(request.model);

    if (!execution.user.credits || execution.user.credits < credits) {
      throw new Error('Insufficient credits for video generation');
    }
  }

  private async finalizeVideoRequest(
    apiRequest: any,
    request: VideoCreateRequest,
    result: VideoResponse,
    execution: VideoExecution
  ): Promise<void> {
    const credits = this.modelRegistry.getBaseCost(request.model);
    const duration = Date.now() - execution.startTime;

    if (!execution.user.isMasterAdmin && !execution.user.isAnonymous) {
      await this.billing.deductCredits(
        execution.user.id,
        credits,
        'Video generation',
        execution.endpoint
      );
    }

    await this.requestTracker.completeRequest(
      apiRequest.id,
      credits,
      credits,
      duration,
      JSON.stringify(result).length,
      200,
      execution.providerId,
      execution.subProviderId
    );
  }

  private async validateVideoRequest(request: VideoCreateRequest, user: AuthenticatedUser): Promise<void> {
    if (!request.model?.trim()) {
      throw new Error('Model required');
    }

    if (!this.modelRegistry.exists(request.model)) {
      throw new Error(`Model '${request.model}' does not exist`);
    }

    if (!this.modelRegistry.supportsEndpoint(request.model, '/v1/videos')) {
      throw new Error(`Model '${request.model}' does not support video generation`);
    }

    if (!user.isMasterAdmin && !this.modelRegistry.hasAccess(request.model, user.plan)) {
      // Check if user has an active, non-expired discount for this model
      const discount = await this.discountService.getUserDiscount(user.id, request.model);
      if (!discount || discount <= 1) {
        throw new Error(`Your plan does not have access to model '${request.model}'. You can only use models available in your plan or models you have an active discount for.`);
      }
    }

    this.validatePrompt(request.prompt);
  }

  private validateRemixRequest(request: VideoRemixRequest): void {
    this.validatePrompt(request.prompt);
  }

  private validatePrompt(prompt?: string): void {
    if (!prompt?.trim()) {
      throw new Error('Prompt is required');
    }

    if (prompt.length > VideosService.MAX_PROMPT_LENGTH) {
      throw new Error(`Prompt too long (max ${VideosService.MAX_PROMPT_LENGTH} characters)`);
    }
  }

  private async createVideoApiRequest(
    request: VideoCreateRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ) {
    return this.requestTracker.createRequest({
      userId: user.isMasterAdmin || user.isAnonymous ? undefined : user.id,
      endpoint: '/v1/videos',
      method: 'POST',
      model: request.model,
      ipAddress: clientInfo.ip,
      userAgent: clientInfo.userAgent,
      requestSize: JSON.stringify(request).length
    });
  }

  private generateRequestId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private enhanceResponse(response: VideoResponse, execution: VideoExecution): VideoResponse {
    return {
      ...response,
      provider: execution.providerId || 'video_provider'
    };
  }

  private logVideoInitiation(execution: VideoExecution, request: VideoCreateRequest): void {
    this.logger.info('Video generation request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        promptLength: request.prompt.length,
        size: request.size,
        seconds: request.seconds
      }
    });
  }

  private logVideoSuccess(execution: VideoExecution, result: VideoResponse): void {
    this.logger.info('Video generation completed', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: execution.model,
        videoId: result.id,
        status: result.status,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logVideoError(
    execution: VideoExecution,
    request: VideoCreateRequest,
    error: Error
  ): void {
    this.logger.error('Video generation failed', error, {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        prompt: request.prompt.substring(0, VideosService.PROMPT_PREVIEW_LENGTH),
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logRemixInitiation(execution: VideoExecution, request: VideoRemixRequest): void {
    this.logger.info('Video remix request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        promptLength: request.prompt.length
      }
    });
  }

  private logRemixSuccess(execution: VideoExecution, result: VideoResponse): void {
    this.logger.info('Video remix completed', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        videoId: result.id,
        status: result.status,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logRemixError(
    execution: VideoExecution,
    request: VideoRemixRequest,
    error: Error
  ): void {
    this.logger.error('Video remix failed', error, {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        prompt: request.prompt.substring(0, VideosService.PROMPT_PREVIEW_LENGTH),
        duration: Date.now() - execution.startTime
      }
    });
  }

  private handleProviderAttemptFailure(
    error: Error,
    execution: VideoExecution,
    attempt: number,
    excludedProviders: string[]
  ): void {
    if (execution.providerId) {
      excludedProviders.push(execution.providerId);
    }
    
    this.logger.warn('Video provider attempt failed', {
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

  private async getAllVideoAdaptersForModel(model: string): Promise<BaseProviderAdapter[]> {
    const adapters = this.providerRegistry.getAdaptersForModel(model) || [];
    return adapters.filter(a => a.supportsCapability('videos'));
  }

  private async tryProvidersSequentially<T>(
    adapters: BaseProviderAdapter[],
    fn: (provider: BaseProviderAdapter) => Promise<T>
  ): Promise<T> {
    let lastError: Error | null = null;
    for (const adapter of adapters) {
      try {
        return await fn(adapter);
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw lastError || new Error('All providers failed');
  }

  private async isContentReadyWithProvider(provider: BaseProviderAdapter, videoId: string): Promise<boolean> {
    try {
      // Use thumbnail or video to check readiness
      await provider.downloadVideo(videoId, 'thumbnail');
      return true;
    } catch {
      try {
        await provider.downloadVideo(videoId, 'video');
        return true;
      } catch {
        return false;
      }
    }
  }
}