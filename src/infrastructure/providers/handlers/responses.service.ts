import { ProviderRegistry } from '../services';
import { LoadBalancerService, ModelRegistryService } from '../../../domain/provider';
import { ApiRequestService } from '../../../domain/request';
import { CreditService, SecurityService, AuthService } from '../../../domain/user';
import { DiscountService } from '../../../domain/discount';
import { isCriticalError, getErrorType } from '../../../domain/shared';
import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponseStreamEvent,
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

export class ResponsesService {
  private static readonly MAX_RETRIES = 10;
  private static readonly TOKEN_RATIO = 4;
  private static readonly MAX_TEMPERATURE = 2;
  private static readonly MIN_TEMPERATURE = 0;

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
  ) {
    this.logger.debug('ResponsesService created', {
      metadata: {
        registryAdapters: this.providerRegistry.getAllAdapterNames().length
      }
    });
  }

  async createResponse(
    request: ResponsesRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<ResponsesResponse | AsyncIterable<ResponseStreamEvent>> {
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

  private createExecution(request: ResponsesRequest, user: AuthenticatedUser): RequestExecution {
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
    request: ResponsesRequest,
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
    request: ResponsesRequest,
    execution: RequestExecution,
    clientInfo: ClientInfo
  ): Promise<void> {
    const content = this.extractContentText(request);
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
      endpoint: '/v1/responses',
      model: execution.model,
      estimatedCredits: requiredCredits
    };

    const authResult = await this.authorization.authorizeRequest(authContext);
    if (!authResult.isAuthorized) {
      throw new Error(authResult.reason || 'Authorization failed');
    }
  }

  private async handleSynchronousExecution(
    request: ResponsesRequest,
    execution: RequestExecution,
    apiRequest: any
  ): Promise<ResponsesResponse> {
    const excludedProviders: string[] = [];
    let lastError: Error | null = null;
    let providerExecution: ProviderExecution | null = null;

    for (let attempt = 1; attempt <= ResponsesService.MAX_RETRIES; attempt++) {
      try {
        providerExecution = await this.acquireProvider(
          request.model, 
          execution.estimatedTokens, 
          excludedProviders
        );

        if (!providerExecution) {
          if (attempt < ResponsesService.MAX_RETRIES) continue;
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
        if (attempt >= ResponsesService.MAX_RETRIES) break;
      }
    }

    throw lastError || new Error('All provider attempts exhausted');
  }

  private async executeProviderRequest(
    request: ResponsesRequest,
    providerExecution: ProviderExecution
  ): Promise<ResponsesResponse> {
    try {
      const response = await providerExecution.provider.createResponse(request);
      
      if (Symbol.asyncIterator in response) {
        throw new Error('Unexpected streaming response in sync mode');
      }

      return response as ResponsesResponse;
    } catch (error) {
      await this.handleProviderError(error as Error, providerExecution);
      throw error;
    }
  }

  private async handleProviderError(
    error: Error,
    providerExecution: ProviderExecution
  ): Promise<void> {
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
    request: ResponsesRequest,
    execution: RequestExecution,
    apiRequest: any
  ): ResponsesStreamProcessor {
    return new ResponsesStreamProcessor(
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

    if (!selection) {
      this.logger.debug('Load balancer returned no selection');
      return null;
    }

    this.logger.debug('Load balancer selected provider', {
      metadata: {
        providerId: selection.provider.id,
        providerName: selection.provider.name,
        hasSubProvider: !!selection.subProvider,
        reason: selection.selectedReason
      }
    });

    const provider = selection.subProvider
      ? this.createSubProviderAdapter(selection)
      : this.providerRegistry.getAdapter(selection.provider.name);

    if (!provider) {
      this.logger.warn('Failed to get provider adapter from registry', {
        metadata: {
          providerName: selection.provider.name,
          hasSubProvider: !!selection.subProvider,
          registryAdapters: this.providerRegistry.getAllAdapterNames()
        }
      });
      return null;
    }

    const reserved = await this.loadBalancer.recordRequestStart(
      selection.subProvider?.id,
      estimatedTokens
    );

    if (!reserved) {
      this.logger.debug('Failed to reserve capacity');
      return null;
    }

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

  private calculateReasoningTokens(response: ResponsesResponse): number {
    if (response.usage?.output_tokens_details?.reasoning_tokens) {
      return response.usage.output_tokens_details.reasoning_tokens;
    }

    if (!response.reasoning?.content || !Array.isArray(response.reasoning.content)) {
      return 0;
    }

    return response.reasoning.content.reduce((total, reasoning) => {
      if (reasoning.type === 'thinking' && reasoning.thinking) {
        return total + Math.ceil(reasoning.thinking.length / ResponsesService.TOKEN_RATIO);
      }
      return total;
    }, 0);
  }

  private async completeSynchronousRequest(
    apiRequest: any,
    response: ResponsesResponse,
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
        'Responses completion',
        '/v1/responses',
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

  private async validateRequestFormat(request: ResponsesRequest, user: AuthenticatedUser): Promise<void> {
    if (!request.model?.trim()) {
      throw new Error('Model required');
    }

    if (!this.modelRegistry.exists(request.model)) {
      throw new Error(`Model '${request.model}' does not exist`);
    }

    if (!this.modelRegistry.supportsEndpoint(request.model, '/v1/responses')) {
      throw new Error(`Model '${request.model}' does not support responses`);
    }

    if (!user.isMasterAdmin && !this.modelRegistry.hasAccess(request.model, user.plan)) {
      // Check if user has an active, non-expired discount for this model
      const discount = await this.discountService.getUserDiscount(user.id, request.model);
      if (!discount || discount <= 1) {
        throw new Error(`Your plan does not have access to model '${request.model}'. You can only use models available in your plan or models you have an active discount for.`);
      }
    }

    if (!request.input) {
      throw new Error('Input required');
    }

    this.validateTemperature(request.temperature);
  }

  private validateTemperature(temperature?: number): void {
    if (temperature !== undefined && 
        (temperature < ResponsesService.MIN_TEMPERATURE || temperature > ResponsesService.MAX_TEMPERATURE)) {
      throw new Error('Invalid temperature range');
    }
  }

  private calculateTokenEstimate(request: ResponsesRequest): number {
    let tokens = 0;
    
    if (typeof request.input === 'string') {
      tokens += Math.ceil(request.input.length / ResponsesService.TOKEN_RATIO);
    }
    
    if (request.instructions) {
      tokens += Math.ceil(request.instructions.length / ResponsesService.TOKEN_RATIO);
    }
    
    return tokens * this.modelRegistry.getMultiplier(request.model);
  }

  private calculateResponseTokens(response: ResponsesResponse): number {
    if (!response.output || !Array.isArray(response.output)) {
      return 0;
    }

    return response.output.reduce((total, output) => {
      if (!output.content || !Array.isArray(output.content)) {
        return total;
      }

      return total + output.content.reduce((contentTotal: number, content: any) => {
        if (content.type === 'output_text' && content.text) {
          return contentTotal + Math.ceil(content.text.length / ResponsesService.TOKEN_RATIO);
        }
        return contentTotal;
      }, 0);
    }, 0);
  }

  private extractContentText(request: ResponsesRequest): string {
    const parts = [];
    
    if (request.instructions) {
      parts.push(request.instructions);
    }
    
    if (typeof request.input === 'string') {
      parts.push(request.input);
    }
    
    return parts.join(' ');
  }

  private async createApiRequest(
    request: ResponsesRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ) {
    return this.requestTracker.createRequest({
      userId: user.isMasterAdmin || user.isAnonymous ? undefined : user.id,
      endpoint: '/v1/responses',
      method: 'POST',
      model: request.model,
      ipAddress: clientInfo.ip,
      userAgent: clientInfo.userAgent,
      requestSize: JSON.stringify(request).length
    });
  }

  private generateRequestId(): string {
    return `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private enhanceResponse(
    response: ResponsesResponse,
    execution: RequestExecution,
    providerExecution: ProviderExecution
  ): ResponsesResponse {
    return {
      ...response,
      id: execution.requestId,
      provider: providerExecution.providerId,
      output: response.output?.map(output => ({
        ...output,
        id: `msg_${execution.requestId}`
      }))
    };
  }

  private logRequestInitiation(execution: RequestExecution, request: ResponsesRequest): void {
    this.logger.info('Responses request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        streaming: execution.isStreaming,
        estimatedTokens: execution.estimatedTokens
      }
    });
  }

  private logRequestFailure(error: Error, execution: RequestExecution): void {
    this.logger.error('Responses request failed', error, {
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

class ResponsesStreamProcessor implements AsyncIterable<ResponseStreamEvent> {
  private static readonly MAX_ATTEMPTS = 10;
  private static readonly TOKEN_RATIO = 4;

  private attempt = 0;
  private readonly excludedProviders: string[] = [];
  private contentBuffer = '';
  private reasoningBuffer = '';
  private reasoningTokensFromUsage = 0;
  private currentProvider: any = null;
  private sequenceNumber = 0;
  private isCompleted = false;

  constructor(
    private readonly request: ResponsesRequest,
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

  async *[Symbol.asyncIterator](): AsyncIterator<ResponseStreamEvent> {
    try {
      this.logStreamInitiation();
      
      const stream = await this.establishProviderStream();
      if (!stream) {
        this.logStreamEstablishmentFailure();
        throw new Error('Unable to establish provider stream');
      }

      this.logStreamEstablished();
      
      let eventCount = 0;
      for await (const event of stream) {
        eventCount++;
        this.sequenceNumber++;
        
        this.logEventProcessing(eventCount, event);
        this.processEvent(event);
        yield this.enhanceEvent(event);
      }

      this.logStreamCompletion(eventCount);
      yield this.createCompletionEvent();

      if (!this.isCompleted) {
        await this.finalizeSuccessfulStream();
      }

    } catch (error) {
      this.logStreamFailure(error as Error);
      await this.handleStreamFailure(error as Error);
      throw error;
    }
  }

  private async establishProviderStream(): Promise<AsyncIterable<ResponseStreamEvent> | null> {
    while (this.attempt < ResponsesStreamProcessor.MAX_ATTEMPTS) {
      this.attempt++;

      try {
        const provider = await this.acquireStreamProvider();
        if (!provider) continue;

        const response = await provider.provider.createResponse({
          ...this.request,
          stream: true
        });

        if (Symbol.asyncIterator in response) {
          this.logProviderStreamEstablished(provider);
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

  private processEvent(event: ResponseStreamEvent): void {
    if (event.type === 'response.output_text.delta' && event.delta) {
      this.contentBuffer += event.delta;
    }

    if (event.reasoning?.content && Array.isArray(event.reasoning.content)) {
      event.reasoning.content.forEach(reasoning => {
        if (reasoning.type === 'thinking' && reasoning.thinking) {
          this.reasoningBuffer += reasoning.thinking;
        }
      });
    }
  }

  private enhanceEvent(event: ResponseStreamEvent): ResponseStreamEvent {
    return {
      ...event,
      id: this.execution.requestId,
      provider: this.currentProvider?.providerId,
      response: {
        ...event.response,
        id: `res_${this.execution.requestId}`,
        output: event.response?.output?.map(output => ({
          ...output,
          id: `msg_${this.execution.requestId}`
        }))
      },
      item_id: `item_${this.execution.requestId}`,
      sequence_number: this.sequenceNumber
    } as ResponseStreamEvent & { provider: string; sequence_number: number };
  }

  private createCompletionEvent(): ResponseStreamEvent {
    const actualTokens = Math.ceil(this.contentBuffer.length / ResponsesStreamProcessor.TOKEN_RATIO);
    const reasoningTokens = this.reasoningTokensFromUsage > 0 
      ? this.reasoningTokensFromUsage 
      : Math.ceil(this.reasoningBuffer.length / ResponsesStreamProcessor.TOKEN_RATIO);
    const estimatedInputTokens = this.execution.estimatedTokens;

    return {
      type: 'response.completed',
      id: this.execution.requestId,
      provider: this.currentProvider?.providerId,
      item_id: `item_${this.execution.requestId}`,
      sequence_number: ++this.sequenceNumber,
      response: {
        id: `res_${this.execution.requestId}`,
        object: 'response',
        created_at: Math.floor(this.execution.startTime / 1000),
        status: 'completed',
        instructions: this.request.instructions || null,
        max_output_tokens: this.request.max_output_tokens || null,
        model: this.request.model,
        output: [
          {
            id: `msg_${this.execution.requestId}`,
            type: 'message',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                annotations: [],
                text: this.contentBuffer
              }
            ],
            role: 'assistant'
          }
        ],
        parallel_tool_calls: this.request.parallel_tool_calls || false,
        reasoning: this.request.reasoning || { effort: null },
        temperature: this.request.temperature || 1.0,
        text: this.request.text || { format: { type: 'text' } },
        tool_choice: this.request.tool_choice || 'auto',
        tools: this.request.tools || [],
        usage: {
          input_tokens: estimatedInputTokens,
          output_tokens: actualTokens,
          total_tokens: estimatedInputTokens + actualTokens + reasoningTokens,
          output_tokens_details: reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : undefined
        },
        provider: this.currentProvider?.providerId
      }
    } as ResponseStreamEvent;
  }

  async finalizeSuccessfulStream(): Promise<void> {
    if (this.isCompleted) return;
    
    this.isCompleted = true;
    
    const duration = Date.now() - this.execution.startTime;
    const outputTokens = Math.ceil(this.contentBuffer.length / ResponsesStreamProcessor.TOKEN_RATIO);
    const reasoningTokens = this.reasoningTokensFromUsage > 0 
      ? this.reasoningTokensFromUsage 
      : Math.ceil(this.reasoningBuffer.length / ResponsesStreamProcessor.TOKEN_RATIO);
    const totalTokens = this.execution.estimatedTokens + outputTokens + reasoningTokens;
    const credits = this.models.calculateCredits(this.execution.model, totalTokens);

    if (!this.execution.user.isMasterAdmin && !this.execution.user.isAnonymous) {
      await this.billing.deductCredits(
        this.execution.user.id,
        credits,
        'Streaming responses completion',
        '/v1/responses',
        totalTokens
      );
    }

    await this.recordProviderCompletion(duration, totalTokens);
    await this.completeTrackerRequest(totalTokens, credits, duration);

    this.logSuccessfulCompletion(outputTokens, reasoningTokens, credits, duration);
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
      throw new Error('Failed to mark streaming request as completed');
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
  }

  private logStreamInitiation(): void {
    this.logger.info('Starting response stream processing', {
      requestId: this.execution.requestId,
      metadata: {
        model: this.request.model,
        userId: this.execution.user.id
      }
    });
  }

  private logStreamEstablishmentFailure(): void {
    this.logger.error('Failed to establish provider stream', undefined, {
      requestId: this.execution.requestId,
      metadata: {
        attempts: this.attempt,
        excludedProviders: this.excludedProviders.length
      }
    });
  }

  private logStreamEstablished(): void {
    this.logger.info('Provider stream established, starting iteration', {
      requestId: this.execution.requestId
    });
  }

  private logEventProcessing(eventCount: number, event: ResponseStreamEvent): void {
    this.logger.debug('Processing stream event', {
      requestId: this.execution.requestId,
      metadata: {
        eventNumber: eventCount,
        eventType: event?.type,
        hasData: Boolean(event)
      }
    });
  }

  private logStreamCompletion(eventCount: number): void {
    this.logger.info('Stream completed successfully', {
      requestId: this.execution.requestId,
      metadata: {
        totalEvents: eventCount,
        contentLength: this.contentBuffer.length
      }
    });
  }

  private logStreamFailure(error: Error): void {
    this.logger.error('Stream processing failed', error, {
      requestId: this.execution.requestId,
      metadata: {
        contentBufferLength: this.contentBuffer.length,
        currentProvider: this.currentProvider?.provider?.name
      }
    });
  }

  private logProviderStreamEstablished(provider: any): void {
    this.logger.info('Provider stream established', {
      requestId: this.execution.requestId,
      metadata: {
        provider: provider.provider.name,
        subProvider: provider.subProvider?.id,
        attempt: this.attempt
      }
    });
  }

  private logSuccessfulCompletion(outputTokens: number, reasoningTokens: number, credits: number, duration: number): void {
    this.logger.info('Stream completed successfully', {
      requestId: this.execution.requestId,
      metadata: {
        userId: this.execution.user.id,
        provider: this.currentProvider?.providerId,
        inputTokens: this.execution.estimatedTokens,
        outputTokens: outputTokens,
        reasoningTokens: reasoningTokens,
        totalTokens: this.execution.estimatedTokens + outputTokens + reasoningTokens,
        creditsCharged: credits,
        duration
      }
    });
  }
}