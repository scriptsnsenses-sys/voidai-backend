export interface ModelInfo {
  readonly id: string;
  readonly object: 'model';
  readonly ownedBy: string;
  readonly endpoints: ReadonlyArray<string>;
  readonly planRequirements: ReadonlyArray<string>;
  readonly costType: 'per_token' | 'fixed';
  readonly baseCost: number;
  readonly multiplier: number;
  readonly supportsStreaming: boolean;
  readonly supportsToolCalling: boolean;
}

export interface ModelAvailability {
  readonly model: string;
  readonly isAvailable: boolean;
  readonly supportingProviders: ReadonlyArray<string>;
  readonly lowestCost: number;
  readonly recommendedProvider?: string;
}

export interface CostCalculation {
  readonly modelId: string;
  readonly tokensUsed: number;
  readonly credits: number;
  readonly costType: 'per_token' | 'fixed';
  readonly multiplier: number;
  readonly baseCost: number;
}

export interface ModelStats {
  readonly totalModels: number;
  readonly byProvider: Record<string, number>;
  readonly byEndpoint: Record<string, number>;
  readonly byCostType: Record<string, number>;
  readonly streamingSupport: number;
  readonly toolCallingSupport: number;
}

interface ModelConfig {
  readonly id: string;
  readonly ownedBy: string;
  readonly planRequirements: ReadonlyArray<string>;
  readonly multiplier: number;
  readonly endpoints?: ReadonlyArray<string>;
  readonly costType?: 'per_token' | 'fixed';
  readonly baseCost?: number;
  readonly supportsStreaming?: boolean;
  readonly supportsToolCalling?: boolean;
}

export class ModelRegistryService {
  private readonly models = new Map<string, ModelInfo>();
  private initialized = false;

  constructor() {
    this.initialize();
  }

  public getById(id: string): ModelInfo | undefined {
    this.ensureInitialized();
    return this.models.get(id);
  }

  public getAllModels(): ReadonlyArray<ModelInfo> {
    this.ensureInitialized();
    return Array.from(this.models.values());
  }

  public getModelsByEndpoint(endpoint: string): ReadonlyArray<ModelInfo> {
    return this.getAllModels().filter(model => model.endpoints.includes(endpoint));
  }

  public getModelsByProvider(provider: string): ReadonlyArray<ModelInfo> {
    return this.getAllModels().filter(model => model.ownedBy === provider);
  }

  public getModelsByPlan(userPlan: string): ReadonlyArray<ModelInfo> {
    return this.getAllModels();
  }

  public supportsEndpoint(modelId: string, endpoint: string): boolean {
    const model = this.getById(modelId);
    return model?.endpoints.includes(endpoint) ?? false;
  }

  public hasAccess(modelId: string, userPlan: string): boolean {
    return this.exists(modelId);
  }

  public supportsStreaming(modelId: string): boolean {
    const model = this.getById(modelId);
    return model?.supportsStreaming ?? false;
  }

  public supportsToolCalling(modelId: string): boolean {
    const model = this.getById(modelId);
    return model?.supportsToolCalling ?? false;
  }

  public getCostType(modelId: string): 'per_token' | 'fixed' | null {
    const model = this.getById(modelId);
    return model?.costType ?? null;
  }

  public getBaseCost(modelId: string): number {
    const model = this.getById(modelId);
    return model?.baseCost ?? 0;
  }

  public getMultiplier(modelId: string): number {
    const model = this.getById(modelId);
    return model?.multiplier ?? 1.0;
  }

  public calculateCredits(modelId: string, tokensUsed: number, discountMultiplier?: number): number {
    const model = this.getById(modelId);
    if (!model) return 0;

    let credits = model.costType === 'fixed'
      ? model.baseCost
      : tokensUsed * model.multiplier;
    
    if (discountMultiplier && discountMultiplier > 1) {
      credits = credits / discountMultiplier;
    }
    
    return Math.round(credits);
  }

  public calculateCost(modelId: string, tokensUsed: number, discountMultiplier?: number): CostCalculation | null {
    const model = this.getById(modelId);
    if (!model) return null;

    const credits = this.calculateCredits(modelId, tokensUsed, discountMultiplier);

    return {
      modelId,
      tokensUsed,
      credits: Math.round(credits),
      costType: model.costType,
      multiplier: model.multiplier,
      baseCost: model.baseCost
    };
  }

  public exists(modelId: string): boolean {
    this.ensureInitialized();
    return this.models.has(modelId);
  }

  public getModelCount(): number {
    this.ensureInitialized();
    return this.models.size;
  }

