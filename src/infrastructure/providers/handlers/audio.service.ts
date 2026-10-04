import { ProviderRegistry } from '../services';
import { ModelRegistryService, LoadBalancerService } from '../../../domain/provider';
import { ApiRequestService } from '../../../domain/request';
import { CreditService } from '../../../domain/user';
import { DiscountService } from '../../../domain/discount';
import { isCriticalError, getErrorType } from '../../../domain/shared';
import type {
  SpeechRequest,
  AudioTranscriptionRequest,
  TranscriptionResponse,
  AuthenticatedUser
} from '../types';
import type { ILogger } from '../../../core/logging';
import type { ICryptoService } from '../../../core/security';

interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string;
}

interface ProviderSelection {
  readonly provider: { id: string; name: string };
  readonly subProvider?: {
    id: string;
    getDecryptedApiKey(cryptoService: ICryptoService): string;
  };
}

interface AudioExecution {
  readonly requestId: string;
  readonly startTime: number;
  readonly user: AuthenticatedUser;
  readonly model: string;
  readonly endpoint: string;
  providerId?: string;
  subProviderId?: string;
}

export class AudioService {
  private static readonly MAX_RETRIES = 5;
  private static readonly MAX_INPUT_LENGTH = 4096;
  private static readonly MAX_FILE_SIZE = 25 * 1024 * 1024;
  private static readonly TOKEN_RATIO = 4;
  private static readonly SPEECH_CREDIT_RATIO = 10;
  private static readonly MB_IN_BYTES = 1024 * 1024;
  private static readonly KB_IN_BYTES = 1024;
  
  private static readonly SUPPORTED_AUDIO_FORMATS = [
    'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'flac'
  ];

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

  async textToSpeech(
    request: SpeechRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<ArrayBuffer> {
    const execution = this.createSpeechExecution(request, user);
    
    this.logSpeechInitiation(execution, request);

    try {
      await this.validateSpeechRequest(request, user);
      await this.authorizeSpeechRequest(request, execution);
      
      const apiRequest = await this.createSpeechApiRequest(request, user, clientInfo);
      await this.requestTracker.startProcessing(apiRequest.id);

      const result = await this.executeSpeechRequest(request, execution);
      await this.finalizeSpeechRequest(apiRequest, request, result, execution);

      this.logSpeechSuccess(execution, request, result);
      return result;

    } catch (error) {
      this.logSpeechError(execution, request, error as Error);
      throw error;
    }
  }

  async transcribeAudio(
    request: AudioTranscriptionRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ): Promise<TranscriptionResponse> {
    const execution = this.createTranscriptionExecution(request, user);
    
    this.logTranscriptionInitiation(execution, request);

    try {
      await this.validateTranscriptionRequest(request, execution.user);
      await this.authorizeTranscriptionRequest(request, execution);
      
      const apiRequest = await this.createTranscriptionApiRequest(request, user, clientInfo);
      await this.requestTracker.startProcessing(apiRequest.id);

      const result = await this.executeTranscriptionRequest(request, execution);
      await this.finalizeTranscriptionRequest(apiRequest, request, result, execution);

      this.logTranscriptionSuccess(execution, request, result);
      return this.enhanceTranscriptionResponse(result, execution);

    } catch (error) {
      this.logTranscriptionError(execution, request, error as Error);
      throw error;
    }
  }

  private createSpeechExecution(request: SpeechRequest, user: AuthenticatedUser): AudioExecution {
    return {
      requestId: this.generateRequestId('speech'),
      startTime: Date.now(),
      user,
      model: request.model,
      endpoint: '/v1/audio/speech'
    };
  }

  private createTranscriptionExecution(
    request: AudioTranscriptionRequest, 
    user: AuthenticatedUser
  ): AudioExecution {
    return {
      requestId: this.generateRequestId('transcription'),
      startTime: Date.now(),
      user,
      model: request.model,
      endpoint: '/v1/audio/transcriptions'
    };
  }

  private async executeSpeechRequest(
    request: SpeechRequest,
    execution: AudioExecution
  ): Promise<ArrayBuffer> {
    const excludedProviders: string[] = [];
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= AudioService.MAX_RETRIES; attempt++) {
      try {
        const selection = await this.selectProvider(request.model, excludedProviders);
        
        if (!selection) {
          if (attempt < AudioService.MAX_RETRIES) continue;
          throw new Error('No available providers for this request');
        }

        const result = await this.performSpeechRequest(request, selection, execution);
        await this.recordProviderSuccess(selection, execution, this.calculateSpeechTokens(request));

        execution.providerId = selection.provider.id;
        execution.subProviderId = selection.subProvider?.id;
        
        return result;

      } catch (error) {
        lastError = error as Error;
        this.handleProviderAttemptFailure(error as Error, execution, attempt, excludedProviders);
        if (attempt >= AudioService.MAX_RETRIES) break;
      }
    }

    throw lastError || new Error('All speech provider attempts exhausted');
  }

