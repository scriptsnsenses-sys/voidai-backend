import { ProviderRegistry } from '../services';
import { LoadBalancerService, ModelRegistryService } from '../../../domain/provider';
import { ApiRequestService } from '../../../domain/request';
import { CreditService, SecurityService, AuthService } from '../../../domain/user';
import { DiscountService } from '../../../domain/discount';
import { isCriticalError, getErrorType } from '../../../domain/shared';
import type { 
  ChatCompletionRequest, 
  ChatCompletionResponse, 
  StreamChunk, 
  AuthenticatedUser 
} from '../types';
import type { ILogger } from '../../../core/logging';
import type { ICryptoService } from '../../../core/security';

interface RequestExecution {
  readonly requestId: string;
  readonly startTime: number;
  readonly user: AuthenticatedUser;
  readonly model: string;
  readonly estimatedTokens: number;
  readonly isStreaming: boolean;
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
  readonly origin: string;
}

export class ChatService {
  private static readonly MAX_RETRIES = 10;
  static readonly TOKEN_RATIO = 4;
  private static readonly IMAGE_TOKENS = 765;

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly loadBalancer: LoadBalancerService,
    private readonly requestTracker: ApiRequestService,
    private readonly billing: CreditService,
    private readonly security: SecurityService,
    private readonly authorization: AuthService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly discountService: DiscountService,
    private readonly logger: ILogger,
    private readonly cryptoService: ICryptoService
  ) {}

  async chatCompletion(
    request: ChatCompletionRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<ChatCompletionResponse | AsyncIterable<StreamChunk>> {
    const execution = this.createExecution(request, user);
    
    this.logRequestInitiation(execution, request);

    try {
      await this.validateAndAuthorize(request, execution, clientInfo);
      const apiRequest = await this.createApiRequest(request, user, clientInfo);
      await this.requestTracker.startProcessing(apiRequest.id);

      return execution.isStreaming 
        ? this.handleStreamingExecution(request, execution, apiRequest)
        : this.handleSynchronousExecution(request, execution, apiRequest);
    } catch (error) {
      this.logRequestFailure(error as Error, execution);
      throw error;
    }
  }

  private createExecution(request: ChatCompletionRequest, user: AuthenticatedUser): RequestExecution {
    return {
      requestId: this.generateRequestId(),
      startTime: Date.now(),
      user,
      model: request.model,
      estimatedTokens: this.calculateTokenEstimate(request),
      isStreaming: Boolean(request.stream)
    };
  }

  private async validateAndAuthorize(
    request: ChatCompletionRequest,
    execution: RequestExecution,
    clientInfo: ClientInfo
  ): Promise<void> {
    await this.validateRequestFormat(request, execution.user);

    await this.performSecurityAnalysis(request, execution, clientInfo);
    
    if (!execution.user.isMasterAdmin && !execution.user.isAnonymous) {
      await this.authorizeRequest(execution, clientInfo);
    }
  }

  private async performSecurityAnalysis(
    request: ChatCompletionRequest,
    execution: RequestExecution,
    clientInfo: ClientInfo
  ): Promise<void> {
    const content = this.extractContentText(request.messages);
    const analysis = await this.security.analyzeContent(
      content,
      execution.user.isAnonymous ? '' : execution.user.id,
      execution.user.plan,
      clientInfo.origin,
      execution.model
    );

    if (analysis.isBlocked) {
      this.logger.warn('Request blocked by security analysis', {
        requestId: execution.requestId,
        metadata: {
          userId: execution.user.id,
          riskLevel: analysis.riskLevel,
          confidence: analysis.confidence,
          detectedCategories: analysis.detectedCategories,
          origin: clientInfo.origin
        }
      });
      throw new Error('Request violates content policy');
    }
  }

  private async authorizeRequest(
    execution: RequestExecution,
    clientInfo: ClientInfo
  ): Promise<void> {
    const requiredCredits = this.modelRegistry.calculateCredits(
      execution.model, 
      execution.estimatedTokens
    );
    
    const authContext = {
      userId: execution.user.id,
      ipAddress: clientInfo.ip,
      endpoint: '/v1/chat/completions',
      model: execution.model,
      estimatedCredits: requiredCredits
    };

    const authResult = await this.authorization.authorizeRequest(authContext);
    if (!authResult.isAuthorized) {
      throw new Error(authResult.reason || 'Authorization failed');
    }
  }

  private async handleSynchronousExecution(
    request: ChatCompletionRequest,
    execution: RequestExecution,
    apiRequest: any
  ): Promise<ChatCompletionResponse> {
    const excludedProviders: string[] = [];
    let lastError: Error | null = null;
    let providerExecution: ProviderExecution | null = null;

    for (let attempt = 1; attempt <= ChatService.MAX_RETRIES; attempt++) {
      try {
        providerExecution = await this.acquireProvider(
          request.model, 
          execution.estimatedTokens, 
          excludedProviders
        );
        
        if (!providerExecution) {
          if (attempt < ChatService.MAX_RETRIES) continue;
          throw new Error('No available providers for this request');
        }

        const response = await this.executeProviderRequest(request, providerExecution);
        await this.completeSynchronousRequest(apiRequest, response, execution, providerExecution);
        return this.enhanceResponse(response, execution, providerExecution);

      } catch (error) {
        lastError = error as Error;
        this.handleProviderAttemptFailure(
          error as Error,
          execution,
          providerExecution,
          attempt,
          excludedProviders
        );
        if (attempt >= ChatService.MAX_RETRIES) break;
      }
    }

    throw lastError || new Error('All provider attempts exhausted');
  }

  private async executeProviderRequest(
    request: ChatCompletionRequest,
    providerExecution: ProviderExecution
  ): Promise<ChatCompletionResponse> {
    try {
      const response = await providerExecution.provider.chatCompletion(request);
      
      if (Symbol.asyncIterator in response) {
        throw new Error('Unexpected streaming response in sync mode');
      }

      return response as ChatCompletionResponse;
    } catch (error) {
      await this.handleProviderError(error as Error, providerExecution);
      throw error;
    }
  }

  private async handleProviderError(error: Error, providerExecution: ProviderExecution): Promise<void> {
    const errorType = getErrorType(error.message);
    const isCritical = isCriticalError(error.message);

    // Attach provider_id for user-facing error responses (avoid exposing provider name)
    try {
      const anyErr: any = error as any;
      if (!anyErr.provider_id) {
        anyErr.provider_id = providerExecution.providerId;
      }
      // Remove any accidental provider name that adapters may have attached
      if (anyErr.provider) {
        delete anyErr.provider;
      }
    } catch {}

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
      this.logger.warn('Critical error detected', {
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

  private handleStreamingExecution(
    request: ChatCompletionRequest,
    execution: RequestExecution,
    apiRequest: any
  ): StreamProcessor {
    return new StreamProcessor(
      request,
      execution,
      apiRequest,
      this.providerRegistry,
      this.loadBalancer,
      this.requestTracker,
      this.billing,
      this.modelRegistry,
      this.logger,
      this.cryptoService
    );
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

    if (!provider) return null;

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

  private calculateReasoningTokens(response: ChatCompletionResponse): number {
    if (response.usage?.completion_tokens_details?.reasoning_tokens) {
      return response.usage.completion_tokens_details.reasoning_tokens;
    }

    if (!response.choices || !Array.isArray(response.choices)) {
      return 0;
    }

    return response.choices.reduce<number>((total: number, choice: any) => {
      const reasoningContent = choice.message?.reasoning_content;
      if (!reasoningContent || !Array.isArray(reasoningContent)) {
        return total;
      }

      return total + reasoningContent.reduce<number>((sum: number, reasoning: any) => {
        if (reasoning.type === 'thinking' && reasoning.thinking) {
          return sum + Math.ceil(reasoning.thinking.length / ChatService.TOKEN_RATIO);
        }
        return sum;
      }, 0);
    }, 0);
  }

  private async completeSynchronousRequest(
    apiRequest: any,
    response: ChatCompletionResponse,
    execution: RequestExecution,
    providerExecution: ProviderExecution
  ): Promise<void> {
    const outputTokens = this.calculateResponseTokens(response);
    const reasoningTokens = this.calculateReasoningTokens(response);
    const totalTokens = execution.estimatedTokens + outputTokens + reasoningTokens;
    const credits = this.modelRegistry.calculateCredits(execution.model, totalTokens);
    
    const duration = Date.now() - execution.startTime;

    if (!execution.user.isMasterAdmin && !execution.user.isAnonymous) {
      await this.billing.deductCredits(
        execution.user.id,
        credits,
        'Chat completion',
        '/v1/chat/completions',
        totalTokens
      );
    }

    await this.loadBalancer.recordRequestComplete(
      providerExecution.providerId,
      true,
      duration,
      totalTokens,
      undefined,
      providerExecution.subProvider?.id
    );
    
    await this.requestTracker.completeRequest(
      apiRequest.id,
      totalTokens,
      credits,
      duration,
      JSON.stringify(response).length,
      200,
      providerExecution.providerId
    );
  }

  private async validateRequestFormat(request: ChatCompletionRequest, user: AuthenticatedUser): Promise<void> {
    if (!request.model?.trim()) {
      throw new Error('Model required');
    }
    
    if (!this.modelRegistry.exists(request.model)) {
      throw new Error(`Model '${request.model}' does not exist`);
    }
    
    if (!this.modelRegistry.supportsEndpoint(request.model, '/v1/chat/completions')) {
      throw new Error(`Model '${request.model}' does not support chat completions`);
    }

    if (!user.isMasterAdmin && !this.modelRegistry.hasAccess(request.model, user.plan)) {
      // Check if user has an active, non-expired discount for this model
      const discount = await this.discountService.getUserDiscount(user.id, request.model);
      if (!discount || discount <= 1) {
        // No valid discount found - user cannot access this model
        throw new Error(`Your plan does not have access to model '${request.model}'. You can only use models available in your plan or models you have an active discount for.`);
      }
      // User has a valid discount for this model - they can proceed
      this.logger.info('Model access granted via discount', {
        metadata: {
          userId: user.id,
          model: request.model,
          plan: user.plan,
          discountMultiplier: discount
        }
      });
    }
    
    if (!request.messages?.length) {
      throw new Error('Messages required');
    }
    
    this.validateMessages(request.messages);
    this.validateTemperature(request.temperature);
  }

  private validateMessages(messages: any[]): void {
    messages.forEach((msg, i) => {
      if (!msg.role) {
        throw new Error(`Invalid message at index ${i}: missing role`);
      }
      
      // Content can be null/undefined for assistant messages with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
        return; // Valid: assistant with tool_calls can have null/missing content
      }
      
      // Tool messages require tool_call_id and must have content defined
      if (msg.role === 'tool') {
        if (!msg.tool_call_id) {
          throw new Error(`Invalid message at index ${i}: tool message requires tool_call_id`);
        }
        if (!('content' in msg)) {
          throw new Error(`Invalid message at index ${i}: tool message requires content`);
        }
        return;
      }
      
      // For user/system/developer messages, content should be present (not undefined)
      // null is technically allowed by the schema, but typically these should have actual content
      if (msg.content === undefined) {
        throw new Error(`Invalid message at index ${i}: missing content`);
      }
    });
  }

  private validateTemperature(temperature?: number): void {
    if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
      throw new Error('Invalid temperature range');
    }
  }

  private calculateTokenEstimate(request: ChatCompletionRequest): number {
    return request.messages.reduce<number>((total: number, message: any) => {
      return total + this.calculateMessageTokens(message);
    }, 0);
  }

  private calculateMessageTokens(message: any): number {
    if (typeof message.content === 'string') {
      return Math.ceil(message.content.length / ChatService.TOKEN_RATIO);
    }
    
    if (Array.isArray(message.content)) {
      return message.content.reduce((sum: number, part: any) => {
        if (part.type === 'text') {
          return sum + Math.ceil((part.text || '').length / ChatService.TOKEN_RATIO);
        }
        if (part.type === 'image_url') {
          return sum + ChatService.IMAGE_TOKENS;
        }
        return sum;
      }, 0);
    }

    return 0;
  }

  private calculateResponseTokens(response: ChatCompletionResponse): number {
    if (!response.choices || !Array.isArray(response.choices)) {
      return 0;
    }

    return response.choices.reduce<number>((total: number, choice: any) => {
      const content = choice.message?.content;
      if (typeof content === 'string') {
        return total + Math.ceil(content.length / ChatService.TOKEN_RATIO);
      }
      return total;
    }, 0);
  }

  private extractContentText(messages: any[]): string {
    return messages
      .flatMap(msg => this.extractMessageText(msg))
      .join(' ');
  }

  private extractMessageText(message: any): string[] {
    if (typeof message.content === 'string') {
      return [message.content];
    }
    
    if (Array.isArray(message.content)) {
      return message.content
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text || '');
    }
    
    return [];
  }

  private async createApiRequest(
    request: ChatCompletionRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ) {
    return this.requestTracker.createRequest({
      userId: user.isMasterAdmin || user.isAnonymous ? undefined : user.id,
      endpoint: '/v1/chat/completions',
      method: 'POST',
      model: request.model,
      ipAddress: clientInfo.ip,
      userAgent: clientInfo.userAgent,
      requestSize: JSON.stringify(request).length
    });
  }

  private generateRequestId(): string {
    return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private enhanceResponse(
    response: ChatCompletionResponse,
    execution: RequestExecution,
    providerExecution: ProviderExecution
  ): ChatCompletionResponse {
    return {
      ...response,
      id: execution.requestId,
      provider: providerExecution.providerId
    };
  }

  private logRequestInitiation(execution: RequestExecution, request: ChatCompletionRequest): void {
    this.logger.info('Chat request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        streaming: execution.isStreaming,
        messageCount: request.messages.length,
        estimatedTokens: execution.estimatedTokens
      }
    });
  }

  private logRequestFailure(error: Error, execution: RequestExecution): void {
    this.logger.error('Chat request failed', error, {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: execution.model,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private handleProviderAttemptFailure(
    error: Error,
    execution: RequestExecution,
    providerExecution: ProviderExecution | null,
    attempt: number,
    excludedProviders: string[]
  ): void {
    excludedProviders.push(providerExecution?.providerId || 'failed_provider');
    
    this.logger.warn('Provider attempt failed', {
      requestId: execution.requestId,
      metadata: {
        attempt,
        error: error.message,
        model: execution.model,
        excludedCount: excludedProviders.length
      }
    });
  }
}

class StreamProcessor implements AsyncIterable<StreamChunk> {
  private static readonly MAX_ATTEMPTS = 10;

  private attempt = 0;
  private readonly excludedProviders: string[] = [];
  private contentBuffer = '';
  private reasoningBuffer = '';
  private reasoningTokensFromUsage = 0;
  private currentProvider: any = null;
  private isCompleted = false;

  constructor(
    private readonly request: ChatCompletionRequest,
    private readonly execution: RequestExecution,
    private readonly apiRequest: any,
    private readonly registry: ProviderRegistry,
    private readonly balancer: LoadBalancerService,
    private readonly tracker: ApiRequestService,
    private readonly billing: CreditService,
    private readonly models: ModelRegistryService,
    private readonly logger: ILogger,
    private readonly cryptoService: ICryptoService
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    try {
      const stream = await this.establishProviderStream();
      if (!stream) {
        throw new Error('Unable to establish provider stream');
      }

      for await (const chunk of stream) {
        this.processChunk(chunk);
        yield this.enhanceChunk(chunk);
      }

      if (!this.isCompleted) {
        await this.finalizeSuccessfulStream();
      }
    } catch (error) {
      await this.handleStreamFailure(error as Error);
      throw error;
    }
  }

  private async establishProviderStream(): Promise<AsyncIterable<StreamChunk> | null> {
    while (this.attempt < StreamProcessor.MAX_ATTEMPTS) {
      this.attempt++;

      try {
        const provider = await this.acquireStreamProvider();
        if (!provider) continue;

        const response = await provider.provider.chatCompletion({
          ...this.request,
          stream: true
        });

        if (Symbol.asyncIterator in response) {
          this.logStreamEstablished(provider);
          return response;
        }
      } catch (error) {
        await this.handleStreamAttemptFailure(error as Error);
      }
    }

    return null;
  }

  private async acquireStreamProvider() {
    const selection = await this.balancer.select({
      model: this.request.model,
      estimatedTokens: this.execution.estimatedTokens,
      excludeIds: this.excludedProviders,
      requireHealthy: false
    });

    if (!selection) return null;

    const provider = selection.subProvider
      ? this.createSubProviderAdapter(selection)
      : this.registry.getAdapter(selection.provider.name);
    
    if (!provider) return null;

    const reserved = await this.balancer.recordRequestStart(
      selection.subProvider?.id,
      this.execution.estimatedTokens
    );

    if (!reserved) return null;

    this.currentProvider = {
      provider,
      subProvider: selection.subProvider,
      providerId: selection.provider.id
    };

    return this.currentProvider;
  }

  private createSubProviderAdapter(selection: any) {
    const decryptedApiKey = selection.subProvider.getDecryptedApiKey(this.cryptoService);
    return this.registry.createAdapterWithApiKey(
      selection.provider.name,
      decryptedApiKey,
      selection.subProvider
    );
  }

  private async handleStreamAttemptFailure(error: Error): Promise<void> {
    const errorType = getErrorType(error.message);
    const isCritical = isCriticalError(error.message);

    if (this.currentProvider) {
      await this.balancer.recordRequestComplete(
        this.currentProvider.providerId,
        false,
        0,
        0,
        errorType,
        this.currentProvider.subProvider?.id,
        error.message
      );

      this.excludedProviders.push(this.currentProvider.providerId);
      this.currentProvider = null;
    }

    this.logger.warn('Stream establishment failed', {
      requestId: this.execution.requestId,
      metadata: {
        attempt: this.attempt,
        error: error.message,
        errorType,
        isCritical
      }
    });
  }

  private processChunk(chunk: StreamChunk): void {
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) {
      this.contentBuffer += content;
    }

    const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
    if (reasoning && Array.isArray(reasoning)) {
      reasoning.forEach(r => {
        if (r.type === 'thinking' && r.thinking) {
          this.reasoningBuffer += r.thinking;
        }
      });
    }
  }

  private enhanceChunk(chunk: StreamChunk): StreamChunk {
    return {
      ...chunk,
      id: this.execution.requestId,
      provider: this.currentProvider?.providerId
    };
  }

  async finalizeSuccessfulStream(): Promise<void> {
    if (this.isCompleted) return;
    
    this.isCompleted = true;
    
    const duration = Date.now() - this.execution.startTime;
    
    const outputTokens = Math.ceil(this.contentBuffer.length / ChatService.TOKEN_RATIO);
    const reasoningTokens = this.reasoningTokensFromUsage > 0 
      ? this.reasoningTokensFromUsage 
      : Math.ceil(this.reasoningBuffer.length / ChatService.TOKEN_RATIO);
    const totalTokens = this.execution.estimatedTokens + outputTokens + reasoningTokens;
    const credits = this.models.calculateCredits(this.execution.model, totalTokens);

    if (!this.execution.user.isMasterAdmin && !this.execution.user.isAnonymous) {
      await this.billing.deductCredits(
        this.execution.user.id,
        credits,
        'Streaming chat completion',
        '/v1/chat/completions',
        totalTokens
      );
    }

    await this.recordProviderCompletion(duration, totalTokens);
    await this.completeTrackerRequest(totalTokens, credits, duration);

    this.logStreamCompletion(this.execution.estimatedTokens, outputTokens, reasoningTokens, credits, duration);
  }

  private async recordProviderCompletion(duration: number, totalTokens: number): Promise<void> {
    if (this.currentProvider) {
      await this.balancer.recordRequestComplete(
        this.currentProvider.providerId,
        true,
        duration,
        totalTokens,
        undefined,
        this.currentProvider.subProvider?.id
      );
    }
  }

  private async completeTrackerRequest(
    totalTokens: number,
    credits: number,
    duration: number
  ): Promise<void> {
    const success = await this.tracker.completeRequest(
      this.apiRequest.id,
      totalTokens,
      credits,
      duration,
      this.contentBuffer.length,
      200,
      this.currentProvider?.providerId,
      this.currentProvider?.subProvider?.id
    );

    if (!success) {
      throw new Error('Failed to mark streaming chat request as completed');
    }
  }

  private async handleStreamFailure(error: Error): Promise<void> {
    const duration = Date.now() - this.execution.startTime;

    if (this.currentProvider) {
      await this.balancer.recordRequestComplete(
        this.currentProvider.providerId,
        false,
        duration,
        0,
        'stream_failure',
        this.currentProvider.subProvider?.id
      );
    }

    await this.tracker.failRequest(this.apiRequest.id, 500, error.message, duration);

    this.logger.error('Stream failed', error, {
      requestId: this.execution.requestId,
      metadata: {
        userId: this.execution.user.id,
        provider: this.currentProvider?.providerId,
        contentLength: this.contentBuffer.length,
        duration
      }
    });
  }

  private logStreamEstablished(provider: any): void {
    this.logger.info('Provider stream established', {
      requestId: this.execution.requestId,
      metadata: {
        provider: provider.provider.name,
        subProvider: provider.subProvider?.id,
        attempt: this.attempt
      }
    });
  }

  private logStreamCompletion(inputTokens: number, outputTokens: number, reasoningTokens: number, credits: number, duration: number): void {
    this.logger.info('Stream completed successfully', {
      requestId: this.execution.requestId,
      metadata: {
        userId: this.execution.user.id,
        provider: this.currentProvider?.providerId,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        reasoningTokens: reasoningTokens,
        totalTokens: inputTokens + outputTokens + reasoningTokens,
        creditsCharged: credits,
        duration
      }
    });
  }
}