  public getModelStats(): ModelStats {
    const allModels = this.getAllModels();
    const statsCalculator = new ModelStatsCalculator(allModels);
    return statsCalculator.calculate();
  }

  private initialize(): void {
    if (this.initialized) return;
    
    const modelLoader = new ModelConfigLoader();
    const modelConfigs = modelLoader.loadAllModels();
    
    modelConfigs.forEach(config => {
      this.models.set(config.id, config);
    });
    
    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }
}

class ModelConfigLoader {
  private static readonly ALL_PLANS = ['free', 'economy', 'basic', 'premium', 'contributor', 'pro', 'ultra', 'enterprise', 'admin'];
  private static readonly ECONOMY_PLUS_PLANS = ['free', 'economy', 'basic', 'premium', 'contributor', 'pro', 'ultra', 'enterprise', 'admin'];
  private static readonly PREMIUM_PLANS = ['premium', 'contributor', 'pro', 'ultra', 'enterprise', 'admin'];
  private static readonly BASIC_PLUS_PLANS = ['basic', 'premium', 'contributor', 'pro', 'ultra', 'enterprise', 'admin'];
  private static readonly ULTRA_PLANS = ['contributor', 'ultra', 'enterprise', 'admin'];

  private static readonly DEFAULT_CHAT_ENDPOINTS = ['/v1/chat/completions', '/v1/responses'];
  private static readonly DEFAULT_IMAGE_ENDPOINTS = ['/v1/images/generations'];

  public loadAllModels(): ModelInfo[] {
    return [
      ...this.loadOpenAIModels(),
      ...this.loadAnthropicModels(),
      ...this.loadGoogleModels(),
      ...this.loadXAIModels(),
      ...this.loadMistralModels(),
      ...this.loadPerplexityModels(),
      ...this.loadMetaModels(),
      ...this.loadDeepSeekModels(),
      ...this.loadQwenModels(),
      ...this.loadMoonshotModels(),
      ...this.loadImageModels(),
      ...this.loadSpecialtyModels()
    ];
  }