  private async executeTranscriptionRequest(
    request: AudioTranscriptionRequest,
    execution: AudioExecution
  ): Promise<TranscriptionResponse> {
    const excludedProviders: string[] = [];
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= AudioService.MAX_RETRIES; attempt++) {
      try {
        const selection = await this.selectProvider(request.model, excludedProviders);
        
        if (!selection) {
          if (attempt < AudioService.MAX_RETRIES) continue;
          throw new Error('No available providers for this request');
        }

        const result = await this.performTranscriptionRequest(request, selection, execution);
        await this.recordProviderSuccess(
          selection,
          execution,
          this.calculateTranscriptionTokens(result)
        );

        execution.providerId = selection.provider.id;
        execution.subProviderId = selection.subProvider?.id;
        
        return result;

      } catch (error) {
        lastError = error as Error;
        this.handleProviderAttemptFailure(error as Error, execution, attempt, excludedProviders);
        if (attempt >= AudioService.MAX_RETRIES) break;
      }
    }

    throw lastError || new Error('All transcription provider attempts exhausted');
  }

  private async selectProvider(
    model: string,
    excludedProviders: string[]
  ): Promise<ProviderSelection | null> {
    const selection = await this.loadBalancer.select({
      model,
      estimatedTokens: 100,
      excludeIds: excludedProviders,
      requireHealthy: false
    });

    if (!selection) return null;

    const provider = await this.createProviderAdapter(selection);
    if (!provider || !provider.supportsCapability('audio')) {
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

  private async performSpeechRequest(
    request: SpeechRequest,
    selection: ProviderSelection,
    execution: AudioExecution
  ): Promise<ArrayBuffer> {
    const provider = await this.createProviderAdapter(selection);
    if (!provider) {
      throw new Error('Failed to create provider adapter');
    }

    const estimatedTokens = this.calculateSpeechTokens(request);
    await this.loadBalancer.recordRequestStart(selection.subProvider?.id, estimatedTokens);

    try {
      return await provider.textToSpeech(request);
    } catch (error) {
      await this.handleProviderError(error as Error, selection, execution);
      throw error;
    }
  }

  private async performTranscriptionRequest(
    request: AudioTranscriptionRequest,
    selection: ProviderSelection,
    execution: AudioExecution
  ): Promise<TranscriptionResponse> {
    const provider = await this.createProviderAdapter(selection);
    if (!provider) {
      throw new Error('Failed to create provider adapter');
    }

    const estimatedTokens = Math.ceil(request.file.size / AudioService.KB_IN_BYTES);
    await this.loadBalancer.recordRequestStart(selection.subProvider?.id, estimatedTokens);

    try {
      return await provider.audioTranscription(request);
    } catch (error) {
      await this.handleProviderError(error as Error, selection, execution);
      throw error;
    }
  }

  private async handleProviderError(
    error: Error,
    selection: ProviderSelection,
    execution: AudioExecution
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
      this.logger.warn('Critical error detected in audio provider', {
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
    execution: AudioExecution,
    tokens: number
  ): Promise<void> {
    await this.loadBalancer.recordRequestComplete(
      selection.provider.id,
      true,
      Date.now() - execution.startTime,
      tokens,
      undefined,
      selection.subProvider?.id
    );
  }

  private async authorizeSpeechRequest(
    request: SpeechRequest,
    execution: AudioExecution
  ): Promise<void> {
    if (execution.user.isMasterAdmin || execution.user.isAnonymous) return;

    const credits = this.modelRegistry.getBaseCost(request.model);
    const estimatedCredits = Math.max(
      credits, 
      Math.ceil(request.input.length / AudioService.SPEECH_CREDIT_RATIO)
    );

    if (!execution.user.credits || execution.user.credits < estimatedCredits) {
      throw new Error('Insufficient credits for speech synthesis');
    }
  }

  private async authorizeTranscriptionRequest(
    request: AudioTranscriptionRequest,
    execution: AudioExecution
  ): Promise<void> {
    if (execution.user.isMasterAdmin || execution.user.isAnonymous) return;

    const credits = this.modelRegistry.getBaseCost(request.model);
    const fileSizeCredits = Math.ceil(request.file.size / AudioService.MB_IN_BYTES);
    const estimatedCredits = Math.max(credits, fileSizeCredits);

    if (!execution.user.credits || execution.user.credits < estimatedCredits) {
      throw new Error('Insufficient credits for audio transcription');
    }
  }

  private async finalizeSpeechRequest(
    apiRequest: any,
    request: SpeechRequest,
    result: ArrayBuffer,
    execution: AudioExecution
  ): Promise<void> {
    const credits = this.calculateSpeechCredits(request);
    const tokens = this.calculateSpeechTokens(request);
    const duration = Date.now() - execution.startTime;

    if (!execution.user.isMasterAdmin && !execution.user.isAnonymous) {
      await this.billing.deductCredits(
        execution.user.id,
        credits,
        'Text-to-speech',
        execution.endpoint,
        tokens
      );
    }

    await this.requestTracker.completeRequest(
      apiRequest.id,
      tokens,
      credits,
      duration,
      result.byteLength,
      200,
      execution.providerId,
      execution.subProviderId
    );
  }

  private async finalizeTranscriptionRequest(
    apiRequest: any,
    request: AudioTranscriptionRequest,
    result: TranscriptionResponse,
    execution: AudioExecution
  ): Promise<void> {
    const credits = this.calculateTranscriptionCredits(request);
    const tokens = this.calculateTranscriptionTokens(result);
    const duration = Date.now() - execution.startTime;

    if (!execution.user.isMasterAdmin && !execution.user.isAnonymous) {
      await this.billing.deductCredits(
        execution.user.id,
        credits,
        'Audio transcription',
        execution.endpoint,
        tokens
      );
    }

    await this.requestTracker.completeRequest(
      apiRequest.id,
      tokens,
      credits,
      duration,
      JSON.stringify(result).length,
      200,
      execution.providerId,
      execution.subProviderId
    );
  }

  private async validateSpeechRequest(request: SpeechRequest, user: AuthenticatedUser): Promise<void> {
    if (!request.model?.trim()) {
      throw new Error('Model is required');
    }

    if (!this.modelRegistry.exists(request.model)) {
      throw new Error(`Model '${request.model}' does not exist`);
    }

    if (!this.modelRegistry.supportsEndpoint(request.model, '/v1/audio/speech')) {
      throw new Error(`Model '${request.model}' does not support text-to-speech`);
    }

    if (!user.isMasterAdmin && !this.modelRegistry.hasAccess(request.model, user.plan)) {
      // Check if user has an active, non-expired discount for this model
      const discount = await this.discountService.getUserDiscount(user.id, request.model);
      if (!discount || discount <= 1) {
        throw new Error(`Your plan does not have access to model '${request.model}'. You can only use models available in your plan or models you have an active discount for.`);
      }
    }

    if (!request.input?.trim()) {
      throw new Error('Input text is required');
    }

    if (request.input.length > AudioService.MAX_INPUT_LENGTH) {
      throw new Error(`Input text too long (max ${AudioService.MAX_INPUT_LENGTH} characters)`);
    }

    if (!request.voice) {
      throw new Error('Voice is required');
    }
  }

  private async validateTranscriptionRequest(request: AudioTranscriptionRequest, user: AuthenticatedUser): Promise<void> {
    if (!request.model?.trim()) {
      throw new Error('Model is required');
    }

    if (!this.modelRegistry.exists(request.model)) {
      throw new Error(`Model '${request.model}' does not exist`);
    }

    if (!this.modelRegistry.supportsEndpoint(request.model, '/v1/audio/transcriptions')) {
      throw new Error(`Model '${request.model}' does not support audio transcription`);
    }

    if (!user.isMasterAdmin && !this.modelRegistry.hasAccess(request.model, user.plan)) {
      // Check if user has an active, non-expired discount for this model
      const discount = await this.discountService.getUserDiscount(user.id, request.model);
      if (!discount || discount <= 1) {
        throw new Error(`Your plan does not have access to model '${request.model}'. You can only use models available in your plan or models you have an active discount for.`);
      }
    }

    this.validateAudioFile(request.file);
  }

  private validateAudioFile(file: File): void {
    if (!file) {
      throw new Error('Audio file is required');
    }

    if (file.size > AudioService.MAX_FILE_SIZE) {
      throw new Error(
        `Audio file too large (max ${AudioService.MAX_FILE_SIZE / AudioService.MB_IN_BYTES}MB)`
      );
    }

    const fileExtension = file.name.split('.').pop()?.toLowerCase();
    if (!fileExtension || !AudioService.SUPPORTED_AUDIO_FORMATS.includes(fileExtension)) {
      throw new Error(
        `Unsupported audio format. Supported: ${AudioService.SUPPORTED_AUDIO_FORMATS.join(', ')}`
      );
    }
  }

  private calculateSpeechTokens(request: SpeechRequest): number {
    return Math.ceil(request.input.length / AudioService.TOKEN_RATIO);
  }

  private calculateTranscriptionTokens(result: TranscriptionResponse): number {
    return Math.ceil(result.text.length / AudioService.TOKEN_RATIO);
  }

  private calculateSpeechCredits(request: SpeechRequest): number {
    const baseCost = this.modelRegistry.getBaseCost(request.model);
    return Math.max(baseCost, Math.ceil(request.input.length / AudioService.SPEECH_CREDIT_RATIO));
  }

  private calculateTranscriptionCredits(request: AudioTranscriptionRequest): number {
    const baseCost = this.modelRegistry.getBaseCost(request.model);
    const fileSizeCredits = Math.ceil(request.file.size / AudioService.MB_IN_BYTES);
    return Math.max(baseCost, fileSizeCredits);
  }

  private async createSpeechApiRequest(
    request: SpeechRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ) {
    return this.requestTracker.createRequest({
      userId: user.isMasterAdmin || user.isAnonymous ? undefined : user.id,
      endpoint: '/v1/audio/speech',
      method: 'POST',
      model: request.model,
      ipAddress: clientInfo.ip,
      userAgent: clientInfo.userAgent,
      requestSize: JSON.stringify(request).length
    });
  }

  private async createTranscriptionApiRequest(
    request: AudioTranscriptionRequest,
    user: AuthenticatedUser,
    clientInfo: ClientInfo
  ) {
    return this.requestTracker.createRequest({
      userId: user.isMasterAdmin || user.isAnonymous ? undefined : user.id,
      endpoint: '/v1/audio/transcriptions',
      method: 'POST',
      model: request.model,
      ipAddress: clientInfo.ip,
      userAgent: clientInfo.userAgent,
      requestSize: this.calculateTranscriptionRequestSize(request)
    });
  }

  private calculateTranscriptionRequestSize(request: AudioTranscriptionRequest): number {
    const baseSize = JSON.stringify({ ...request, file: null }).length;
    return baseSize + request.file.size;
  }

  private generateRequestId(type: string): string {
    return `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private enhanceTranscriptionResponse(
    response: TranscriptionResponse,
    execution: AudioExecution
  ): TranscriptionResponse {
    return {
      ...response,
      id: execution.requestId,
      provider: execution.providerId || 'transcription_provider'
    };
  }

  private logSpeechInitiation(execution: AudioExecution, request: SpeechRequest): void {
    this.logger.info('Text-to-speech request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        inputLength: request.input.length,
        voice: request.voice
      }
    });
  }

  private logTranscriptionInitiation(
    execution: AudioExecution, 
    request: AudioTranscriptionRequest
  ): void {
    this.logger.info('Audio transcription request initiated', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        fileSize: request.file.size,
        fileName: request.file.name
      }
    });
  }

  private logSpeechSuccess(
    execution: AudioExecution,
    request: SpeechRequest,
    result: ArrayBuffer
  ): void {
    this.logger.info('Text-to-speech completed', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        inputLength: request.input.length,
        outputSize: result.byteLength,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logTranscriptionSuccess(
    execution: AudioExecution,
    request: AudioTranscriptionRequest,
    result: TranscriptionResponse
  ): void {
    this.logger.info('Audio transcription completed', {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        fileSize: request.file.size,
        transcriptionLength: result.text.length,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logSpeechError(
    execution: AudioExecution,
    request: SpeechRequest,
    error: Error
  ): void {
    this.logger.error('Text-to-speech failed', error, {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        inputLength: request.input?.length || 0,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private logTranscriptionError(
    execution: AudioExecution,
    request: AudioTranscriptionRequest,
    error: Error
  ): void {
    this.logger.error('Audio transcription failed', error, {
      requestId: execution.requestId,
      metadata: {
        userId: execution.user.id,
        model: request.model,
        fileSize: request.file?.size || 0,
        duration: Date.now() - execution.startTime
      }
    });
  }

  private handleProviderAttemptFailure(
    error: Error,
    execution: AudioExecution,
    attempt: number,
    excludedProviders: string[]
  ): void {
    excludedProviders.push(execution.providerId || 'failed_provider');
    
    this.logger.warn('Audio provider attempt failed', {
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