  private loadOpenAIModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'gpt-3.5-turbo',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'gpt-4o-mini',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'gpt-4o-mini-search-preview',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'gpt-4o',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.25
      }),
      this.createModel({
        id: 'gpt-4o-search-preview',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.5
      }),
      this.createModel({
        id: 'gpt-4.1-nano',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      }),
      this.createModel({
        id: 'gpt-4.1-mini',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'gpt-4.1',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.75
      }),
      this.createModel({
        id: 'chatgpt-4o-latest',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.25,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'gpt-oss-20b',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      }),
      this.createModel({
        id: 'gpt-oss-120b',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.15
      }),
      this.createModel({
        id: 'gpt-5-nano',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      }),
      this.createModel({
        id: 'gpt-5-mini',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'gpt-5-chat',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.75
      }),
      this.createModel({
        id: 'gpt-5',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.75
      }),
      this.createModel({
        id: 'gpt-5.1',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.75
      }),
      this.createModel({
        id: 'gpt-5-codex',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.75
      }),
      this.createModel({
        id: 'gpt-5.1-codex',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.75
      }),
      this.createModel({
        id: 'gpt-5.1-codex-mini',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'o1',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.PREMIUM_PLANS,
        multiplier: 5,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'o3-mini',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'o3',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.BASIC_PLUS_PLANS,
        multiplier: 0.5,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'o4-mini',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'gpt-image-1',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ECONOMY_PLUS_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/images/generations', '/v1/images/edits'],
        costType: 'fixed',
        baseCost: 2000,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'text-embedding-3-small',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/embeddings'],
        costType: 'fixed',
        baseCost: 50,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'text-embedding-3-large',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/embeddings'],
        costType: 'fixed',
        baseCost: 50,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'tts-1',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/audio/speech'],
        costType: 'fixed',
        baseCost: 75,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'tts-1-hd',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/audio/speech'],
        costType: 'fixed',
        baseCost: 150,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'gpt-4o-mini-tts',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/audio/speech'],
        costType: 'fixed',
        baseCost: 250,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'whisper-1',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/audio/transcriptions', '/v1/audio/translations'],
        costType: 'fixed',
        baseCost: 10,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'gpt-4o-mini-transcribe',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/audio/transcriptions'],
        costType: 'fixed',
        baseCost: 20,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'gpt-4o-transcribe',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/audio/transcriptions'],
        costType: 'fixed',
        baseCost: 50,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'omni-moderation-latest',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/moderations'],
        costType: 'fixed',
        baseCost: 0,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'sora-2',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.BASIC_PLUS_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/videos'],
        costType: 'fixed',
        baseCost: 5000,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'sora-2-pro',
        ownedBy: 'openai',
        planRequirements: ModelConfigLoader.PREMIUM_PLANS,
        multiplier: 1.0,
        endpoints: ['/v1/videos'],
        costType: 'fixed',
        baseCost: 15000,
        supportsStreaming: false,
        supportsToolCalling: false
      })
    ];
  }

  private loadAnthropicModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'claude-3-5-sonnet-20240620',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.BASIC_PLUS_PLANS,
        multiplier: 1.75
      }),
      this.createModel({
        id: 'claude-3-5-haiku-20241022',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1
      }),
      this.createModel({
        id: 'claude-3-5-sonnet-20241022',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.BASIC_PLUS_PLANS,
        multiplier: 1.75
      }),
      this.createModel({
        id: 'claude-3-7-sonnet-20250219',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.BASIC_PLUS_PLANS,
        multiplier: 1.75
      }),
      this.createModel({
        id: 'claude-sonnet-4-20250514',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.BASIC_PLUS_PLANS,
        multiplier: 1.75
      }),
      this.createModel({
        id: 'claude-opus-4-20250514',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.PREMIUM_PLANS,
        multiplier: 6.5
      }),
      this.createModel({
        id: 'claude-opus-4-1-20250805',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.PREMIUM_PLANS,
        multiplier: 6.5
      }),
      this.createModel({
        id: 'claude-opus-4-5-20251101',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.BASIC_PLUS_PLANS,
        multiplier: 4
      }),
      this.createModel({
        id: 'claude-sonnet-4-5-20250929',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.BASIC_PLUS_PLANS,
        multiplier: 1.75
      }),
      this.createModel({
        id: 'claude-haiku-4-5-20251001',
        ownedBy: 'anthropic',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1
      })
    ];
  }

  private loadGoogleModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'gemini-1.5-flash',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.75
      }),
      this.createModel({
        id: 'gemini-1.5-pro',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.5
      }),
      this.createModel({
        id: 'gemini-2.0-flash',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.5
      }),
      this.createModel({
        id: 'gemini-2.5-flash-lite-preview-06-17',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'gemini-2.5-flash',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.5
      }),
      this.createModel({
        id: 'gemini-2.5-flash-image',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.5
      }),
      this.createModel({
        id: 'gemini-2.5-pro',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1
      }),
      this.createModel({
        id: 'gemini-3-pro-preview',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.25
      }),
      this.createModel({
        id: 'gemini-3-pro-image-preview',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.25
      }),
      this.createModel({
        id: 'gemma-3n-e4b-it',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      }),
      this.createModel({
        id: 'imagen-3.0-generate-002',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.BASIC_PLUS_PLANS,
        multiplier: 1.0,
        endpoints: ModelConfigLoader.DEFAULT_IMAGE_ENDPOINTS,
        costType: 'fixed',
        baseCost: 2500,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'imagen-4.0-generate-preview-06-06',
        ownedBy: 'google',
        planRequirements: ModelConfigLoader.PREMIUM_PLANS,
        multiplier: 1.0,
        endpoints: ModelConfigLoader.DEFAULT_IMAGE_ENDPOINTS,
        costType: 'fixed',
        baseCost: 3500,
        supportsStreaming: false,
        supportsToolCalling: false
      })
    ];
  }

  private loadXAIModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'grok-4',
        ownedBy: 'x-ai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1.75
      })
    ];
  }

  private loadMistralModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'magistral-medium-latest',
        ownedBy: 'mistral',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'magistral-small-latest',
        ownedBy: 'mistral',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'mistral-large-latest',
        ownedBy: 'mistral',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'mistral-medium-latest',
        ownedBy: 'mistral',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'mistral-small-latest',
        ownedBy: 'mistral',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'ministral-3b-latest',
        ownedBy: 'mistral',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'ministral-8b-latest',
        ownedBy: 'mistral',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'mistral-moderation-latest',
        ownedBy: 'mistral',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 1,
        endpoints: ['/v1/moderations'],
        costType: 'fixed',
        baseCost: 0,
        supportsStreaming: false,
        supportsToolCalling: false
      })
    ];
  }

  private loadPerplexityModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'sonar',
        ownedBy: 'perplexity',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      }),
      this.createModel({
        id: 'sonar-pro',
        ownedBy: 'perplexity',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'sonar-reasoning',
        ownedBy: 'perplexity',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'sonar-reasoning-pro',
        ownedBy: 'perplexity',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.5
      }),
      this.createModel({
        id: 'sonar-deep-research',
        ownedBy: 'perplexity',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.5
      }),
      this.createModel({
        id: 'r1-1776',
        ownedBy: 'perplexity',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.5
      })
    ];
  }

  private loadMetaModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'llama-4-scout-17b-16e-instruct',
        ownedBy: 'meta',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      }),
      this.createModel({
        id: 'llama-4-maverick-17b-128e-instruct',
        ownedBy: 'meta',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      })
    ];
  }

  private loadDeepSeekModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'deepseek-v3',
        ownedBy: 'deepseek',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      }),
      this.createModel({
        id: 'deepseek-v3.1',
        ownedBy: 'deepseek',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.25
      }),
      this.createModel({
        id: 'deepseek-v3.1-terminus',
        ownedBy: 'deepseek',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.2
      }),
      this.createModel({
        id: 'deepseek-r1',
        ownedBy: 'deepseek',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.35
      })
    ];
  }

  private loadQwenModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'qwq-32b',
        ownedBy: 'qwen',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      }),
      this.createModel({
        id: 'qwen3-235b-a22b-instruct',
        ownedBy: 'qwen',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      }),
      this.createModel({
        id: 'qwen3-coder-480b-a35b-instruct',
        ownedBy: 'qwen',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      })
    ];
  }

  private loadMoonshotModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'kimi-k2-instruct',
        ownedBy: 'moonshot',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.1
      })
    ];
  }

  private loadImageModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'flux-kontext-pro',
        ownedBy: 'black-forest-labs',
        planRequirements: ModelConfigLoader.PREMIUM_PLANS,
        multiplier: 1.0,
        endpoints: ModelConfigLoader.DEFAULT_IMAGE_ENDPOINTS,
        costType: 'fixed',
        baseCost: 3000,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'flux-kontext-max',
        ownedBy: 'black-forest-labs',
        planRequirements: ModelConfigLoader.PREMIUM_PLANS,
        multiplier: 1.0,
        endpoints: ModelConfigLoader.DEFAULT_IMAGE_ENDPOINTS,
        costType: 'fixed',
        baseCost: 3000,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'midjourney',
        ownedBy: 'midjourney',
        planRequirements: ModelConfigLoader.ULTRA_PLANS,
        multiplier: 1.0,
        endpoints: ModelConfigLoader.DEFAULT_IMAGE_ENDPOINTS,
        costType: 'fixed',
        baseCost: 75000,
        supportsStreaming: false,
        supportsToolCalling: false
      }),
      this.createModel({
        id: 'recraft-v3',
        ownedBy: 'recraft',
        planRequirements: ModelConfigLoader.PREMIUM_PLANS,
        multiplier: 1.0,
        endpoints: ModelConfigLoader.DEFAULT_IMAGE_ENDPOINTS,
        costType: 'fixed',
        baseCost: 1000,
        supportsStreaming: false,
        supportsToolCalling: false
      })
    ];
  }

  private loadSpecialtyModels(): ModelInfo[] {
    return [
      this.createModel({
        id: 'lumina',
        ownedBy: 'voidai',
        planRequirements: ModelConfigLoader.ALL_PLANS,
        multiplier: 0.3
      })
    ];
  }

  private createModel(config: ModelConfig): ModelInfo {
    return {
      id: config.id,
      object: 'model',
      ownedBy: config.ownedBy,
      endpoints: config.endpoints ?? ModelConfigLoader.DEFAULT_CHAT_ENDPOINTS,
      planRequirements: [],
      costType: config.costType ?? 'per_token',
      baseCost: 0,
      multiplier: 0,
      supportsStreaming: config.supportsStreaming ?? true,
      supportsToolCalling: config.supportsToolCalling ?? true
    };
  }
}

class ModelStatsCalculator {
  constructor(private readonly models: ReadonlyArray<ModelInfo>) {}

  public calculate(): ModelStats {
    const byProvider: Record<string, number> = {};
    const byEndpoint: Record<string, number> = {};
    const byCostType: Record<string, number> = {};
    
    let streamingSupport = 0;
    let toolCallingSupport = 0;

    for (const model of this.models) {
      byProvider[model.ownedBy] = (byProvider[model.ownedBy] || 0) + 1;
      byCostType[model.costType] = (byCostType[model.costType] || 0) + 1;
      
      for (const endpoint of model.endpoints) {
        byEndpoint[endpoint] = (byEndpoint[endpoint] || 0) + 1;
      }
      
      if (model.supportsStreaming) streamingSupport++;
      if (model.supportsToolCalling) toolCallingSupport++;
    }

    return {
      totalModels: this.models.length,
      byProvider,
      byEndpoint,
      byCostType,
      streamingSupport,
      toolCallingSupport
    };
  }
}